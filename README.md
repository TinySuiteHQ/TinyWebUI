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

Any OpenAI-compatible endpoint works. For a local runtime, point `baseUrl` at it and
leave `apiKey` out — no `Authorization` header is sent when there is no key, and none of
the OpenRouter-specific request fields or ranking headers go to a non-OpenRouter host:

```json
{
  "baseUrl": "http://localhost:8080/v1",
  "model": "qwen3-coder-30b-a3b-instruct",
  "maxToolRounds": 12
}
```

`apiKey` also reads from `$TINYWEBUI_API_KEY` or `$OPENROUTER_API_KEY`, `baseUrl` from
`$TINYWEBUI_BASE_URL`, `model` from `$TINYWEBUI_MODEL`. Env wins over the file.

`maxToolRounds` caps how many rounds of tool calls a single message may trigger (default
12) — raise it for deep research, lower it to bound spend. One round is one reply that
calls tools, however many calls it makes at once.

The model is told its budget rather than left to discover it. Every request carries a
short note: the full budget and what a round is on the first, a remaining count on each
one after, and from two rounds left a warning to stop broadening and get ready to answer.
Spending the budget does not abandon the turn — the next request goes out with
`tool_choice: "none"` and a note telling the model to answer from what it has and say what
it could not determine. The tool block itself stays in the request, so the cached prefix
survives.

That note is appended **after** the last message and never written to the store, which is
what makes a per-round counter free. Written into the conversation it would sit inside
every later prefix, and because the count changes each round it would move the divergence
point back to wherever the note was and throw the cache away from there on. At the tail it
is outside every future prefix instead: the next round rebuilds history from the store, so
the previous note is simply not in it, and the two requests still share every byte of real
history.

`temperature` and `maxTokens` are optional and unset by default — leave them out and the
provider's own defaults apply. That matters most for `maxTokens`: pinning it truncates
replies on models that would happily write more.

`cacheMode` (default `"auto"`) picks the cache dialect from the endpoint and model; see
**Prompt caching**. `cacheTtl` controls Anthropic cache lifetime: `"5m"` (default) or `"1h"`. The longer TTL
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

That first layer is the whole story on most setups. Every local runtime worth using —
llama.cpp, Ollama, vLLM, LM Studio — caches on prefix match with no request field
involved, as do OpenAI, DeepSeek and Gemini. Nothing provider-specific is sent to any of
them, and nothing needs to be.

The second layer is for the gateways that bill cache writes separately and want to be
told where to write. That is a wire dialect of the *endpoint*, not a property of the
model, so TinyWebUI only speaks it where it has reason to believe it is understood:

- **OpenRouter** gets a stable `session_id` per conversation, so sticky routing starts
  after the first successful request rather than waiting for a cache hit to be observed.
  It is not sent anywhere else — an unknown key is a 400 risk on a strict server, for a
  field that would do nothing.
- **Claude on OpenRouter** uses top-level automatic `cache_control`, which advances to the
  last cacheable block as the loop grows. This is the only shape that keeps caching across
  client-side tool results; a text-only breakpoint cannot move past a tool message.
- **Anthropic-style breakpoints** (system + rolling content markers) are used for the
  Claude/Nova families only, matched at the family level so a new release is not a code
  change. Pinning `extraBody.provider` switches Claude from automatic to these, keeping
  Bedrock/Vertex-style routes eligible. Qwen, DeepSeek and Gemini deliberately do *not*
  get them: a marker turns the marked message's content into an array and the rolling
  breakpoint unwraps it again the next round, which Anthropic ignores when prefix-matching
  but a gateway matching the serialised request reads as a byte change mid-prefix — losing
  every hit after it. Those families cache the prefix automatically, so layer 1 is strictly
  better.
- **Anything else — including every localhost or LAN endpoint — gets layer 1 only.** Markers
  there are pure downside: array-shaped content is exactly what strict OpenAI-compatible
  servers reject, and they buy nothing on a backend that already caches the prefix itself.
  The endpoint decides this, not the model name, so a GGUF repack that kept its upstream
  name is still treated as local.

`cacheMode` in the config overrides the guess when TinyWebUI has not been taught about your
gateway: `"auto"` (default), `"implicit"` (layer 1 only), `"explicit"`, `"rolling"`, `"off"`.

Token, cache-read and cache-write counts show under each round, and are stored with the
message, so reopening a conversation still shows what it cost and how much came back from
cache. OpenAI/OpenRouter-style `prompt_tokens_details`, Responses-style
`input_tokens_details`, Anthropic cache fields and DeepSeek cache-hit fields are normalized
for display.

Caching is on by default; on an unrecognised or local endpoint that costs nothing and
changes nothing about the request. Set `"cache": false` (or `"cacheMode": "off"`) to stop
all of it.

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

A later measurement showed that a *list* of providers is barely better than none. With
`order: ["Fireworks", "DeepInfra"]` and fallbacks off, OpenRouter still picks freely between
the two, and half the rounds flip:

```
order [Fireworks, DeepInfra]   r0 Fireworks -> r1 DeepInfra  cached 4608/4834  (flip)
                               r0 Fireworks -> r1 Fireworks  cached 4912/4913  (100%)
                               r0 DeepInfra -> r1 Fireworks  cached    0/4924  (flip, cold)

order [Fireworks] only         r0 Fireworks -> r1 Fireworks  cached 4912/4913  (100%)
                               ... with a trailing budget note  cached 4923/4924  (100%)

order [DeepInfra] only         r0 DeepInfra -> r1 DeepInfra  cached 4608/4834  (ceiling)
```

Three things fall out of that. A flip costs the whole cache, because each provider keeps its
own. The providers tokenize differently, so the same messages bill 4899 tokens on one and
4834 on the other — which is why a jittering `in` count is itself a routing symptom. And
DeepInfra caps its cached prefix around 4608 tokens, so even a stable DeepInfra route only
ever partly hits. **Pin to exactly one provider**, or accept that the cache is a coin flip.

Pinning has a cost the cache numbers do not show: one provider's rate limit becomes the
whole budget. A transient refusal — 429, 408, 5xx, or a dropped connection — is now retried
with backoff (honouring `Retry-After`) instead of ending the turn, and a pin that has been
refused twice is released so the remaining attempts can be served anywhere. A cold cache is
worth far more than a lost turn, and a provider rate-limited on a shared pool is usually
limited for longer than any backoff worth sitting through. A 4xx that is not transient is
still fatal on the first try: a bad request will not get better.

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

Any question in the transcript can be rewritten. Hovering it reveals **edit** and **retry**:
edit opens it in place, retry resubmits it unchanged. Both rewind the conversation to that
question — everything after it, answers and follow-ups alike, is dropped — and run forward
again. There is no second branch kept to switch back to; the old answers are gone, which is
also the only honest thing to do with answers to a question that no longer exists. Rewinding
is the one operation that deliberately breaks the append-only rule, so it costs the prompt
cache from the edited message onward, and a compaction boundary caught inside the cut is
cleared with it. An edit is refused while that chat is still working — stop it first.

A turn belongs to the server, not to the tab that started it. Closing the window, reloading
or losing the connection detaches a viewer; the run keeps going and writes its answer to the
store either way. Reopening the chat replays the settled part of the transcript and rejoins
the live event stream for the rest, and the sidebar shows a dot against any chat still
working. `POST /api/chats/:id/stop` is how you actually mean it — the send button becomes
`stop` while a turn is in flight.

Transcripts written by an earlier version are imported from `localStorage` on first load.
