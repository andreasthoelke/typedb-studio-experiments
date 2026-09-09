# Neovim queries in TypeDB Studio

Open **http://localhost:1430/query?nvim=1**. This is Studio's normal Query page,
including the graph's Explorer, themes, search, zoom, layout, and fullscreen
controls. Neovim updates the latest **unpinned** query tab and runs the query.
Incoming results also refresh the fullscreen graph. Exit fullscreen to inspect or
edit the actual graph query, or use the rest of Studio.

The earlier dedicated `/viewer` implementation is preserved on
`feat/local-graph-viewer` at `78b4eff5`. The current implementation is on
`feat/nvim-studio-query`; `/viewer` redirects to `/query?nvim=1`.

## Everyday use in this Neovim setup

The configuration loader in `~/.config/nvim/plugin/ftype/typedb_graph.lua` loads
this repository's helper automatically. Restart Neovim to load the changes, or
source that Lua file and `~/.config/nvim/plugin/ftype/typedb.vim` in an existing
session.

- `<c-t>l` starts TypeDB and ensures the Studio bridge is running.
- `:TypeDBGraphOpen` starts the bridge if necessary and opens the browser. Keep
  that browser tab open for subsequent queries.
- Your `gep` and `geq...` read-query commands continue showing their normal
  floating text results and also send the same query to Studio.
- The `temp/schema_...` inspector also mirrors its generated query and database.
- `<c-t>L` stops TypeDB and the Studio job owned by this Neovim session.
- `:TypeDBGraphStart`, `:TypeDBGraphStop`, and `:TypeDBGraphLog` manage or show the
  Studio terminal separately. An already running bridge can be shared; stopping
  it from a Neovim session that did not start it leaves that process running.

Any query submission can start the bridge, so starting TypeDB with a particular
mapping is not required. Studio runs in a hidden Neovim terminal buffer. Startup
waits for the bridge; the browser shows a short auto-refreshing startup page while
Angular first compiles. Later query deliveries do not reload the browser.

Set `vim.g.typedb_graph_auto = false` to disable automatic mirroring while keeping
manual commands available. Set `vim.g.typedb_studio_path` before plugins load if
the repository moves.

Connect Studio once to the local TypeDB HTTP endpoint, typically
`http://localhost:8000`, and optionally save it as the startup connection. The
Neovim query's database is selected automatically. If Studio has an open
transaction in another database, close it first; the pending query waits.

**Keep using `localhost:1430`.** Browser storage belongs to the complete origin:
scheme, hostname, and port. `127.0.0.1:1430`, `localhost:1431`, and
`studio.typedb.com` each have separate saved connections, themes, and settings.
Changing the address does not migrate old browser storage.

## Graph context

The browser prepares a separate graph query; the query executed for Neovim's
text results is unchanged. A terminal `fetch` is removed so TypeDB returns
concept rows. No explicit `select` is needed for that conversion. Existing
`select`, sorting, filtering, and limit stages retain their ordering.

The **Neovim** menu is available beside the output controls and inside the
fullscreen graph. It provides:

- **Include linked neighbours**: enabled initially; adds at most one relation
  hop from an entity, including the relation's other role players. A selected
  relation instead includes its own role players.
- **Seed variable**: blank chooses the first eligible directly typed entity or
  relation variable, such as `$item`. Set it explicitly for queries with several
  possible starting points.
- **Relation types**: a comma-separated allowlist for entity-neighbour expansion.
  Blank includes all relation types. These labels are checked against the live
  schema. Selected relations still include their role players.
- **Apply to latest Neovim query**: saves the options locally and regenerates the
  query from the original received source. The resulting query is visible and
  editable in Studio's query field.

Expansion uses an optional pattern so isolated seed instances remain in the
result. Schema-panel queries use this same preparation function and configuration.
The Explorer initially selects individual instances; its existing `here` / type
selection toggle remains available. Existing Explorer and Elements controls can
inspect or alter the resulting graph. Explorer actions that query the database
still follow Studio's normal transaction controls.

This is deliberately one hop, with an explicit seed and optional relation filter.
It does not rank semantic relevance, recursively expand the neighbourhood, or
infer a seed through arbitrary nested patterns or functions. If no eligible seed
is found, the base graph query runs and the menu explains why expansion was
skipped. Aggregate pipelines are not expanded automatically and may have no
renderable instances. The pure preparation function in
`src/framework/util/graph-query.ts` can be reused by another integration later.

The default total answer limit is 1000, independently of any limit already in the
query. Preserving an existing limit before the added context bounds the seed
results; the overall answer limit can still truncate a large neighbourhood.

## Query lifecycle

`?nvim=1` enables receiving on the local Query page and remembers it for that
browser tab's session, including after connection setup or navigating away and
back. `?nvim=0` disables it. Ordinary Studio sessions are not enabled by default.
Each enabled browser tab executes incoming queries independently.

The latest unpinned query tab is reused. If all tabs are pinned, a new tab is
created. Pin queries you want to preserve. Studio's normal run history and output
handling apply, including its log/error display. A later Neovim query replaces
manual edits in the reused tab.

Incoming queries run in fresh **read transactions** through Studio's existing
execution and graph pipeline. They do not reuse or commit a manual transaction.
Schema changes, writes, batches, and function preambles are not automatically
mirrored; the initial scope is a single `match` pipeline. Pressing Studio's own
Run button still uses its normal transaction settings.

A running Studio query finishes before the next incoming query starts. While
waiting, only the latest incoming request is retained. There is no page reload;
the renderer lays out each new result again. This does not preserve node positions
across different result sets.

## Runtime and standalone setup

Use Node 22 (22.16 or newer) and the repository's pnpm 10.12.1:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm viewer:dev
```

The Neovim helper automatically uses `/opt/homebrew/opt/node@22/bin/node` when
available, falling back to `node` on PATH. Its `node` option can override this.
The bridge and Angular dev server stop together when their owning job stops.

For a static build without a development server:

```sh
pnpm build:viewer
pnpm viewer
```

Rebuild after changing source files. The build includes normal Studio and reuses
its renderer. No submodule source changes are involved in this integration.

To install the helper in another Neovim configuration (Neovim 0.10+ and curl):

```lua
local graph = dofile(vim.fn.expand('~/path/to/typedb-studio/contrib/nvim/typedb_graph.lua'))
graph.setup({ mapping = '<leader>tg', limit = 1000 })
-- In an existing read-query command, call graph.mirror(query, database).
```

`:TypeDBGraph` sends the whole buffer; a line range sends those lines. An optional
argument supplies the database, for example `:TypeDBGraph my_database`. The visual
mapping supports exact character, line, or block selections. Set `mapping = false`
to omit it (the automatic loader in this machine's configuration does so).

Database precedence is an explicit argument, `b:typedb_database`,
`g:typedb_database`, `g:typedb_active_schema`, then Studio's selected database.
An optional `url` setting changes the bridge origin.

## HTTP interface and maintenance

The small Node server uses built-in modules. Neovim posts JSON to
`http://localhost:1430/api/viewer/query`; the browser receives Server-Sent Events
at `/api/viewer/events`. No Vite/Angular hot-reload protocol is involved.

```json
{ "query": "your TypeQL query", "database": "my_database", "limit": 1000 }
```

`database` is optional. `limit` defaults to 1000 and must be an integer from 1 to
100000. The body may be up to 1 MiB. HTTP 202 with `{ "id": "...", "viewers": 1 }`
acknowledges queuing, not successful execution. `/api/viewer/health` reports the
service identity, listener count, and latest request ID.

Only the latest request is retained in memory and replayed when a browser
connects. Reloading an enabled page executes it again; reconnecting the stream
within the same page does not duplicate a request already received. Restarting
the bridge clears its retained query, and existing pages reconnect automatically.

`TYPEDB_VIEWER_PORT` changes port 1430; `TYPEDB_VIEWER_DEV_PORT` changes Angular's
internal port 1431. Both servers bind to the loopback interface; browser-facing
URLs use `localhost`. Update the helper's `url` when changing its port.

When updating Studio, install from the lockfile and run:

```sh
pnpm test:viewer
pnpm build:viewer
```

Tests cover transport, replay, validation, origin checks, static serving, proxying,
and query preparation. Also verify a real query while fullscreen, Explorer
selection, context options, and returning to the editor after a new result.
