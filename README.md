# TinyWebUI

TinyWebUI is a local-first, bring-your-own-model chat workspace for OpenAI-compatible APIs and MCP tools. It gives a model a clean chat interface, durable conversations, document and image attachments, and a bounded tool loop—without requiring a hosted backend or account system.

Bring an endpoint such as OpenRouter, OpenAI, Groq, Ollama, vLLM, or LM Studio; choose a model and system prompt; then connect the MCP servers you want the model to use.

## What it includes

- Persistent SQLite-backed chats, with edit, retry, delete, full-text search, and folders.
- Streaming answers, tool activity, reasoning display, per-round token usage, and cache-read/write usage when a provider reports it.
- MCP over stdio, Streamable HTTP, or SSE, plus built-in `read_document` and `context_expand` tools.
- Attachments: text-based files, PDFs with extractable text, DOCX files, and images for vision-capable models.
- Long-chat controls: bounded tool turns, deterministic prompt-cache shaping, and compaction that preserves full tool output locally.
- A settings panel for models, prompts, tools, MCP servers, token/context settings, usage, and themes.
- Local themes, including the included Fall Fairy theme. See [theme authoring](public/themes/README.md).

TinyWebUI is deliberately single-user and local-first. It is a personal workspace, not a multi-tenant hosted chat service.

## Run

Requires Node.js 22 or later.

```bash
npx tinywebui

# Or from a clone of this repository:
npm install
npm start
```

Open <http://127.0.0.1:7777>. Use `--port` and `--host` to change the listener:

```bash
npx tinywebui --port 8080 --host 127.0.0.1
```

For development, `npm run dev` watches `src/` and `bin/`; files under `public/` are served directly and need only a browser refresh.

## Configure a model

Create a configuration file beside the directory where you run TinyWebUI:

```bash
cp example.tinywebui.config.json tinywebui.config.json
```

`tinywebui.config.json` is gitignored. It may contain an API key, so do not commit it. You can place it elsewhere with `TINYWEBUI_CONFIG`; `TINYWEBUI_API_KEY`, `OPENROUTER_API_KEY`, `TINYWEBUI_BASE_URL`, and `TINYWEBUI_MODEL` override file values.

An OpenRouter example:

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-...",
  "model": "deepseek/deepseek-v4-flash-0731",
  "systemPrompt": "You are a terse, precise assistant.",
  "maxToolRounds": 20
}
```

For a local OpenAI-compatible runtime, point `baseUrl` at its API and omit `apiKey`:

```json
{
  "baseUrl": "http://localhost:8080/v1",
  "model": "qwen3-coder-30b-a3b-instruct"
}
```

The Settings panel can change the model, prompt, generation settings, tool budget, context controls, and enabled tools. It never exposes the API key to the browser.

### Important settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `maxToolRounds` | `20` | Shared tool-use budget for one user message. One model response that calls one or more tools uses one round. |
| `cache` | `true` | Enables prompt-cache shaping where supported. |
| `cacheMode` | `"auto"` | Selects implicit, explicit, or OpenRouter rolling cache behavior. |
| `cacheTtl` | `"5m"` | Anthropic cache lifetime; `"1h"` is also available. |
| `compactThreshold` | `20000` | Estimated prompt tokens at which older tool results are compacted; `0` disables it. |
| `keepTurns` | `2` | Recent user turns whose tool results stay in the immediate context. |
| `maxInlineChars` | `6000` | Tool-result size that triggers immediate stubbing for later turns. |

The model sees the full tool budget on the first request, a remaining count on subsequent requests, and a warning for the final two rounds. Once spent, TinyWebUI makes one final model request with tools disabled so the model can answer from the evidence it already gathered.

## MCP tools

MCP server definitions live in `mcp.json` next to the config file. Create one from the example if needed:

```bash
cp example.mcp.json mcp.json
```

TinyWebUI accepts the same general shape used by MCP desktop clients:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "research": {
      "url": "http://127.0.0.1:8000/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

Stdio servers may use `command`, `args`, `env`, and `cwd`. Remote servers use `url`, optional `headers`, and optional `"transport": "sse"`; Streamable HTTP is the default remote transport. Set `"disabled": true` on a server to keep it disconnected.

The Settings panel validates and saves `mcp.json`, then reconnects the hub without restarting the app. You can also disable individual tools without disconnecting their server. MCP tools are presented to the model with stable `server__tool` names.

Two local tools are always available:

- `read_document` searches or reads an attached document.
- `context_expand` searches or pages through the complete output behind a compacted tool result.

## Attachments and conversations

Attach files by using the paperclip, dragging them onto the composer, or pasting a long block of text. Text files, source files, CSV/JSON, extractable PDFs, and DOCX files are stored as documents for the current chat; the model uses `read_document` to retrieve the relevant parts. Each document is limited to 5 MiB.

Image attachments are sent with the message to the configured model, up to eight images and 5 MiB each. Use a model and endpoint that accept OpenAI-style image content. Scanned/image-only PDFs are not OCR'd, and legacy `.doc` files are not supported.

Chats, documents, full tool results, and usage are stored in `tinywebui.db` beside the config file by default. Set `dbPath` in the configuration or `TINYWEBUI_DB` to choose another location. Chat search indexes user messages and completed answers—not chain-of-thought, tool calls, or raw tool output—so results stay useful.

A running turn belongs to the server rather than the browser tab: reloading or disconnecting does not cancel it. Reopen the chat to rejoin its stream, or use **stop** to cancel it.

## Automations

Create recurring automations from the **automations** view or ask the model to manage them with `manage_automation`. Use **run now** or ask the model to trigger one for an immediate workflow run; manual triggers wait for the target chat's current turn to finish. Each automation adds its instructions to a selected chat on a five-field cron schedule and IANA timezone. Runs use the current model configuration and enabled tools, and appear in that chat and in the automation's run history. Automations run only while TinyWebUI is running; missed scheduled occurrences and scheduled occurrences during a busy chat are skipped. No external notifications are sent.

## Keeping long tool chats practical

Tool results can be much larger than the conversation itself. TinyWebUI keeps the complete result in SQLite, but avoids resending it indefinitely:

1. Within a compacted context epoch, history is append-only and serialized deterministically so providers can reuse matching prompt prefixes.
2. When the prompt crosses `compactThreshold`, older tool results are replaced once with compact stubs containing an artifact ID, a structural hint, and verbatim head/tail text.
3. The model can recover exact content later through `context_expand`; the complete result remains available in the chat store.

For OpenRouter, TinyWebUI sends a stable per-chat `session_id` to help provider sticky routing keep prompt caches warm. Claude on OpenRouter uses its automatic rolling cache directive; local and other compatible endpoints receive no OpenRouter-only fields. Set `cacheMode` explicitly only when your gateway needs a different cache dialect, or set `cache: false` to turn the feature off.

## Security and limits

TinyWebUI is designed for a local workspace. Keep it bound to `127.0.0.1`, or configure its optional authentication before exposing it to a network. Automations are scoped to the signed-in user when authentication is enabled. MCP servers run with the access you configure for them, so treat each configured server and its credentials as trusted local infrastructure.

The app does not provide OCR, cloud synchronization, user accounts, or branching chat history. Delete chats you no longer need; their associated documents and tool artifacts are deleted with them.

## Development

```bash
npm test
```

The test suite covers message serialization, cache behavior, compaction, tool routing, retries, chat editing, search, streaming/rejoin behavior, and settings/tool management.

## License

GNU Affero General Public License v3.0 or later ([AGPL-3.0-or-later](LICENSE)).
If you run a modified version for users over a network, you must offer them the
Corresponding Source for that version.
