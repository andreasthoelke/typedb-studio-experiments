# Local graph viewer for Neovim

`/viewer` shows Studio's graph canvas, search, zoom, layout controls, and PNG export.
Queries arrive from Neovim without reloading the page. A small expandable panel in
the lower left provides connection setup, database selection, query text, and retry.

## Start

Use Node 22 (22.16 or newer) and the repository's pnpm 10.12.1:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm viewer:dev
```

Open **http://127.0.0.1:1430/viewer**. Use **Set up connection** to connect to
TypeDB's HTTP endpoint, typically `http://127.0.0.1:8000`. Studio returns to the
viewer after connection. Choose a database in the lower-left panel, or send the
database name with each query. Enable Studio's saved connection option if you
want it restored on the next browser load.

Connections saved on `studio.typedb.com`, `localhost`, or another port belong to
a different browser origin. Configure the connection once on this viewer's origin.

`viewer:dev` runs the bridge and Angular dev server together. It prints the URL
before Angular finishes compiling; wait for the build to finish before opening
the page. Ctrl-C stops both processes. It can run in a Neovim terminal buffer.

For everyday use without a development server:

```sh
pnpm build:viewer
pnpm viewer
```

Rebuild after changing source files. `build:viewer` uses Studio's local Angular
configuration. It builds Studio, including the viewer; it does not extract or
duplicate the renderer.

If your system Node version is unsuitable, an isolated runtime also works:

```sh
npm exec --yes --package=node@22 -- pnpm viewer:dev
```

## Neovim

Requires Neovim 0.10+ and `curl`. Add this to your configuration, adjusting the path:

```lua
dofile(vim.fn.expand('~/path/to/typedb-studio/contrib/nvim/typedb_graph.lua')).setup({
  mapping = '<leader>tg',
  limit = 1000,
})
```

- Visually select TypeQL and press `<leader>tg`. Character, line, and block
  selections are supported; the helper leaves your registers untouched.
- `:TypeDBGraph` sends the entire buffer.
- `:'<,'>TypeDBGraph` sends the selected **lines**. Use the visual mapping for an
  exact character selection.
- `:TypeDBGraph my_database` sends the buffer to a specific database. The same
  optional argument works with a line range.
- `:TypeDBGraphOpen` opens the browser. Keep that tab open for subsequent queries.

Database precedence: command argument, `vim.b.typedb_database`,
`vim.g.typedb_database`, then the database selected in the viewer.

```lua
vim.b.typedb_database = 'my_database'
```

For an existing mapping or query runner, call the module's `send(query, database)`
function directly. Set `mapping = false` to omit the default visual mapping.
An optional `url` setting changes the bridge origin.

The Neovim notification confirms that the bridge accepted the query. Execution
results and TypeDB errors appear in the browser.

## HTTP interface

Send a UTF-8 JSON body to `POST /api/viewer/query`:

```json
{
  "query": "your TypeQL query",
  "database": "my_database",
  "limit": 1000
}
```

`database` is optional. `limit` defaults to 1000 and must be an integer between
1 and 100000. The request body may be up to 1 MiB. The response is HTTP 202 with
`{ "id": "...", "viewers": 1 }`; this acknowledges delivery/queuing, not successful
TypeDB execution. `GET /api/viewer/health` reports viewer count and latest request ID.

`GET /api/viewer/events` is the browser's SSE stream. The bridge remembers only
the latest request, in memory, and replays it on connection. Opening or reloading a
viewer runs that latest query. Reconnecting an existing viewer does not rerun an
already received request. Each open viewer tab executes queries independently.
Restarting the bridge clears its retained query; existing tabs reconnect automatically.

Set `TYPEDB_VIEWER_PORT` to change port 1430 and `TYPEDB_VIEWER_DEV_PORT` to change
Angular's internal development port 1431. Both servers bind to `127.0.0.1`.
Update the Neovim helper's `url` if you change the viewer port.

## Query and rendering behavior

- Queries run in fresh **read transactions** using Studio's TypeDB HTTP driver.
  The viewer does not reuse or commit an open Studio transaction. Write/schema
  queries are rejected by TypeDB's read transaction rules.
- Send a single query returning concept rows, normally a `match` query with an
  optional `select`. Fetch/document results cannot be rendered by this graph builder.
- A new result replaces the previous graph. The old graph remains visible while
  the query runs and if the query fails or returns an unsupported result type.
  A successful empty result clears the graph and shows “No answers”.
- The latest submitted query wins. Older results are ignored; superseding a
  request does not guarantee cancellation of work already running on TypeDB.
- The browser page and event stream stay mounted. Nodes are laid out again for a
  new result; preserving positions across result sets is a possible later refinement.
- Studio's larger side panel, database exploration context menu, and fullscreen
  button are omitted on `/viewer`. Other Studio pages retain their existing behavior.

## Maintaining this alongside Studio

The viewer lives in `src/module/viewer`; the bridge is `scripts/viewer-server.mjs`
and needs only Node built-ins. The integration changes are a lazy `/viewer` route,
a `canvasOnly` canvas input, an independent read-query driver method, and a return
destination for connection setup. The graph engine, layout, and controls are reused.
No submodule source changes are required.

When bringing in Studio updates, update submodules to the commits recorded by the
new parent revision, install with the lockfile, and run:

```sh
pnpm test:viewer
pnpm build:viewer
```

The bridge tests cover live delivery, replay, payload validation, origin checks,
static serving, and development proxying. Also check the viewer with a real query,
search/zoom/export, an invalid query, and two quick successive submissions when
updating Studio's renderer or TypeDB driver.
