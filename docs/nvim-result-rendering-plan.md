# Complementary Neovim float and Studio graph

Implemented 2026-09-20 on the personal local fork. The user confirmed that the
**local bridge owns execution**, including when no browser is open.

This replaces the recovered proposal from 2026-09-19. That proposal was rebuilt
from HTTP API probes after the planning session was lost; its observations about
TypeDB's response shapes remain useful, but its suggested retry and formatter
architecture have been revised below.

## What runs and what each surface shows

`gep`, `gee`, the evaluation operator, and other commands which call
`Tdb_runQueryShow` keep their existing ranges. A small adapter prepares the same
paragraph (including the existing undefine transformation), then sends it to
`POST /api/viewer/run`. The bridge signs in to TypeDB's HTTP API and runs the
statement once. Writes/schema operations commit in that single request; reads
use a read transaction. Neither Neovim nor a following browser re-executes it.

The result contains the submitted query, database, connection origin, execution
outcome, structured API response, optional graph context, elapsed time and
formatted float lines. The same ID ties together the HTTP return and SSE event.

| Statement/result | Neovim float | Initial Query graph |
| --- | --- | --- |
| Concept rows, including inserts | Aligned variable columns; values or type + short IID | Those exact answer rows and their query structure |
| Flat fetch with consistent keys | Table | Separate read of the pipeline before fetch, explicitly labelled |
| Nested/heterogeneous fetch | Pretty JSON | Same bounded fetch-context rule |
| Define, including an identical repeat | Committed/OK and current schema table | Same separate schema-context answer |
| Failed write with resolvable typed variables | Original error and current-data table | Same current-data context answer |
| Empty successful read | `0 rows` | Empty graph, replacing the previous result |
| Lost/invalid TypeDB response | Outcome unknown; inspect before running again | Previous graph retained, with an explanatory status |

The context table is **not proof that a duplicate insert already exists**. It
matches referenced types and literal ownership values, preferring identifier-like
fields when present. It does not reconstruct arbitrary update/delete pipelines,
function logic or anonymous relations. If it cannot derive or execute a context
read, the original result/error survives and reports the context limitation.
Schema context currently recognises declared entity/relation/attribute labels;
function-only and some undefine/error paragraphs have no derived context.

The original error's first line and caret excerpt stay visible; raw JSON retains
the full error chain. Cells elide after 72 display columns, with complete values
retained in raw JSON. Within a result float:

- `gr` or `<leader><leader>r`: raw result JSON, including errors, query structure and context.
- `gt` or `<leader><leader>t`: return to the formatted table/result.
- `gq` or `<leader><leader>q`: the executed statement and any separate context query.
- `I` / `Y`: next / previous table column, keeping the same row. Column bounds
  come from the divider, so pipes inside values and multibyte text work too.

Result windows start with wrapping disabled. The local Neovim configuration
also defaults normal windows and other utility floats to `nowrap`; use
`:setlocal wrap` when wanted.

Result mappings use `nowait`, avoiding longer global `gr` prefixes.
Each float keeps its own result, so another execution cannot change the older
float's raw/query views. Python 3 prettifies the raw JSON view, as in the existing
local tooling; query execution and table formatting run in Node. Without Python, raw JSON remains
available on one line.

## Context controls and following tabs

The initial graph uses the shared answer. **Neovim → Read graph context** requests
a new read using the existing neighbours, seed and relation options. Changing
those options also requests context. This can add useful relationships beyond
the returned columns, but is a later view of current data and does not change
the float's historical execution result. The completed mutation is never replayed.
Existing Explorer expansions remain available.

Query tabs use the normal run, pinning, graph, table and raw output machinery.
SSE reconnects and additional following Query tabs ingest the completed data.
Following Schema tabs retain their schema refresh/focus behavior. Studio must
connect to the bridge result's HTTP origin and database before rendering it;
matching database names on a different server are insufficient.

`/api/viewer/query` still supports mirror-only reads and legacy console outcomes.
Its existing behavior is unchanged. `g:typedb_graph_auto = 0` suppresses result
publication to the browser while retaining structured float execution. The specialised generated-schema inspector
keeps its existing table/panel helper path and attaches the same `gr`, `gt`,
`gq`, `I` and `Y` controls to its floats. Its raw view contains the original
inspection response, and its query view contains the inspection query.

## Execution and recovery contract

- Neovim performs a capability preflight. An absent/old bridge can use the existing
  console path **before** any run POST. `g:typedb_structured_results = 0` explicitly
  selects that legacy path.
- Once a run POST is attempted, there is no console fallback or automatic retry.
  A transport timeout, malformed TypeDB response or HTTP 5xx is conservatively
  **unknown**, because a write may already have committed.
- Every request needs a unique `runId`. Concurrent repetitions of that ID share
  one promise; a changed payload with the same ID is rejected. The bridge
  serialises executions so completed events remain ordered.
- The most recent 20 run responses can be retrieved by repeating the identical
  request. Older IDs remain tombstoned (410), up to 10,000 IDs per bridge process;
  they never execute again in that process. At capacity, new runs are rejected.
  This is an in-memory guard, **not durable exactly-once delivery across restarts**.
- The latest SSE event contains completed data, not an instruction to write.
  Browser label/role lookups, schema loading, and explicit context actions are
  independent reads and may observe later database state.

## Setup and ownership

Bridge connection settings use the same environment names as the local Python
helpers: `TYPEDB_ADDRESS` (default `http://localhost:8000`), `TYPEDB_USERNAME`
(default `admin`), and `TYPEDB_PASSWORD` (local development default `password`).
The bridge inherits the environment of its launching Neovim/terminal. Credentials
and sign-in tokens never travel in SSE or result JSON. Requests cannot override
the server's connection. Expired tokens are cleared; a rejected execution is not
silently retried. The next explicit execution signs in again.

`contrib/nvim/typedb_graph.lua` loads `contrib/nvim/typedb_result.vim` in `setup()`.
The execution adapter hook is at the beginning of `Tdb_runQueryShow`
in `~/.config/nvim/plugin/ftype/typedb.vim`:

```vim
if exists('*Tdb_runStructuredQueryShow') && Tdb_runStructuredQueryShow(a:query_lines)
  return
endif
```

`Tdb_inspect_schema_type` also attaches the shared float controls after creating
its buffer. The local `init.vim` and float utilities default to nowrap.

To activate in an already-running session, the user reloads the Lua loader and
Vimscript and restarts only its viewer job:

```vim
:luafile ~/.config/nvim/plugin/ftype/typedb_graph.lua
:source ~/.config/nvim/plugin/ftype/typedb.vim
:TypeDBGraphStop
:TypeDBGraphStart
```

The implementation/validation does not restart the user's viewer job, Neovim,
Hammerspoon or TypeDB. Browser frontend changes use the existing dev reload.
Database create/delete/list and server lifecycle commands remain on their old path.

## Implementation decisions

- `scripts/viewer-run.mjs` owns preparation, HTTP execution and conservative context.
- `scripts/viewer-result.mjs` formats arbitrary responses. The Python census tool
  is a whole-database report, not a reusable general result formatter, so coupling
  this bridge to that other checkout would add a dependency with little reuse.
- `typeql-tokens.mjs` is the existing lexer extracted unchanged for shared Node and
  Angular use. Classification ignores comments, literals and nested fetch keys,
  and catches same-line mutation stages; functions/schema stay schema operations.
- `QueryPageState.runQuery` accepts an already-completed API response and routes it
  through the ordinary output pipeline without calling a driver query method.
- Span-based source/column navigation, float-row-to-graph selection, and graph
  node/edge counts in the float remain follow-up work. Query structure/spans and
  full concept identities are retained for it; no speculative linkage is claimed.

## Validation

```sh
pnpm test:viewer
pnpm test:nvim-results
node scripts/nvim-caret.test.mjs
pnpm build:viewer
pnpm test:viewer-results
```

The last command starts a **temporary TypeDB instance** (default binary
`~/.typedb/server/typedb_server_bin`; override `TYPEDB_TEST_BINARY`), separate HTTP
and gRPC ports, a new data directory/database, an isolated bridge and Chrome
profile. It needs Playwright and Chrome like the other browser scripts. It closes
only its own processes and deletes its temporary database storage. Screenshots
and a sample structured result remain in the reported temporary artifact folder.

Validated against TypeDB CE 3.12.3: define/repeated define, successful inserts,
duplicate-key current state, concept rows, flat/nested fetch, empty reads, two
following Query tabs and a parallel Schema tab, explicit graph context, SSE replay without source execution, and a write with a
one-answer display limit still modifying both matched records. Unit checks cover
classification, formatting, request deduplication, invalid/foreign requests,
unknown outcomes and absence of retries. Headless Neovim checks the real adapter
and buffer-local view switches. Existing caret tests now explicitly select their
historical `<leader>gv` prefix instead of assuming it is the current default.
