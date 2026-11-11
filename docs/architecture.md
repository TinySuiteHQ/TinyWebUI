# Architecture

How TinyWebUI fits together, what it is built to survive, and how its pages
are laid out. [AGENTS.md](../AGENTS.md) is the file-by-file map and the
checklist for where new code goes; this page explains the shape behind it.

## The pieces

```
browser ── page (Vue, web/) ──HTTP/SSE──▶ server (Node, server/) ──▶ SQLite (one file)
                                              │
                                              ├──▶ the model API (any OpenAI-compatible endpoint)
                                              └──▶ MCP servers (tools)
                      shared/ ◀── imported by both sides
```

- **The server** is TypeScript that Node runs as is. `server.ts` wires
  everything; nothing else does.
- **The page** is Vue 3 built into `dist/`. The server serves it under a strict
  content security policy: only its own scripts, no inline code.
- **`shared/`** holds what both sides must agree on: the stream events, the
  feature names, the setting values, the wording the server writes and the
  page recognises (attachment notes), and the shapes of the API replies both
  read (`shared/api.ts`).

### A turn, end to end

1. The page posts the message to `/api/chat`. The route stores it, then hands
   the chat to `chat/runs.ts`, which keeps the turn running whether or not
   anyone is watching.
2. `chat/llm.ts` builds what the model sees: the stored history, trimmed by
   compaction, plus the system prompt, the folder's instructions and the
   person's own. The model-facing core in `harness/` runs the loop: it calls
   the provider, streams the reply, and runs tool calls through MCP.
3. Every event is stored as it happens and also broadcast. A viewer that
   arrives late (a reload, a second tab) replays the turn from the start and
   then follows it live. The page turns events into the transcript with one
   pure reducer (`web/src/model/turn_model.ts`). Stored history replays
   through the same reducer, so a reloaded chat looks exactly like the live one.

### Who may do what

The route table is also the permission table. Each route declares the feature
it needs, and a route without that decision does not compile. Every read of
someone's data names whose data it is (a scope). A read that forgets to throws,
so it cannot fall back to seeing everyone's.

### Where data lives

All SQL is in `server/store/`, one file per area: chats, messages, documents,
usage, automations, users. An area that needs another's data calls that area,
never its tables. Configuration lives in files rather than the database:
`tinywebui.config.json` for the deployment's shape, and the owner-only
`tinywebui.secrets.json` for keys.

A person's data leaves and comes back as a backup file (`server/transfer/`):
their chats with tool output and usage, folders, automations and preferences.
Uploaded files are not included. Import never overwrites anything. A chat
already there is skipped, so importing the same file twice changes nothing.

## What it survives

| When this happens | It does this |
| --- | --- |
| The server restarts mid-turn | The transcript so far is already stored. The history is repaired before the next request (a tool call left without its result). Queued messages persist; open questions expire; automation runs are recovered. |
| A stored value is damaged (a bad import, a disk error, a hand edit) | JSON columns are read with `parseColumn()`. A value that does not parse, or has the wrong shape, is left off; the chat still opens, still counts in Usage, and still takes a new turn. |
| The model provider goes quiet | A request silent for 5 minutes (`$TINYWEBUI_STREAM_STALL_MS`) is given up. Before the reply starts, it is retried; during the reply, the turn ends with an error, so the chat (or an automation nobody is watching) is never stuck. |
| A promise somewhere rejects without being awaited | It is logged as a bug and the server keeps running, instead of ending every turn and stream with it. |
| The server crashes or the disk fills while saving settings | Config, secrets and MCP files are written to a temporary file, then renamed over the old one. Each is replaced whole or not at all. |
| Two people (or a person and the config file) change settings at once | A Save sends only the keys that page changed. If someone else changed the same key in the meantime, the page names it and asks for a second Save before overwriting it. |
| The browser loses the stream | The page reopens the chat from the store and follows the turn again. |

## Page design

The page is a working tool, so it is laid out for finding a setting and
reading a number, not for looking busy.

### Settings: one setting per row

Each settings page is a column of rows. A row is one setting: its name and
one line on what it does (its unit, its range, what 0 means) on the left, and
its control on the right. Rows are grouped into plain sections with a heading,
split by a rule, not boxed into cards. Reading down the left edge lists every
setting on the page, the way system settings do.

Why this shape:

- **A name is next to its control.** In the older layout (two fields to a
  row, help text under each, every group in its own card), the eye had to
  zigzag across the page and the cards took more space than the settings.
- **Every setting looks alike.** A new setting is the same `<label>`, control
  and `<small>`, so there is nothing to design per page. The CSS does the
  layout, and on a phone the rows stack.
- **Groups follow what people come to change.** The most-changed group comes
  first, and rarely changed settings go last. A group of one setting is
  merged into its neighbour.
- **Save appears only when there is something to save.** The pages that share
  the settings draft (Models, Model defaults, Chat behaviour) show a bar at
  the foot with Discard and Save changes, only once something is edited. A
  Save that is always visible says nothing about whether anything changed. A
  page that saves on its own (Account, Appearance, Data) puts its button under
  the fields it saves.

The exact rules (class names, when a row may span the width) are in
[AGENTS.md](../AGENTS.md#page-design).

### Reports: totals, then detail

The Usage page reads from the top down:

1. A row of totals.
2. Usage over time: the one part you can drill into, by year, month and day.
3. Breakdowns in plain tables (numbers right-aligned).
4. Diagnostics, folded away until asked for: where the tokens went, and why
   the cache missed.

Charts use a fixed, colour-blind-checked palette (`--chart-1` to `--chart-8`),
never the theme's accent or its error red. A theme can make the accent black,
and red reads as "something is wrong".

### One of each

- **One header per panel, and only a header:** the title, sub-page tabs where a
  page has them, a save status and the close ×. The title matches the panel's
  entry in the rail. What the page itself does (a filter, its main action)
  opens its body, in a toolbar as wide as the content, so the bar along the top
  reads the same on every page.
- **One file viewer:** images and files open over the app (`FileViewer`,
  driven by `stores/viewer.ts`), never in a new tab:
  - an image at full size;
  - a PDF in the browser's own viewer, framed (that one response may be framed
    by the app itself, and only by it);
  - any other file as the text the model reads, with the original one
    Download away.

  The arrow keys step through the chat's other files.
- **One voice:** sentence case, no capitals or monospace for headings, money
  as money (`$0.0012`). A missing value is shown as `—`, with the reason given
  once in a note, not repeated on every tile.
