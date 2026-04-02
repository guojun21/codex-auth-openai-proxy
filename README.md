# Codex Auth OpenAI Proxy

Local OpenAI-compatible proxy backed by the ChatGPT/Codex credentials stored in `~/.codex/auth.json`.

## MVP Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`

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

Example:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Reply with exactly HELLO_OK"}]
  }'
```

## Environment Variables

- `PORT`: default `8787`
- `HOST`: default `127.0.0.1`
- `CODEX_AUTH_JSON_PATH`: default `~/.codex/auth.json`
- `CODEX_UPSTREAM_BASE_URL`: default `https://chatgpt.com/backend-api/codex`
- `CODEX_REFRESH_URL`: default `https://auth.openai.com/oauth/token`
- `CODEX_CLIENT_VERSION`: optional override for upstream `/models`
- `CODEX_DEFAULT_MODEL`: default `gpt-5.4`
- `PROXY_API_KEY`: optional API key required by this proxy itself
- `REQUEST_TIMEOUT_MS`: default `120000`
