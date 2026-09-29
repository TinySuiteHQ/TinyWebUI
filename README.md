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

TinyWebUI is local-first: out of the box it is a personal workspace with no login. When you need more, it grows in [three tiers](#access-three-tiers): a password for just you, or many users signing in with Google, Apple or company SSO, with per-user data and an admin panel.

## Run

Requires Node.js 22.13 or later.

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

`tinywebui.config.json` is gitignored. It may contain an API key, so do not commit it. You can place it elsewhere with `TINYWEBUI_CONFIG`; `TINYWEBUI_API_KEY`, `OPENROUTER_API_KEY`, `TINYWEBUI_BASE_URL`, and `TINYWEBUI_MODEL` override file values. `TINYWEBUI_LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`; default `info`) sets how much the server logs; every line is tagged by area, like `[tinywebui:mcp]`. Audit events are always written.

An OpenRouter example:

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-...",
  "model": "deepseek/deepseek-v4.1-flash",
  "systemPrompt": "You are a terse, precise assistant.",
  "maxToolRounds": 12
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

### Model catalog

List `models` to decide exactly which models people can use, what those models are called and how each one behaves. If the list is empty (the default), any model id works. If it has entries, it is a closed list:

```json
{
  "model": "quick",
  "models": [
    { "id": "quick", "label": "Quick", "description": "Everyday questions",
      "model": "deepseek/deepseek-v4.1-flash", "temperature": 0.3 },
    { "id": "deep", "label": "Thorough", "model": "anthropic/claude-sonnet-5",
      "systemPrompt": "You are a careful research assistant...", "maxToolRounds": 20,
      "extraBody": { "reasoning": { "effort": "high" } } }
  ],
  "access": { "roles": { "user": { "models": ["quick"] } } }
}
```

- `id` is the name everything else refers to: the `model` setting, `access.roles.*.models` and each person's saved choice. `model` is the provider's model id; if you leave it out, the `id` is sent instead.
- People see only `label` (and `description`) in the model picker. They can't type in an id, and the provider id is never sent to the browser.
- An entry can set any of `systemPrompt`, `temperature`, `maxTokens`, `maxToolRounds`, `cacheMode`, `cacheTtl` and `extraBody`. These replace the global values for turns that use that model. The one exception is `extraBody`, which is merged into the global `extraBody`.
- `"enabled": false` switches an entry off but keeps its settings. The model disappears from the picker, people who had picked it fall back to the default, and a role list can still name it. The default `model` must be an enabled entry.
- `models` can only be changed in the config file, not from the UI. On startup and on reload, TinyWebUI refuses a catalog with an unknown key, a duplicate id, or a `model` or role list that names something not in the catalog.

### Important settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `maxToolRounds` | `12` | Shared tool-use budget for one user message. One model response that calls one or more tools uses one round. |
| `askUserTimeoutSeconds` | `120` | How long a question the model asks with the built-in `ask_user` tool waits for an answer. When it runs out, the same run continues on the model's own assumptions. `0` waits until the question is answered or the run is stopped. Automation runs never wait. |
| `cache` | `true` | Enables prompt-cache shaping where supported. |
| `cacheMode` | `"auto"` | Selects implicit, explicit, or OpenRouter rolling cache behavior. |
| `cacheTtl` | `"5m"` | Anthropic cache lifetime; `"1h"` is also available. |
| `compactThreshold` | `60000` | History tokens (system prompt and tool definitions excluded) at which older tool results are compacted; `0` disables it. |
| `keepTurns` | `2` | Recent user turns whose tool results stay in the immediate context. |
| `compactMinSaved` | `20000` | Minimum characters a compaction must remove to be worth its cache miss. |
| `maxInlineChars` | `30000` | Tool-result size that triggers immediate stubbing for later turns. |
| `maxTurnChars` | `120000` | Tool-result size that is stubbed even within the turn that fetched it. |
| `maxHistoryTokens` | `100000` | Hard limit: past this, the oldest turns stop being sent to the model (they stay in the transcript); `0` disables it. |
| `timezone` | `""` | IANA zone the model is told today's date in; empty uses the server's zone. |

The system prompt tells the model the full tool budget and today's date. The last tool result of each round ends with a remaining-rounds note, which turns into a warning for the final two rounds. Once spent, TinyWebUI makes one final model request with tools disabled so the model can answer from the evidence it already gathered.

### Configure from code

`start()` takes the same settings, so an instance can be spun up without any files:

```js
import { start } from 'tinywebui';

const server = await start({
  port: 7777,
  config: { apiKey: process.env.OPENROUTER_API_KEY, model: 'anthropic/claude-sonnet-5' },
  mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } },
  configFile: false, // or a path; false reads and writes no config file
  dbPath: ':memory:',
});
// later: await server.shutdown();
```

Layers apply lowest first: built-in defaults, the config file, environment variables, then `config`. Keys set in `config` are locked: the Settings panel shows them read-only and the API refuses to change them. With `configFile: false`, changes to the remaining settings last only for the process. Passing `mcpServers` replaces `mcp.json` and makes the MCP editor read-only.

The `tinywebui` command does the same when it finds a `tinywebui.config.js` (or `.mjs`) in the working directory, or when `TINYWEBUI_CONFIG` points at one. The file's default export is the options object, or a function (async is fine) that returns it. `--port` and `--host` still override it. The JS file takes precedence, but `tinywebui.config.json` beside it is still read and saved to unless the file sets `configFile: false`.

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

### Tool approval

MCP tool calls that can change something wait for you: the call appears in the transcript with its arguments and **allow**, **always allow this tool**, and **deny**. A tool counts as read-only only when its server marks it with the MCP `readOnlyHint` annotation; anything unmarked is treated as a possible write. Set `toolApproval` to `"writes"` (default), `"all"` or `"off"` in Settings, and override single tools from the tools panel (always ask / never ask, stored as `confirmTools` / `autoApproveTools`). TinyWebUI's own built-in tools never ask. Scheduled automation runs have no one to ask, so a call that would need approval is refused there and the run reports it.

These local tools are always available:

- `read_document` searches or reads an attached document.
- `search_chats` searches the user's earlier conversations (never the current one) and returns matching questions with the answers they got.
- `context_expand` searches or pages through the complete output behind a compacted tool result.
- `ask_user` asks the user a question mid-turn, optionally with choices, and waits for the answer.
- `manage_tasks` keeps a visible checklist for the current chat, shown in the right rail.
- `manage_automation` creates, edits and runs scheduled automations.

## Attachments and conversations

Attach files by using the paperclip, dragging them onto the composer, or pasting a long block of text. Text files, source files, CSV/JSON, extractable PDFs, and DOCX files are stored as documents for the current chat; the model uses `read_document` to retrieve the relevant parts. Each document is limited to 5 MiB.

Image attachments are sent with the message to the configured model, up to eight images and 5 MiB each. Use a model and endpoint that accept OpenAI-style image content. Scanned/image-only PDFs are not OCR'd, and legacy `.doc` files are not supported.

Chats, documents, full tool results, and usage are stored in `tinywebui.db` beside the config file by default. Set `dbPath` in the configuration or `TINYWEBUI_DB` to choose another location. Chat search indexes user messages and completed answers—not chain-of-thought, tool calls, or raw tool output—so results stay useful.

A running turn belongs to the server rather than the browser tab: reloading or disconnecting does not cancel it. Reopen the chat to rejoin its stream, or use **stop** to cancel it.

### Smarter search (optional)

Everything the model can search goes through one retrieval engine: passages of attached documents (`read_document`) and past conversation turns (`search_chats`). A chat turn is one question plus the answer it finally got, not the narration or tool calls in between. By default the engine uses SQLite's full-text search (BM25): fast, no extra packages, and exact about words. Turn on **hybrid** retrieval to also match meaning, so a question about an "automobile" finds the paragraph about the "sedan". It works the way TinySearch and TinyContext do: the same local ONNX embedding models, BM25 and embeddings fused with Reciprocal Rank Fusion, and nothing leaves the machine.

```bash
npm install onnxruntime-node @huggingface/tokenizers   # optional packages, only for dense/hybrid
npx tinywebui models pull fast                         # the one explicit download; prints its sha256
```

```json
{ "retrieval": { "mode": "hybrid", "model": "fast", "modelSha256": "<sha256 from models pull>" } }
```

**How it works: small-to-big retrieval.** A document is split twice:

| | Passage | Chunk |
| --- | --- | --- |
| What it is | What `read_document` returns to the model | What gets embedded |
| Size | `passageSize` characters (default 1,800, about 400 tokens) | The embedding model's token limit: 256 for `fast`, 512 for `balanced`/`quality`/`multilingual` |
| Overlap | `passageOverlap` characters (default 200) | `chunkOverlap` tokens (default 32) |
| Used for | BM25 (every mode) and the text the model reads | Dense matching (`dense`, `hybrid`) |

A question is compared with every small chunk, each passage takes its best chunk's score, and the model gets whole passages. Small chunks keep the embedding match precise; big passages give the model enough context to answer. Because chunks follow the model, every part of a passage is embedded, even when the passage is longer than the model can read at once.

- **Modes:** `lexical` (default), `dense` (embeddings only), `hybrid` (both, fused).
- **Models:** `fast` (all-MiniLM-L6-v2), `balanced` (bge-small-en-v1.5) and `quality` (bge-base-en-v1.5), the same presets as TinySearch, are English-only. For documents in other languages, or questions in a different language from the document, use `multilingual` (granite-embedding-107m-multilingual, Apache-2.0): about as fast as `fast`, but a larger download (430 MB). When questions and documents are in different languages, keyword matches rarely help, so `dense` mode or a higher `denseWeight` usually ranks better than the default hybrid. A custom bundle works with `modelDir`.
- **Embeddings are computed once.** Document chunks are embedded when the document is attached, chat turns when each run ends, and older chats and documents are embedded in the background on startup. Vectors are stored in SQLite; queries embed only the question. Switching models re-embeds automatically, a turn whose answer changes is re-embedded, and deleting a document or chat (or rewinding a chat) deletes its vectors.
- **Adding a corpus.** The engine in `src/retrieval/retrieval.js` searches any source that describes its units through a small adapter (`units`, `candidates`, `lexical`, `hydrate`, ...). Register one with `retrieval.register(name, corpus)` and it gets lexical, dense and hybrid search, storage and backfill.
- **Nothing downloads at runtime.** A missing bundle, missing packages or a checksum that doesn't match `modelSha256` stops startup with a clear message. `tinywebui models verify` and `tinywebui doctor` check the same things beforehand. ONNX Runtime's telemetry is switched off.
- **Tuning:** `passageSize`/`passageOverlap` (what the model gets back), `chunkOverlap`, `denseWeight` (default 0.5), `rrfK` (default 60), and `queryPrefix`/`documentPrefix` for models that expect instructions (for bge, set `queryPrefix` to `"Represent this sentence for searching relevant passages: "`). Bigger passages give more context per hit, but fewer hits fit in one `read_document` result.
- **Changing settings is safe.** Stored documents are re-split on the next start when the passage settings change, and re-embedded when the model or `chunkOverlap` changes. Passage settings apply in `lexical` mode too.
- **Containers:** `Dockerfile.hybrid` bakes a model into the image at build time and fails the build if `EMBEDDING_SHA256` doesn't match.

## Automations

Create recurring automations from the **automations** view or ask the model to manage them with `manage_automation`. Use **run now** or ask the model to trigger one for an immediate workflow run; manual triggers wait for the target chat's current turn to finish. Each automation adds its instructions to a selected chat on a five-field cron schedule and IANA timezone. Runs use the current model configuration and enabled tools, and appear in that chat and in the automation's run history. Automations run only while TinyWebUI is running; missed scheduled occurrences and scheduled occurrences during a busy chat are skipped. No external notifications are sent.

## Keeping long tool chats practical

Tool results can be much larger than the conversation itself. TinyWebUI keeps the complete result in SQLite, but avoids resending it indefinitely:

1. Within a compacted context epoch, history is append-only and serialized deterministically so providers can reuse matching prompt prefixes.
2. When the history crosses `compactThreshold`, older tool results are replaced once with compact stubs containing an artifact ID, a structural hint, and verbatim head/tail text, and older image attachments are replaced with a short note.
3. The model can recover exact content later through `context_expand`; the complete result remains available in the chat store.
4. If the history is still over `maxHistoryTokens` after that (typically a very long chat with few tool calls), the oldest turns are dropped from what the model sees, cutting on a user message and leaving a note that earlier conversation was omitted.

For OpenRouter, TinyWebUI sends a stable per-chat `session_id` to help provider sticky routing keep prompt caches warm. Claude on OpenRouter uses its automatic rolling cache directive; local and other compatible endpoints receive no OpenRouter-only fields. Set `cacheMode` explicitly only when your gateway needs a different cache dialect, or set `cache: false` to turn the feature off.

## Evals

`npm run eval` replays the tasks in `evals/tasks/` against the configured model and scores its behaviour: whether it uses tools instead of guessing, ignores instructions planted in tool output, reports failures honestly, respects a declined call, and so on. Each task scripts its tools' results, so runs are comparable; checks are deterministic (regex, call counts) except `judge`, which asks the model for a strict PASS/FAIL on one criterion.

```bash
npm run eval -- --repeat 3 --save baseline   # record a reference run
# ...change the prompt or harness...
npm run eval -- --repeat 3 --compare baseline
```

`--only name,words` runs a subset and `--model id` tries another model. Results are written to `evals/results/` (ignored by git). Add a task by dropping a JSON file into `evals/tasks/`; the existing ones show every check type.

## Access: three tiers

Pick one with `authMode`. Each tier keeps everything the one before it has.

| Tier | `authMode` | Who | Sign-in |
| --- | --- | --- | --- |
| 1. Just you | `"none"` (default) | You, on your own machine | None |
| 2. Just you, with auth | `"single"` | You, reachable over a network | A password |
| 3. Users and admins | `"trusted-header"` | A team or organization | Google, Apple, SSO, etc., through a sign-in gateway |

### Tier 1: just you

The default. There is no login, and every chat, setting and tool belongs to whoever can reach the page. Keep it bound to `127.0.0.1`.

### Tier 2: just you, with auth

To reach your own instance from other devices, put a password in front of it:

```bash
npx tinywebui set-password   # prompts, then writes authMode "single" and a hash to your config
npx tinywebui --host 0.0.0.0
```

The config file stores only an scrypt hash, never the password itself. In containers, set `"authMode": "single"` and pass the password in `TINYWEBUI_PASSWORD` instead. Sessions are HTTP-only signed cookies. After five wrong passwords, that address is locked out for 15 minutes. Running `set-password` again ends every existing session. Your chats are the same ones you had in tier 1; switching tiers never hides data. Serve it over HTTPS (for example behind a reverse proxy) whenever it leaves your machine.

### Tier 3: users and admins

For a team, TinyWebUI sits behind a **sign-in gateway** that handles the actual login, so any provider the gateway supports works: Google, Apple, Microsoft, GitHub, Okta or any OIDC/SAML SSO. It works with any gateway that can forward identity headers, such as Cloudflare Access, oauth2-proxy, Authelia or Authentik. The gateway verifies the person and passes their identity to TinyWebUI in request headers:

```json
{
  "authMode": "trusted-header",
  "trustedProxyCidrs": ["172.20.0.0/16"],
  "trustedUserIdHeader": "x-tinysuite-user-id",
  "trustedEmailHeader": "x-tinysuite-email",
  "trustedNameHeader": "x-tinysuite-name",
  "trustedRoleHeader": "x-tinysuite-role",
  "logoutUrl": "https://<team>.cloudflareaccess.com/cdn-cgi/access/logout",
  "access": {
    "bootstrapAdmins": ["<your gateway user id>"],
    "newUsers": "approved"
  }
}
```

- **Accounts create themselves.** The first request from someone new creates their account, with no signup step. Accounts are keyed on the gateway's stable user ID, not on email, so a changed email address keeps the same account and data.
- **Everyone's data is private.** Chats, documents, folders, search, automations and usage all belong to their user. The server refuses any request that reaches for another user's data by ID.
- **The first admin comes from the config.** Anyone listed in `access.bootstrapAdmins` is always an approved admin, so there is no manual setup step.
- **Roles and features.** Each role gets a list of features (see [Driving TinyWebUI from code](#driving-tinywebui-from-code)). For example, users can be limited to chatting, while admins set up the models and MCP servers. The gateway can also send `admin` or `user` in the role header, but a decision recorded in the files outranks it. A browser cannot promote itself.
- **Admins** get an **Admin** menu item under Statistics, where they can:
  - approve pending users (set `access.newUsers: "pending"` to require approval);
  - disable accounts, which is an immediate 403 that also stops the user's automations;
  - change roles;
  - read any user's chats, documents and live turns. This view is read-only, and every view is recorded in the audit log.
- **Settings belong to the operator.** Without the `settings` feature, the model, system prompt and tool approval rules are read-only, and credentials and the gateway address are hidden. Without `mcp`, the MCP servers are hidden. Each person picks their own model from their role's allowed list; this never changes anyone else's model.
- **Audit log.** Accounts created, rejected requests, role and status changes, config changes and admin views are written to stdout as `[tinywebui:audit]` JSON lines. Messages and secrets are never logged.

Identity headers are believed **only** from the addresses in `trustedProxyCidrs`, based on the real network connection (`X-Forwarded-For` is ignored). TinyWebUI refuses to start in this mode without that list. The gateway must strip any identity headers a client sends, and TinyWebUI must be reachable only through the gateway: no published port.

## Driving TinyWebUI from code

Everything about a deployment, down to what each user sees, can be set up and changed from files. An agent or a script can build the whole thing, check it into git and hand it over, and the running app stays in step with the files.

**Two files, three kinds of setting:**

| Kind | Where it lives | Can the UI change it? |
| --- | --- | --- |
| **File-only**: `authMode`, passwords, `trusted*`, `logoutUrl`, `baseUrl`, `apiKey`, `dbPath`, `access` | `tinywebui.config.js` or `tinywebui.config.json` | Never. The API refuses, even for admins. |
| **Frozen**: anything set in `tinywebui.config.js` (including `mcpServers`) | `tinywebui.config.js` | No. Shown read-only. |
| **Editable**: everything else | `tinywebui.config.json`, `mcp.json` | Yes, and every UI change is **written back to the file**. |

**Freeze the whole control plane** with `frozen: true` (in either file). Then nothing about settings, tools or MCP servers can change from the UI or API, and the UI shows it all as managed. Change the files and let them reload instead. User data (chats, documents, folders, automations) and admins' user decisions stay live.

**Mistakes fail loudly.** An unknown key (usually a typo), a value of the wrong type or one outside its allowed set stops startup, reload, a UI save and `tinywebui validate`, with every problem named. Nothing silently falls back to a default.

Admin decisions are recorded the same way. Approving, disabling or changing someone's role writes `access.users` in `tinywebui.config.json` before touching the database. The files outrank the database: delete the database and restart, and every approval and ban is still in force.

**A complete tier-3 setup:**

```js
// tinywebui.config.js: checked into git
export default {
  config: {
    authMode: 'trusted-header',
    trustedProxyCidrs: ['172.20.0.0/16'],
    baseUrl: 'http://gateway:8080/v1',          // your model gateway; users never see it
    apiKey: process.env.MODEL_GATEWAY_KEY,
    model: 'fast',
    systemPrompt: 'You are the team assistant…',  // frozen: set here, so read-only in the UI
    logoutUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/logout',
    access: {
      bootstrapAdmins: ['google-oauth2|1234567890'],
      newUsers: 'pending',
      roles: {
        user:  { features: ['chat', 'attachments', 'images', 'search', 'folders', 'model-picker'], models: ['fast', 'smart'] },
        admin: { features: '*' }
      }
    }
  },
  mcpServers: {                                    // frozen: users can use these tools, nobody can edit them
    search:  { url: 'http://tinysearch:8000/mcp' },
    context: { url: 'http://gateway:8080/context/mcp' }
  }
};
```

**Features** a role can have: `chat`, `attachments`, `images`, `search`, `folders`, `automations`, `statistics`, `model-picker`, `tools`, `settings`, `mcp`, `admin` (user management) and `oversight` (reading users' chats). Each one covers both the UI and the API routes behind it. The UI hides what a role lacks, and the server refuses it. Tier 3 defaults: users get everything except `tools`, `settings`, `mcp`, `admin` and `oversight`; admins get `*`. Tiers 1 and 2 get everything except user management.

**Edits apply without a restart.** Changes to `tinywebui.config.json` or `mcp.json` are picked up automatically, or on `kill -HUP`. A reload is all or nothing: a file that doesn't parse or validate is rejected (and logged), and the running config stays as it was. `tinywebui.config.js` and `authMode` need a restart.

**Commands for scripts and agents** (output on stdout is JSON or a single line; logs go to stderr):

```bash
tinywebui validate                  # "ok <fingerprint>", or every problem and exit code 1
tinywebui effective                 # what is in effect, and how each setting can change
tinywebui effective --role user     # exactly what a user can see and do
tinywebui users list                # users, with decisions pinned in the files
tinywebui users set <id> --status disabled   # recorded in tinywebui.config.json
tinywebui fingerprint               # hash of the effective config (secrets never included)
tinywebui schema                    # JSON Schema for the config (also in docs/config.schema.json)
```

**Deploying from scripts:** [docs/deploy.md](docs/deploy.md) walks through a complete container deployment: validate, migrate, doctor, start, and verify the running fingerprint. The image ships a `Dockerfile` with a `/readyz` health check, a read-only config mount, a `/data` volume, and secrets taken from the environment.

```bash
tinywebui migrate [--check]         # schema migrations as an explicit, repeatable step
tinywebui doctor                    # node, config, database, model endpoint, each MCP server
curl http://127.0.0.1:7777/readyz   # {"ready":true,"version":"…","fingerprint":"…"}
```

**Audit trail.**
- Every change is logged as an `[tinywebui:audit]` JSON line on stdout: config saves (who, which keys, the new values), MCP edits, reloads (accepted or rejected), and user decisions.
- Config, MCP and reload lines carry the config fingerprint before and after. The same fingerprint is printed at startup and shown in the Admin panel, so you can check that a running instance matches a given commit: `tinywebui fingerprint` on the checked-in files gives the same value.

## Security and limits

In tier 1, keep TinyWebUI bound to `127.0.0.1`. Use tier 2 or 3 before exposing it to a network. MCP servers run with the access you configure for them, so treat each configured server and its credentials as trusted infrastructure.

The app does not provide OCR, cloud synchronization, or branching chat history. Delete chats you no longer need; their associated documents and tool artifacts are deleted with them.

## Development

```bash
npm test
```

The test suite covers message serialization, cache behavior, compaction, tool routing, retries, chat editing, search, streaming/rejoin behavior, settings/tool management, password and gateway sign-in, and a tenant-isolation matrix in which one user attempts every route against another user's IDs.

## License

GNU Affero General Public License v3.0 or later ([AGPL-3.0-or-later](LICENSE)).
If you run a modified version for users over a network, you must offer them the
Corresponding Source for that version.

### Token attribution

Statistics saves a versioned, counts-only attribution snapshot in each assistant
request's `usage_json`: operator prompt, harness, MCP guidance, tool schemas (per
MCP server), conversation, resent reasoning, tool history/results, image
allowances, reasoning output, generated calls, intermediate text and final text.
Provider totals and reported reasoning counts are authoritative; everything else
uses the rough character/4 estimator (images count 1,500 tokens) and is marked
`~`. The gap to the provider total is kept as a signed delta, never rescaled.
Cache reads are a subset of input, not an extra component. Token views can be
filtered by model and drilled down from all time to a single day. Requests made
before this existed are not reconstructed.
