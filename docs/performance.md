# Page performance

What the page costs a browser. The latest measurement comes first; the one below it is the baseline from the move to Vue 3 + Vite. A change to how the transcript renders or streams is worth measuring again the same way.

## 2026-11-12: marked, chat titles, the queue

Measured `ef50921` (the "after" of the entry below) against `post-update-optimizations` after `1617979` (with the change below), the same way as below. The browser was Playwright's headless Chromium 158, driven from WSL Ubuntu with Node 22.23, so the absolute figures are not comparable with the table below (headless Edge on Windows); the two columns here are. Both builds used the current `node_modules`. Three runs per build, alternating.

Since the entry below, markdown is read by `marked` (CommonMark and GFM), because the hand-rolled reader kept getting the list shapes models write wrong. The other changes were chat titles, the message queue, error rows, the library dialog and the sidebar's menus moving onto `Popover`.

One problem turned up and was fixed: `marked` writes a newline after every block tag. Each one became a blank text node, 567 for this answer, which took the reopened chat from 2,001 DOM nodes to 2,563. `renderToken` in `core/md.ts` now drops them (text and code are escaped, so `>` and `<` with only newlines between them are always two tags).

| | `ef50921` | Now |
| --- | --- | --- |
| First load: JS and CSS sent (cold cache) | 84 kB in 3 files | 100 kB in 3 files |
| First load: JS and CSS decoded | 314 kB | 374 kB |
| First load: JS decoded | 215 kB | 272 kB |
| Streaming: JavaScript | ~42 ms | ~43 ms |
| Streaming: style recalculation | ~123 ms | ~131 ms |
| Streaming: layout | ~134 ms | ~145 ms |
| Streaming: all renderer tasks | ~1,220 ms | ~1,290 ms |
| Streaming: long tasks (over 50 ms) | 0 | 0 |
| Reopening the chat until its answer is on screen | ~265 ms | ~300 ms |
| DOM nodes, chat reopened | 2,001 | 1,993 |
| JS heap, chat reopened | 3.3 MB | 4.3 MB |

What the new reader costs: the 57 kB of JavaScript, in the first-load chunk because every chat needs it, and about 1 MB of heap (the library, plus the tokens `blocks()` keeps so a streaming answer is read again only from its last blocks). Streaming costs about 6% more. Reopening varied by ±40 ms between runs on this machine, so treat its difference as approximate. If first load matters more than the first answer, `marked` could be loaded only once a chat has text to show.

How: a Node script with `playwright-core` started each build's server in process (`start()` from `server/server.ts`, a fresh database, lexical retrieval) against a fake provider streaming the same 11 kB answer (30 sections, each a heading, a paragraph, a list, a code block and a table) in 40-character chunks every 12 ms. The CDP readings were as below. First-load files are those whose request started before the composer appeared, timed in the page by a `MutationObserver`, so the idle prefetch of the split pages that follows is left out. Reopening was timed from `about:blank` until the answer's last heading was on the page.

## 2026-11-10: compression, split pages, markdown block by block

Measured `c5369b2` (before) against the working tree with these changes (after), on Windows 11 with headless Edge at 1440×900. Both servers ran under WSL from their own fresh database, with the same fake provider streaming the same 11.7 kB markdown answer (30 sections, each a heading, a paragraph, a list, a code block and a table) in 40-character chunks every 12 ms. Three runs per build, alternating; they agreed within a few percent, and the table gives typical values.

What changed:

- **Compression.** The server compresses its own files (brotli at the strongest setting, or gzip; each made once and kept in memory) and JSON replies over 8 kB (at a fast setting, per request). It also stopped reading and hashing every file from disk on every request. And the year-long `immutable` cache meant for `assets/` now applies: a leading slash had kept every asset at `no-cache`.
- **Split pages.** The settings sections, Files, MCP and the file viewer are their own chunks (`web/src/app/lazy.ts`), fetched on first open or once the browser is idle, and mounted only once opened.
- **Markdown block by block.** `chat/Markdown.vue` renders one element per top-level block and reuses the HTML of the blocks already rendered (`renderBlocks` in `core/md.ts`). While an answer streams, a frame re-renders the block being written, and the DOM of the finished ones is left alone.
- **Off-screen turns.** Finished turns and questions use `content-visibility: auto`, so a long chat's layout and paint scale with what is on screen.

| | Before | After |
| --- | --- | --- |
| First load: JS and CSS sent (cold cache) | 444 kB in 2 files | 82 kB in 3 files |
| First load: JS and CSS decoded | 444 kB | 306 kB |
| First load: JS decoded | 347 kB | 210 kB |
| Streaming: JavaScript | ~56 ms | ~47 ms |
| Streaming: style recalculation | ~430 ms | ~111 ms |
| Streaming: layout | ~720 ms | ~111 ms |
| Streaming: all renderer tasks | ~2,510 ms | ~900 ms |
| Streaming: long tasks (over 50 ms) | 0 | 0 |
| Reopening the chat until its answer is on screen | ~167 ms | ~135 ms |
| DOM nodes, chat reopened | ~5,700 | ~2,170 |
| JS heap, chat reopened | 3.4 MB | 2.9 MB |

Most of the DOM that went is the settings sections, Files and MCP, which were mounted hidden from the start. Streaming used to replace the whole answer's DOM every frame, so style and layout grew with everything already written; now they follow the block being written.

How: a PowerShell script drove headless Edge over the Chrome DevTools Protocol (`Performance.getMetrics` before and after the turn, `HeapProfiler.collectGarbage` before memory readings, a `longtask` PerformanceObserver). First-load figures are Resource Timing's `transferSize` and `decodedBodySize` for scripts and stylesheets after `Network.clearBrowserCache`, read when the composer appeared (before the idle prefetch of the split pages). The before build was the commit's `git archive`, built and served on its own.

## 2026-11-08: plain JS against Vue

Measured `main` at `05f50a0` (the plain-JS page) against `53e80bb` (the Vue page), on macOS 27.2 with Node 26.10 and Chromium (Playwright) at 1440×900.

### Results

#### Download

| | Plain JS | Vue |
| --- | --- | --- |
| Page code (JS, CSS, HTML; no themes or icons) | 384 kB in 32 files | 351 kB in 3 files |
| Gzipped | 120 kB | 106 kB |
| Requests to open a chat | 42 | 12 |

The Vue page is smaller although it carries the Vue and Pinia runtime: it is minified, and the plain-JS page was served as commented source. The server sent files uncompressed then (it compresses them since 2026-11-10); a reverse proxy that gzips got the second row.

#### Opening a long chat

A chat of 15 turns (43 stored messages, 246 kB of text: long answers with headings, tables and code, and web searches with their tool results).

| | Plain JS | Vue |
| --- | --- | --- |
| Until the chat is on screen | ~203 ms | ~115 ms |
| DOM nodes | 7,213 | 3,744 |
| Layout | 58 ms | 14 ms |
| Style recalculation | 16 ms | 11 ms |
| JS heap | 2.6 MB | 5.1 MB |

The DOM is half the size because the activity drawer (reasoning, tool calls and their results) mounts nothing until it is opened. The plain-JS page could not open a chat from the address, so its time includes a click in the sidebar; read the two times as approximate.

#### Streaming an answer

The same 2.2 kB answer, streamed over about 6.3 s, into the chat above.

| | Plain JS | Vue |
| --- | --- | --- |
| JavaScript | 139 ms | 26 ms |
| Style recalculation | 238 ms | 149 ms |
| Layout | 198 ms | 198 ms |
| All renderer tasks | 1,180 ms | 1,185 ms |
| Long tasks (over 50 ms) | 0 | 0 |

Events are applied once per animation frame instead of once per token, which is where the JavaScript time went. Layout and paint dominate either way, so total renderer time is unchanged: streaming was cheap before and still is.

#### Server

About 130 MB resident for both, at idle with no MCP servers. The server barely changed in the port.

### The trade-off: JS memory

The Vue page holds more JavaScript memory:

| | Plain JS | Vue |
| --- | --- | --- |
| Empty chat | 1.8 MB | 3.1 MB |
| Added by the chat above | 0.75 MB | 2.0 MB |

The first row is the Vue runtime. The second is the transcript kept as data (`web/src/model/turn_model.ts`): every answer and tool result is held as text in the model, where the plain-JS page kept most of it only in the DOM. DOM memory is not part of the JS heap, and the Vue page has about 3,500 fewer nodes for this chat, so the total is likely closer than the heap suggests; that total was not measured.

If memory per chat matters, the first things to try:

- keep tool results out of Vue's reactivity (`markRaw`): they are only read when a step is opened;
- drop the rendered markdown of settled answers that are off screen.

### How it was measured

- **Provider:** a fake OpenAI-compatible endpoint that streams fixed text, so both builds receive identical answers at identical pace and no API is billed. The long chat itself was produced once against a real model and copied, so both builds open the same rows.
- **Servers:** each build on its own copy of that database (`TINYWEBUI_DB=<copy>`), with no MCP servers and lexical retrieval. The older build ran from a `git worktree` of `main`.
- **Readings:** Chrome DevTools Protocol `Performance.getMetrics` (`JSHeapUsedSize`, `Nodes`, `LayoutDuration`, `RecalcStyleDuration`, `ScriptDuration`, `TaskDuration`). The page was loaded from `about:blank`, `HeapProfiler.collectGarbage` ran before each memory reading, and streaming figures are the difference between readings taken just before sending and just after the turn ended. Long tasks came from a `PerformanceObserver` for `longtask`.
- **Repeats:** opening was measured four times and streaming twice per build; repeated runs agreed within a few percent, and the tables give typical values.
- **Download:** file sizes of the served page code, raw and `gzip -9`; request counts from the Resource Timing API.
