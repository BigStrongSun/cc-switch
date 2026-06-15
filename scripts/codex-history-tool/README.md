# Codex History Tool

Standalone Python tool for listing and repairing Codex Desktop history visibility.

It uses only the Python standard library. No helper executable is required.

## List Sessions

```powershell
python .\codex_history_tool.py list --limit 20 --json
```

Optional filters:

```powershell
python .\codex_history_tool.py list --codex-home "$env:USERPROFILE\.codex" --project-path "C:\Users\sunda\Documents\LLMservice" --query "MultiRouter"
```

## Preview Repair

The default repair mode matches the currently successful Desktop-sidebar fix:
`source=vscode`, project top 10, global recent window 300, and rollout mtime sync.

```powershell
python .\codex_history_tool.py repair --project-path "C:\Users\sunda\Documents\LLMservice" --json
```

## Apply Repair

Close Codex Desktop first unless you intentionally pass `--force`.

```powershell
python .\codex_history_tool.py repair --project-path "C:\Users\sunda\Documents\LLMservice" --apply
```

## Repair Selected Sessions

Use `list` to find IDs, then pass one or more `--session-id` values.

```powershell
python .\codex_history_tool.py repair --session-id "<session-id>" --apply
```

Useful overrides:

- `--codex-home <path>`: choose another Codex directory.
- `--state-db <path>`: force a specific state SQLite file.
- `--target-provider <id>`: default is the live `config.toml` provider, falling back to `codex_model_router_v2`.
- `--max-per-project 10 --max-total 300`: balanced recent-window caps.
