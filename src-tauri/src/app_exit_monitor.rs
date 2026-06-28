//! 应用退出与崩溃监控。
//!
//! 这个模块不依赖数据库，确保数据库初始化失败、panic hook 或更新安装器直接退出时
//! 仍能留下可排查的本地证据。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const RUN_MARKER_FILE: &str = "app-run-marker.json";
const EXIT_EVENTS_FILE: &str = "app-exit-events.jsonl";

static APP_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 初始化退出监控使用的配置目录。
///
/// 必须在 Store 覆盖目录刷新后调用；若 panic 发生得更早，模块会回退到默认
/// `~/.cc-switch`，避免因为目录尚未初始化而丢失崩溃证据。
pub fn init_app_config_dir(dir: PathBuf) {
    let _ = APP_CONFIG_DIR.set(dir);
}

/// 记录应用启动，并检查上次是否存在未清理的运行 marker。
///
/// 返回 `Some` 表示上次进程没有走正常退出记录。调用方可以据此打 warn 日志或在 UI
/// 层后续提示用户查看日志目录。
pub fn record_startup() -> Option<PreviousRunReport> {
    let previous = read_run_marker();
    if let Some(marker) = previous.as_ref() {
        let report = PreviousRunReport {
            marker: marker.clone(),
            crash_log_modified_at: file_modified_at(crash_log_path()),
        };
        append_event(
            "abnormal_exit_detected",
            "previous run marker remained at startup",
            None,
            Some(json!({
                "previousRun": report.marker,
                "crashLogModifiedAt": report.crash_log_modified_at,
            })),
        );
    }

    let marker = RunMarker {
        started_at: now_string(),
        pid: std::process::id(),
        version: APP_VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cwd: std::env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "unknown".to_string()),
    };

    if let Err(err) = write_run_marker(&marker) {
        log::warn!("写入应用运行 marker 失败: {err}");
    }

    previous.map(|marker| PreviousRunReport {
        marker,
        crash_log_modified_at: file_modified_at(crash_log_path()),
    })
}

/// 记录一次正常退出，并清理运行 marker。
///
/// 退出原因由调用方传入，便于区分托盘退出、窗口关闭、设置重启和更新安装等不同路径。
pub fn record_clean_exit(reason: &str, exit_code: i32) {
    append_event("clean_exit", reason, Some(exit_code), None);
    if let Err(err) = fs::remove_file(run_marker_path()) {
        if err.kind() != std::io::ErrorKind::NotFound {
            log::warn!("清理应用运行 marker 失败: {err}");
        }
    }
}

/// 记录即将直接退出的错误路径。
///
/// 这类路径通常发生在数据库或配置加载阶段，不能假设 Tauri 事件循环和数据库都可用。
pub fn record_forced_exit(reason: &str, exit_code: i32, detail: impl Into<Option<String>>) {
    append_event(
        "forced_exit",
        reason,
        Some(exit_code),
        detail.into().map(|detail| json!({ "detail": detail })),
    );
    let _ = fs::remove_file(run_marker_path());
}

/// 记录 panic hook 捕获到的崩溃摘要。
///
/// 详细 backtrace 仍由 `panic_hook` 写入 `crash.log`；这里写一条结构化 JSONL，
/// 方便下次启动或用户汇总“崩溃原因”。
pub fn record_panic(message: &str, location: Option<String>, thread: Option<String>) {
    append_event(
        "panic",
        message,
        None,
        Some(json!({
            "location": location,
            "thread": thread,
        })),
    );
}

/// 打开日志目录。
///
/// 返回路径字符串供前端 toast 或调试使用；实际打开由命令层完成。
pub fn log_dir_path() -> PathBuf {
    get_app_config_dir().join("logs")
}

/// 异常退出历史文件路径。
pub fn exit_events_path() -> PathBuf {
    log_dir_path().join(EXIT_EVENTS_FILE)
}

/// 上次未正常退出的报告。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousRunReport {
    pub marker: RunMarker,
    pub crash_log_modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMarker {
    pub started_at: String,
    pub pid: u32,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    timestamp: String,
    kind: String,
    reason: String,
    exit_code: Option<i32>,
    version: String,
    os: String,
    arch: String,
    pid: u32,
    details: Option<Value>,
}

fn append_event(kind: &str, reason: &str, exit_code: Option<i32>, details: Option<Value>) {
    let event = ExitEvent {
        timestamp: now_string(),
        kind: kind.to_string(),
        reason: reason.to_string(),
        exit_code,
        version: APP_VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        pid: std::process::id(),
        details,
    };

    let path = exit_events_path();
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    if let Ok(line) = serde_json::to_string(&event) {
        let _ = writeln!(file, "{line}");
    }
}

fn read_run_marker() -> Option<RunMarker> {
    let text = fs::read_to_string(run_marker_path()).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_run_marker(marker: &RunMarker) -> std::io::Result<()> {
    let path = run_marker_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(marker).map_err(std::io::Error::other)?;
    fs::write(path, text)
}

fn run_marker_path() -> PathBuf {
    log_dir_path().join(RUN_MARKER_FILE)
}

fn crash_log_path() -> PathBuf {
    get_app_config_dir().join("crash.log")
}

fn get_app_config_dir() -> PathBuf {
    APP_CONFIG_DIR
        .get()
        .cloned()
        .unwrap_or_else(default_app_config_dir)
}

fn default_app_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cc-switch")
}

fn now_string() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

fn file_modified_at(path: PathBuf) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let datetime: chrono::DateTime<chrono::Local> = modified.into();
    Some(datetime.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_events_path_uses_logs_directory() {
        let path = exit_events_path();
        assert!(path.ends_with(EXIT_EVENTS_FILE));
        assert!(path.to_string_lossy().contains("logs"));
    }

    #[test]
    fn clean_exit_event_serializes_exit_code() {
        let event = ExitEvent {
            timestamp: "2026-06-28 12:00:00.000".to_string(),
            kind: "clean_exit".to_string(),
            reason: "unit_test".to_string(),
            exit_code: Some(0),
            version: "test".to_string(),
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            pid: 42,
            details: None,
        };

        let text = serde_json::to_string(&event).expect("serialize event");
        assert!(text.contains("\"kind\":\"clean_exit\""));
        assert!(text.contains("\"exitCode\":0"));
    }
}
