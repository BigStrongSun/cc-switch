#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const SENSITIVE_HEADER_RE =
  /authorization|cookie|token|secret|api[-_]?key|bearer|account[-_]?id|chatgpt[-_]?account/i;
const DEFAULT_OUTPUT_DIR = "scripts/logs/codex-request-shape-compare";

// 解析命令行参数；保持无依赖，便于在用户机器和 CI 中直接运行。
function parseArgs(argv) {
  const args = {
    native: "",
    proxy: "",
    out: DEFAULT_OUTPUT_DIR,
    serve: false,
    serveSelfTest: false,
    selfTest: false,
    nativeCommand: "",
    proxyCommand: "",
    timeoutMs: 120000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--native") args.native = argv[++index] ?? "";
    else if (arg === "--proxy") args.proxy = argv[++index] ?? "";
    else if (arg === "--out") args.out = argv[++index] ?? DEFAULT_OUTPUT_DIR;
    else if (arg === "--serve") args.serve = true;
    else if (arg === "--serve-self-test") args.serveSelfTest = true;
    else if (arg === "--self-test") args.selfTest = true;
    else if (arg === "--native-command")
      args.nativeCommand = argv[++index] ?? "";
    else if (arg === "--proxy-command") args.proxyCommand = argv[++index] ?? "";
    else if (arg === "--timeout-ms")
      args.timeoutMs = Number(argv[++index] ?? args.timeoutMs);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

// 输出脚本用法，特别说明如何让外部 harness 命中本地 mock。
function printHelp() {
  console.log(`Usage:
  node scripts/codex-request-shape-compare.mjs --self-test
  node scripts/codex-request-shape-compare.mjs --serve-self-test
  node scripts/codex-request-shape-compare.mjs --native native.json --proxy proxy.json --out scripts/logs/diff
  node scripts/codex-request-shape-compare.mjs --serve --native-command "..." --proxy-command "..."

Mock mode environment passed to commands:
  CODEX_COMPARE_BASE_URL=http://127.0.0.1:<port>
  CODEX_COMPARE_NATIVE_BASE_URL=http://127.0.0.1:<port>/backend-api/codex
  CODEX_COMPARE_PROXY_BASE_URL=http://127.0.0.1:<port>/v1

Requests can set header x-codex-compare-side: native|proxy or query ?side=native|proxy.
Without a side marker, the first captured request is native and the second is proxy.`);
}

// 读取 JSON 文件并返回对象，错误中带上路径便于排查。
async function readJson(path) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse JSON ${path}: ${error.message}`);
  }
}

// 对敏感 header 只保留长度和短哈希，避免诊断报告泄露 token。
function sanitizeHeaderValue(name, value) {
  const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
  if (!SENSITIVE_HEADER_RE.test(name) && !/^bearer\s+/i.test(text)) {
    return text;
  }
  return {
    present: text.length > 0,
    length: text.length,
    sha256_prefix: createHash("sha256").update(text).digest("hex").slice(0, 12),
  };
}

// 将请求转换成只含 shape 的结构，正文文本会被折叠为类型/长度/哈希。
function normalizeRequestShape(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name.toLowerCase()] = sanitizeHeaderValue(name, value);
  }
  return {
    method: request.method ?? "POST",
    path: request.path ?? request.url ?? "",
    headers,
    body: normalizeValue(request.body ?? {}),
  };
}

// 递归归一化 JSON 值；保留对 capacity 相关字段有意义的结构和短标识。
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = normalizeValue(value[key]);
    }
    return output;
  }
  if (typeof value === "string") {
    return {
      type: "string",
      length: value.length,
      sha256_prefix: createHash("sha256")
        .update(value)
        .digest("hex")
        .slice(0, 12),
      value: shouldKeepLiteral(value) ? value : undefined,
    };
  }
  return value;
}

// 只有短枚举值原样保留，避免 prompt 或 token 明文进入 diff。
function shouldKeepLiteral(value) {
  return value.length <= 80 && /^[A-Za-z0-9._:/@+-]+$/.test(value);
}

// 比较两棵归一化后的对象树，输出字段级差异。
function diffObjects(left, right, path = "$") {
  const diffs = [];
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return diffs;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    diffs.push({ path, native: left, proxy: right });
    return diffs;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) {
    if (!(key in left)) {
      diffs.push({
        path: `${path}.${key}`,
        native: "<absent>",
        proxy: right[key],
      });
    } else if (!(key in right)) {
      diffs.push({
        path: `${path}.${key}`,
        native: left[key],
        proxy: "<absent>",
      });
    } else {
      diffs.push(...diffObjects(left[key], right[key], `${path}.${key}`));
    }
  }
  return diffs;
}

// 判断是否是普通对象；数组和值类型在 diff 中作为整体比较。
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 启动本地 mock server，覆盖 Codex native 与 proxy 关注的两个 endpoint。
async function startMockServer(captures) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = { raw_body_parse_error: true, raw_body_length: rawBody.length };
      }
    }
    const side =
      url.searchParams.get("side") ||
      req.headers["x-codex-compare-side"] ||
      (captures.length === 0 ? "native" : "proxy");
    captures.push({
      side,
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body,
    });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.end(
      'data: {"type":"response.completed","response":{"id":"mock-response"}}\n\n',
    );
  });
  await new Promise((resolveServer) =>
    server.listen(0, "127.0.0.1", resolveServer),
  );
  const address = server.address();
  return { server, port: address.port };
}

// 执行外部命令；外部 harness 负责把 base_url 指向本地 mock。
async function runCommand(command, env, timeoutMs) {
  if (!command) return;
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => {
      child.kill();
      rejectCommand(
        new Error(`Command timed out after ${timeoutMs}ms: ${command}`),
      );
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveCommand();
      else
        rejectCommand(
          new Error(`Command failed with exit code ${code}: ${command}`),
        );
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectCommand(error);
    });
  });
}

// 向 mock server 主动发送两条样例请求，用于验证捕获链路而不依赖 shell 引号。
async function runServeSelfTestRequests(env) {
  await fetch(`${env.CODEX_COMPARE_NATIVE_BASE_URL}/responses?side=native`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer native-token",
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      store: false,
      prompt_cache_key: "thread-a",
    }),
  });
  await fetch(`${env.CODEX_COMPARE_PROXY_BASE_URL}/responses?side=proxy`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer proxy-token",
      originator: "cc-switch",
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      store: false,
      prompt_cache_key: "thread-a",
      service_tier: "priority",
    }),
  });
}

// 从 mock 捕获结果中找出 native/proxy 两侧请求。
function splitCapturedRequests(captures) {
  const native = captures.find(
    (item) => String(item.side).toLowerCase() === "native",
  );
  const proxy = captures.find(
    (item) => String(item.side).toLowerCase() === "proxy",
  );
  if (!native || !proxy) {
    throw new Error(
      `Need one native and one proxy request, captured ${captures.length}`,
    );
  }
  return { native, proxy };
}

// 生成内置样例，覆盖 service_tier、prompt_cache_key、metadata 和 originator 差异。
function buildSelfTestRequests() {
  const native = {
    method: "POST",
    path: "/backend-api/codex/responses",
    headers: {
      authorization: "Bearer native-token",
      "chatgpt-account-id": "acct_123",
      "session-id": "thread-a",
      "thread-id": "thread-a",
      "x-codex-window-id": "thread-a:0",
    },
    body: {
      model: "gpt-5.5",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "thread-a",
      client_metadata: { "x-codex-installation-id": "install-a" },
    },
  };
  const proxy = {
    ...native,
    headers: { ...native.headers, originator: "cc-switch" },
    body: { ...native.body, service_tier: "priority" },
  };
  return { native, proxy };
}

// 写出可审计报告；summary 只包含数量和路径，不包含敏感值。
async function writeReport(outDir, nativeRequest, proxyRequest) {
  await mkdir(outDir, { recursive: true });
  const nativeShape = normalizeRequestShape(nativeRequest);
  const proxyShape = normalizeRequestShape(proxyRequest);
  const diffs = diffObjects(nativeShape, proxyShape);
  const report = {
    generated_at: new Date().toISOString(),
    diff_count: diffs.length,
    focus_fields: [
      "service_tier",
      "prompt_cache_key",
      "client_metadata",
      "originator",
      "x-openai-internal-codex-responses-lite",
      "chatgpt-account-id",
      "session-id",
      "thread-id",
      "x-codex-window-id",
    ],
    diffs,
  };
  await writeFile(
    resolve(outDir, "native.shape.json"),
    `${JSON.stringify(nativeShape, null, 2)}\n`,
  );
  await writeFile(
    resolve(outDir, "proxy.shape.json"),
    `${JSON.stringify(proxyShape, null, 2)}\n`,
  );
  await writeFile(
    resolve(outDir, "diff.report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

// 主入口负责选择 self-test、文件 diff 或 mock server 三种模式。
async function main() {
  const args = parseArgs(process.argv.slice(2));
  let nativeRequest;
  let proxyRequest;

  if (args.selfTest) {
    ({ native: nativeRequest, proxy: proxyRequest } = buildSelfTestRequests());
  } else if (args.serve || args.serveSelfTest) {
    const captures = [];
    const { server, port } = await startMockServer(captures);
    const env = {
      CODEX_COMPARE_BASE_URL: `http://127.0.0.1:${port}`,
      CODEX_COMPARE_NATIVE_BASE_URL: `http://127.0.0.1:${port}/backend-api/codex`,
      CODEX_COMPARE_PROXY_BASE_URL: `http://127.0.0.1:${port}/v1`,
    };
    console.log(`Mock server listening on ${env.CODEX_COMPARE_BASE_URL}`);
    try {
      if (args.serveSelfTest) {
        await runServeSelfTestRequests(env);
      } else {
        await runCommand(
          args.nativeCommand,
          { ...env, CODEX_COMPARE_SIDE: "native" },
          args.timeoutMs,
        );
        await runCommand(
          args.proxyCommand,
          { ...env, CODEX_COMPARE_SIDE: "proxy" },
          args.timeoutMs,
        );
      }
      ({ native: nativeRequest, proxy: proxyRequest } =
        splitCapturedRequests(captures));
      await mkdir(args.out, { recursive: true });
      await writeFile(
        resolve(args.out, "captured.raw.json"),
        `${JSON.stringify(captures, null, 2)}\n`,
      );
    } finally {
      server.close();
    }
  } else {
    if (!args.native || !args.proxy) {
      throw new Error(
        "Provide --native and --proxy JSON files, or use --serve/--self-test.",
      );
    }
    nativeRequest = await readJson(args.native);
    proxyRequest = await readJson(args.proxy);
  }

  const report = await writeReport(args.out, nativeRequest, proxyRequest);
  console.log(
    `Diff report written to ${resolve(args.out, "diff.report.json")}`,
  );
  console.log(`Diff count: ${report.diff_count}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
