# Codex Auth OpenAI Proxy

Local OpenAI-compatible proxy backed by the ChatGPT/Codex credentials stored in `~/.codex/auth.json`.

## MVP Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /admin/logging`
- `POST /admin/logging`
- `GET /admin/logs`

## Scope

This project intentionally keeps the first slice small:

- direct backend access to `chatgpt.com/backend-api/codex`
- no Codex CLI subprocess dependency
- text generation first
- streaming and non-streaming support
- token refresh from the stored ChatGPT refresh token

## Current Limitations

- The backend requires `instructions`; the proxy injects an empty string when the client omits it.
- The backend requires streaming upstream; the proxy always talks to the upstream in streaming mode and synthesizes non-streaming results for clients.
- Chat Completions compatibility is focused on text generation first. Advanced tool-calling edge cases are not the first-MVP priority.

## Usage

```bash
cd /Users/ruicheng.gu/Documents/project/agentHarness/services/codex-auth-openai-proxy
pnpm install
pnpm start
```

Default server:

- base URL: `http://127.0.0.1:8787/v1`
- preset alias models:
  - `codex-gpt-5-4-high`
    - upstream model: `gpt-5.4`
    - enforced defaults: `reasoning.effort=high`, `reasoning.summary=none`
    - advertised context window: `260000`
  - `codex-gpt-5-4-high-fast`
    - upstream model: `gpt-5.4`
    - enforced defaults: `service_tier=priority`, `reasoning.effort=high`, `reasoning.summary=none`
    - advertised context window: `260000`
  - `codex-gpt-5-4-xhigh`
    - upstream model: `gpt-5.4`
    - enforced defaults: `reasoning.effort=xhigh`, `reasoning.summary=none`
    - advertised context window: `260000`
  - `codex-gpt-5-4-xhigh-fast`
    - upstream model: `gpt-5.4`
    - enforced defaults: `service_tier=priority`, `reasoning.effort=xhigh`, `reasoning.summary=none`
    - advertised context window: `260000`
- compatibility alias model: `codex-gpt-5-4-fast-xhigh`
  - upstream model: `gpt-5.4`
  - enforced defaults: `service_tier=priority`, `reasoning.effort=xhigh`, `reasoning.summary=none`
  - advertised context window: `260000`
- Cursor compatibility:
  - if the request looks like Cursor and the model name is plain `gpt-5.4`, the proxy force-applies `service_tier=priority` and `reasoning={effort:xhigh,summary:none}`
  - this avoids Cursor rejecting the custom alias before the request is sent

Example:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Reply with exactly HELLO_OK"}]
  }'
```

Alias model example:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-gpt-5-4-xhigh-fast",
    "messages": [{"role": "user", "content": "Reply with exactly ALIAS_OK"}]
  }'
```

Logging admin example:

```bash
curl http://127.0.0.1:8787/admin/logging \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'

curl "http://127.0.0.1:8787/admin/logs?limit=20" \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

When logging is disabled, request traffic is not appended to disk. Only the enable transition is force-written so detailed logging can start immediately after you turn it on.

Logging detail and retention:

- request logs are detailed JSONL entries, not summary logs
- they include full JSON request bodies, full JSON response bodies, upstream request bodies, upstream SSE events when captured, and serialized errors
- secret-bearing headers such as `Authorization`, cookies, account IDs, and API keys are redacted
- when the log file grows beyond `10 MB`, the proxy automatically removes the oldest content and keeps only the newest `10 MB`

## Environment Variables

- `PORT`: default `8787`
- `HOST`: default `127.0.0.1`
- `CODEX_AUTH_JSON_PATH`: default `~/.codex/auth.json`
- `CODEX_UPSTREAM_BASE_URL`: default `https://chatgpt.com/backend-api/codex`
- `CODEX_REFRESH_URL`: default `https://auth.openai.com/oauth/token`
- `CODEX_CLIENT_VERSION`: optional override for upstream `/models`
- `CODEX_DEFAULT_MODEL`: default `gpt-5.4`
- `CODEX_ALIAS_GPT54_HIGH`: default `codex-gpt-5-4-high`
- `CODEX_ALIAS_GPT54_HIGH_FAST`: default `codex-gpt-5-4-high-fast`
- `CODEX_ALIAS_GPT54_XHIGH`: default `codex-gpt-5-4-xhigh`
- `CODEX_ALIAS_GPT54_XHIGH_FAST`: default `codex-gpt-5-4-xhigh-fast`
- `CODEX_ALIAS_GPT54_FAST_XHIGH`: default `codex-gpt-5-4-fast-xhigh` (legacy compatibility alias)
- `PROXY_API_KEY`: optional API key required by this proxy itself
- `REQUEST_TIMEOUT_MS`: default `120000`
- `PROXY_LOGGING_ENABLED`: default `false`
- `PROXY_LOG_FILE_PATH`: default `./var/request-debug.jsonl`
- `PROXY_LOG_STATE_PATH`: default `./var/logging-state.json`
- `PROXY_LOG_READ_LIMIT_MAX`: default `200`
- `PROXY_LOG_FILE_MAX_BYTES`: default `10485760` (`10 MB`)
