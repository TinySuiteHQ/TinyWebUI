# TinyWebUI

An ultralight chat UI. You bring the hosting (OpenRouter, OpenAI, Groq, Ollama — anything
OpenAI-compatible), your system prompt, and your MCP servers. TinyWebUI brings a chat box
and a tool loop. That's the whole product.

- One npm dependency (the MCP SDK). No build step, no bundler, no database.
- Server-side agentic loop: the model can call your MCP tools and keep going.
- Prompt caching is on by default and shaped so the prefix actually hits.
- Context compaction keeps long research chats from growing without bound, without
  breaking the cache or losing anything.
- ~700 lines total. Read all of it in ten minutes.

## Run

```bash
npx tinywebui
# or, from this directory
npm install && npm start

# restarts on changes under src/ and bin/
npm run dev
```

Editing anything in `public/` needs only a browser refresh — it is served straight
from disk, with no build step.

Then open http://127.0.0.1:7777.

Flags: `--port 7777`, `--host 127.0.0.1`.

## Configure

Everything lives in `tinywebui.config.json` in the directory you run from
(override with `$TINYWEBUI_CONFIG`):

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-...",
  "model": "anthropic/claude-sonnet-5",
  "systemPrompt": "You are a terse, precise assistant.",
  "maxToolRounds": 12
}
```

`apiKey` also reads from `$TINYWEBUI_API_KEY` or `$OPENROUTER_API_KEY`, `baseUrl` from
`$TINYWEBUI_BASE_URL`, `model` from `$TINYWEBUI_MODEL`. Env wins over the file.

`maxToolRounds` caps how many rounds of tool calls a single message may trigger (default
12) — raise it for deep research, lower it to bound spend. Spending the budget does not
abandon the turn: the next request goes out with `tool_choice: "none"` and a note telling
the model to answer from what it has and say what it could not determine. The tool block
itself stays in the request, so the cached prefix survives.

`temperature` and `maxTokens` are optional and unset by default — leave them out and the
provider's own defaults apply. That matters most for `maxTokens`: pinning it truncates
replies on models that would happily write more.

`cacheTtl` controls Anthropic cache lifetime: `"5m"` (default) or `"1h"`. The longer TTL
costs more on the cache-write turn but survives pauses in long research sessions.

`compactThreshold` (default 60000), `keepTurns` (2) and `maxInlineChars` (40000) control
context compaction — see below. `dbPath` sets where conversations are stored (default
`tinywebui.db` next to the config, or `$TINYWEBUI_DB`).

The Settings panel edits the model, system prompt, temperature, max tokens, max tool turns
and the compaction knobs, and writes them back to the config file. The API key is
server-side only — the browser never sees it.

### MCP servers

MCP wiring lives in its own `mcp.json` next to the config (override with `$TINYWEBUI_MCP`),
in the same shape Claude Desktop uses:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "tinysearch": {
      "url": "http://127.0.0.1:8000/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

The Settings panel edits this file directly. **Save & reconnect** validates it, writes it,
then swaps the whole hub — old child processes are shut down before the new ones start, so
you can add or rename a server without restarting TinyWebUI. A file that does not parse is
rejected before anything is written.

`command` + `args` (+ optional `env`, `cwd`) for stdio;
`url` (+ optional `headers`, `"transport": "sse"`) for remote. Add `"disabled": true` to
park one. Tools are exposed to the model as `server__tool`; connection failures are
reported in the header instead of killing startup.

## Prompt caching

`tiny` is meant to apply to the bill too, so the whole design point is that nothing
is re-paid for that does not have to be.

Provider caches reuse a matching rendered prompt prefix, so most of the work is keeping
the semantic request prefix stable between turns. TinyWebUI also serialises its own message
shape deterministically, which makes regressions easy to test and avoids accidental churn:

- The system prompt is built the same way every request — one message, never reordered.
- MCP servers and their tools are sorted, so the tool block is stable across restarts.
- History is append-only within an epoch; see **Context compaction** below for the one
  place it is rewritten, and why that is once rather than every turn.
- Tool results go back verbatim, so a tool round extends the prefix instead of breaking it.
- Reasoning text is **not** sent back. It is kept locally so the transcript can replay it,
  but DeepSeek documents that `reasoning_content` must not be returned and every other
  provider simply bills for it. Only Anthropic's structured `reasoning_details` is echoed,
  because a follow-up tool request is rejected without it.

Provider-specific handling sits on top of that stable prefix:

- **OpenRouter:** every conversation gets a stable `session_id`, so sticky routing starts
  after the first successful request instead of waiting for OpenRouter to observe a cache hit.
- **Claude on OpenRouter:** TinyWebUI uses top-level automatic `cache_control`, which advances
  to the last cacheable block as the agent loop grows. This is important after client-side
  tool results, where a text-only explicit breakpoint cannot move past a tool message.
- **Claude/Nova portable fallback:** explicit system + rolling content breakpoints remain in
  the request. If `extraBody.provider` explicitly routes OpenRouter to particular providers,
  automatic Claude caching is withheld so Bedrock/Vertex-style routes remain eligible.
- **Alibaba explicit-cache models:** the currently supported Qwen models and
  `deepseek/deepseek-v3.2` get explicit content breakpoints on OpenRouter.
- **Gemini on OpenRouter:** explicit content breakpoints are emitted as well; implicit caching
  still benefits from the stable prefix where the selected Gemini endpoint supports it.
- **OpenAI, DeepSeek and other implicit-cache providers:** no provider-specific marker is
  required; keeping the prefix and tool block stable does the work.

Token, cache-read and cache-write counts show under each round, and are stored with the
message, so reopening a conversation still shows what it cost and how much came back from
cache. OpenAI/OpenRouter-style `prompt_tokens_details`, Responses-style
`input_tokens_details`, Anthropic cache fields and DeepSeek cache-hit fields are normalized
for display.

Caching is on by default and deliberately not in the UI, since there is no reason to turn
it off; set `"cache": false` in the config file if you ever need to.

## Context compaction

Caching makes a long conversation cheap to re-read. It does nothing about the fact that it
keeps growing. Tool results are the reason: a single page scrape is several thousand tokens,
and a handful of research turns will put a six-figure prompt on every subsequent message.

Compaction and caching pull against each other — shortening history means rewriting the
prefix, and a rewritten prefix is a cache miss. Dropping the oldest turns each turn is the
worst of both: it breaks the cache on *every* request and never caches anything. So the
rewrite happens rarely and then stops.

**Every tool result is stored whole** in SQLite as an artifact, whatever tool produced it.
**When a request's prompt crosses `compactThreshold`**, tool results older than the last
`keepTurns` user messages are replaced — once — by a short stub, and the new prefix is
frozen. From then on it rebuilds byte-identically and caches again. One miss buys many
cheap turns.

A stub keeps the head and tail of the output verbatim, a generic shape hint, and the
artifact id:

```
[compacted: artifact 096111aa · tinysearch__search · 8,593 chars · tags: result×20, title×20, url×20]
<search_results>
<item index="1" status="ok">
…
… 7,709 chars elided …
…
[Full output retained. Read it with context_expand("096111aa", grep=... or offset/limit).]
```

Nothing is lost. The **transcript still shows the full output** — only what the model is
sent shrinks — and the model can read any of it back with `context_expand`, a built-in tool
that greps or pages through the stored artifact.

Two properties this depends on, and neither is negotiable:

- **Deterministic.** A stub is a pure function of the artifact: no model call, no timestamp,
  no counter. It is also stored rather than recomputed, so editing the digest later cannot
  disturb an already-frozen prefix. An LLM-written summary would compress better and break
  this.
- **Tool-agnostic.** Tool output is an opaque blob from an arbitrary MCP server. Nothing in
  this layer knows a tool's name or schema; the only structure inferred is generic — JSON,
  XML-ish, or neither. It works the same for a tool added tomorrow.

There is also a safety valve: a single result larger than `maxInlineChars` is stubbed the
moment it arrives, so one oversized page cannot blow the window before a threshold is
reached. Stubbing on arrival is an append, not a rewrite, so it costs no cache at all.

Measured on a four-message research conversation that previously reached ~156k tokens:
65% of tool text kept off the wire, each turn starting under 10k instead of climbing past
60k, near-total cache hits within an epoch and a single miss at each boundary — with the
model calling `context_expand` on its own to recover figures it needed from a compacted
result.

Set `"compactThreshold": 0` to turn it off and go back to unbounded append-only history.

### Routing

A prompt cache lives on one upstream provider. TinyWebUI now sends the chat id as OpenRouter's
top-level `session_id` on every request. That gives a multi-round agent a stable sticky-routing
key from its first successful request and avoids needless cold-provider hops.

The earlier provider-pinning experiment on `deepseek-v4-flash` showed why routing matters:

```
unpinned          call 1 Relace     cached 0
                  call 2 NextBit    cached 0
                  call 3 StreamLake cached 0

pinned Fireworks  call 1 Fireworks  cached 0     (cold, unavoidable)
                  call 2 Fireworks  cached 2486  (of 2487)
                  call 3 Fireworks  cached 2486
```

Manual provider pinning is still available through `extraBody`, but it is now an explicit
override rather than the default recommendation:

```json
"extraBody": {
  "provider": { "order": ["Fireworks", "DeepInfra"], "allow_fallbacks": true }
}
```

OpenRouter's provider routing preferences take precedence over ordinary sticky routing, so
use them when endpoint choice matters more than letting `session_id` keep the warm route.
`extraBody` remains a plain passthrough for any other gateway-specific knob. Providers
differ in cache quality even when pinned, so measure rather than assume. Cached tokens over
three identical calls, prefix 2487 tokens:

| provider    | call 1 | call 2 | call 3 |
|-------------|--------|--------|--------|
| Fireworks   |   2486 |   2486 |   2486 |
| DeepInfra   |   2304 |   2304 |   2304 |
| SiliconFlow |   2304 |   2304 |   2304 |
| Novita      |   2048 |   2304 |   2048 |
| Together    |      0 |   2486 |   2486 |
| Baidu       |      0 |   2048 |      0 |
| CoreWeave   |      0 |      0 |      0 |

CoreWeave reports no cache at all on this model, and also serves it at 256k context rather
than 1M — worth checking both before pinning anything.

### Gateways that refuse things

`cache_control`, `tool_choice` and `stream_options` are optional, and OpenAI-compatible
endpoints vary in which they accept. None is worth failing a turn over, so a 4xx naming one
causes it to be dropped and the request retried, with a note in the transcript. What was
refused is remembered for the rest of the turn rather than re-probed every round.

## Limits

Single-user. Conversations live in a local SQLite file, which holds every tool result in
full and so grows faster than the context window does — delete chats you are done with. No
auth — bind it to localhost or put your own proxy in front. No image or file upload yet.

Transcripts written by an earlier version are imported from `localStorage` on first load.
