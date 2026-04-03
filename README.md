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
- `GET /admin/api-keys`
- `POST /admin/api-keys`

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
  - `codexproxy-gpt-5.4-low-fast`
    - upstream model: `gpt-5.4`
    - enforced defaults: `service_tier=priority`, `reasoning.effort=low`, `reasoning.summary=none`
    - advertised context window: `260000`
  - `codexproxy-gpt-5.4-medium-fast`
    - upstream model: `gpt-5.4`
    - enforced defaults: `service_tier=priority`, `reasoning.effort=medium`, `reasoning.summary=none`
    - advertised context window: `260000`
  - `codexproxy-gpt-5.4-high-fast`
    - upstream model: `gpt-5.4`
    - enforced defaults: `service_tier=priority`, `reasoning.effort=high`, `reasoning.summary=none`
    - advertised context window: `260000`
  - `codexproxy-gpt-5.4-xhigh-fast`
    - upstream model: `gpt-5.4`
    - enforced defaults: `service_tier=priority`, `reasoning.effort=xhigh`, `reasoning.summary=none`
    - advertised context window: `260000`
- compatibility alias models kept hidden from `/v1/models`:
  - `codex-gpt-5-4-fast-xhigh`
  - `codex-gpt-5-4`
  - upstream model: `gpt-5.4`
  - enforced defaults: `service_tier=priority`, `reasoning.effort=xhigh`, `reasoning.summary=none`
  - advertised context window: `260000`
- passthrough aliases exposed for other upstream list models:
  - `codexproxy-gpt-5.4`
  - `codexproxy-gpt-5.4-mini`
  - `codexproxy-gpt-5.3-codex`
  - `codexproxy-gpt-5.2-codex`
  - `codexproxy-gpt-5.2`
  - `codexproxy-gpt-5.1-codex-max`
  - `codexproxy-gpt-5.1-codex-mini`
- Cursor compatibility:
  - if the request looks like Cursor and the model name is plain `gpt-5.4`, the proxy force-applies `service_tier=priority` and `reasoning={effort:xhigh,summary:none}`
  - this avoids Cursor rejecting the custom alias before the request is sent
- proxy auth:
  - if `PROXY_API_KEY` or `PROXY_API_KEYS` is set, all public endpoints require auth
  - accepted headers:
    - `Authorization: Bearer <key>`
    - `X-API-Key: <key>`

Example:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Reply with exactly HELLO_OK"}]
  }'
```

Alias model example:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codexproxy-gpt-5.4-medium-fast",
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

API key admin example:

```bash
curl http://127.0.0.1:8787/admin/api-keys \
  -H "Authorization: Bearer $PROXY_API_KEY"

curl http://127.0.0.1:8787/admin/api-keys \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"cursor-secondary"}'
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
- `CODEX_MODEL_ALIAS_PREFIX`: default `codexproxy-`
- `CODEX_EXPOSE_RAW_UPSTREAM_MODELS`: default `false`
- `CODEX_ALIAS_GPT54_LOW_FAST`: default `codexproxy-gpt-5.4-low-fast`
- `CODEX_ALIAS_GPT54_MEDIUM_FAST`: default `codexproxy-gpt-5.4-medium-fast`
- `CODEX_ALIAS_GPT54_HIGH_FAST`: default `codexproxy-gpt-5.4-high-fast`
- `CODEX_ALIAS_GPT54_XHIGH_FAST`: default `codexproxy-gpt-5.4-xhigh-fast`
- `CODEX_ALIAS_GPT54_FAST_XHIGH`: default `codex-gpt-5-4-fast-xhigh` (legacy compatibility alias)
- `PROXY_API_KEY`: primary API key required by this proxy
- `PROXY_API_KEYS`: optional comma-separated extra API keys accepted by this proxy
- `PROXY_API_KEYS_STATE_PATH`: default `./var/api-keys.json` for generated API keys
- `REQUEST_TIMEOUT_MS`: default `120000`
- `PROXY_LOGGING_ENABLED`: default `false`
- `PROXY_LOG_FILE_PATH`: default `./var/request-debug.jsonl`
- `PROXY_LOG_STATE_PATH`: default `./var/logging-state.json`
- `PROXY_LOG_READ_LIMIT_MAX`: default `200`
- `PROXY_LOG_FILE_MAX_BYTES`: default `10485760` (`10 MB`)
