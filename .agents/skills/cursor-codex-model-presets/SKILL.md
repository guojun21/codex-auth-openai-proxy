---
name: cursor-codex-model-presets
description: Install or update custom Cursor model presets backed by the codex-auth-openai-proxy. Use when the user asks to expose Codex GPT-5.4 variants in Cursor, rename Cursor custom model labels, switch between fast-only and other preset sets, or sync Cursor's local model list with proxy alias names and 260k context window tooltips.
---

# Cursor Codex Model Presets

Use this skill when Cursor needs custom model entries that map to proxy aliases such as `codex-gpt-5-4-low-fast`.

## Default preset set

Keep Cursor aligned with the proxy's fast-only exposed presets:

- `codex-gpt-5-4-low-fast`
- `codex-gpt-5-4-medium-fast`
- `codex-gpt-5-4-high-fast`
- `codex-gpt-5-4-xhigh-fast`

Display labels should be:

- `GPT-5.4 Codex Low Fast`
- `GPT-5.4 Codex Medium Fast`
- `GPT-5.4 Codex High Fast`
- `GPT-5.4 Codex Extra High Fast`

Tooltip text should advertise `260k context window`.

Legacy alias `codex-gpt-5-4-fast-xhigh` is compatibility-only. Do not keep it in Cursor's visible custom model list.

## Workflow

1. If the proxy aliases changed, update [src/config.ts](/Users/ruicheng.gu/Documents/project/agentHarness/services/codex-auth-openai-proxy/src/config.ts) first so Cursor names and proxy names stay aligned.
2. Run `scripts/apply_cursor_codex_models.py` instead of hand-editing SQLite.
3. The script patches both:
   - `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
   - `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb.backup`
4. The script quits Cursor first, writes backups of the `applicationUser` JSON to `/tmp`, updates the preset list, and reopens Cursor unless `--no-reopen` is passed.
5. Verify by re-reading the `applicationUser` row and checking `isUserAdded` entries.

## Commands

Apply the default fast-only preset set:

```bash
python3 /Users/ruicheng.gu/Documents/project/agentHarness/services/codex-auth-openai-proxy/.agents/skills/cursor-codex-model-presets/scripts/apply_cursor_codex_models.py
```

Apply without reopening Cursor:

```bash
python3 /Users/ruicheng.gu/Documents/project/agentHarness/services/codex-auth-openai-proxy/.agents/skills/cursor-codex-model-presets/scripts/apply_cursor_codex_models.py --no-reopen
```

Dry run:

```bash
python3 /Users/ruicheng.gu/Documents/project/agentHarness/services/codex-auth-openai-proxy/.agents/skills/cursor-codex-model-presets/scripts/apply_cursor_codex_models.py --dry-run
```
