# Complementary Neovim float and Studio graph — recovered plan

**Provenance.** The session that produced the original plan (2026-09-19, ~15:45–19:10)
lost its terminal to a Hammerspoon restart and its transcript was never written to
disk, so the plan text itself is gone. This document is a reconstruction from what
that session left behind — four TypeDB HTTP API probe scripts, its reading of
`typedb.vim`, and the approved direction — plus a re-run of those probes against
TypeDB CE 3.12.3 to regenerate the findings they were written to establish.
Treat the design below as a proposal to check, not as the original wording.

## The problem

In a `.tql` buffer, `gep` (and friends) currently render two things in parallel:
the Neovim float shows TypeDB's feedback, and Studio renders the graph. They come
from **two different executions in two different engines**, so they disagree:

- Schema and insert paragraphs are often re-run *just to make the graph explain
  them again*. The second run is a no-op or a key conflict, so the float shows a
  console error while the graph shows something useful. The float is noise.
- `match … select` returns concept rows, which the console prints in a shape that
  is hard to read in a buffer; a table would be the informative view.
- `fetch` returns JSON documents, likewise usually better read as a table.

## Today's two paths

| | Neovim float | Studio graph |
|---|---|---|
| entry | `gep` → `Tdb_eval_range` → `Tdb_runQueryShow` | `typedb_graph.lua` → `POST /api/viewer/query` |
| engine | `typedb console --script <temp file>` over gRPC :1729 | Studio driver via the bridge, SSE to the browser |
| result | raw console stdout in `FloatingSmallNew` | rendered graph |

`Tdb_runQuery` already classifies the paragraph (`Tdb_withTransactionLines`:
schema vs write vs read, `g:isDataMutation`, `g:isJsonFetch`) and already ships an
**execution outcome** to the bridge — `g:tdb_last_graph_execution = {kind, status, error}`
— so Studio can colour the graph by what the console did. That is the seam the
approved direction removes: Studio should not be *told* what happened by a second
engine, it should be the one that ran the query.

## Approved direction

Neovim stops shelling out to `typedb console` for evaluation. One execution
happens on the Studio side, and both surfaces render the same result:
the float gets a structured answer, the graph gets the same answer's concepts.
Formatting is shared with the Python already in
`~/Documents/Proj/k_mindgraph/j_fullstack/e_tdb/` (`bin/tql-census`, `bin/tql-run`),
which already speaks the TypeDB HTTP API and already renders panels.

## What the API actually returns (re-verified 2026-09-19)

`POST /v1/signin {username,password}` → `{token}`; then
`POST /v1/query {databaseName, transactionType: read|write|schema, query}`.

Success is `200` with `{queryType, answerType, answers, warning, query}`:

- **`answerType: "ok"`** — `define`/`undefine`. No answers. Re-running an
  identical `define` is idempotent: it returns `ok` again, not an error.
- **`answerType: "conceptRows"`** — `match … select`, `reduce`, and also every
  `insert`. Each answer is
  `{data: {<var>: {iid, kind, type:{kind,label,valueType}, value, valueType}}, involvedBlocks: [n]}`.
  `kind` is `entity` / `attribute` / `relation` / `value`, so a table renderer can
  key columns off the variable names and cells off `value` or `type.label`.
- **`answerType: "conceptDocuments"`** — `fetch`. Each answer is the plain
  JSON document the query asked for, e.g.
  `{"who": "ann", "nested": {"iid": "0x1e…"}}`. Flattening one level of keys gives
  a table directly; nested objects/lists keep the JSON view as a fallback.
- **`query`** (on non-schema queries) is the *parsed* query: `conjunctions[].constraints[]`
  each with a `textSpan {begin,end}` into the submitted text, plus `stages`
  (`match`/`insert`/…), `variables` (id → name) and `outputs`. This is the most
  valuable find: the float can label rows by the variable that produced them, and
  spans map answers back to buffer positions — the "explain this statement" goal
  gets real linkage instead of a guess.

Failure is `400` with `{code, message}`, where `message` already contains a caret
excerpt. Codes seen: `SYR8` (unknown attribute type in `define`), `INF2` (unknown
type in `insert`), `CNT9` (`@key`/`@unique` violation), `DEX14` (conflicting
redefine — "Try redefine instead?"), `FER0` (unsupported `fetch` list form):

```
[SYR8] The attribute type 'nope' was not found.
[DEX3] Failed to find symbol.
Near 1:28
-----
--> define entity person, owns nope;
                               ^
```

**The re-run case, precisely.** Re-running a `define` is fine (`ok`). Re-running an
`insert` whose entity carries a `@key` is *not*: it fails with `CNT9` and nothing
is written. That asymmetry is exactly the daily annoyance — the graph still
explains the statement, while the float shows a constraint violation.

## Proposed design

1. **One execution, in the bridge.** Add `POST /api/viewer/run` to
   `scripts/viewer-server.mjs`, next to the existing `/api/viewer/query`. It
   signs in to the HTTP API (cached token), classifies the paragraph, executes,
   broadcasts the query *and its answers* to Studio over the existing SSE channel,
   and returns the structured result to Neovim. `/api/viewer/query` stays for
   mirroring without execution; `execution: {kind,status,error}` becomes something
   the bridge *derives* rather than something Neovim reports.
2. **Classification stays identical.** Reuse the predicate that `typedb.vim` and
   `e_tdb/bin/tql-run` already agree on (anchored, word-bounded
   `^(match|insert|update|put|delete|reduce)>`; `fun` ⇒ schema) so a paragraph
   runs as the same transaction kind it does today.
3. **One formatter, in Python, shared with e_tdb.** Factor the panel rendering of
   `bin/tql-census` into a module (e.g. `e_tdb/bin/tql_format.py`) exposing
   `format_answer(response) -> list[str]`, and have both `tql-census` and the
   bridge call it. Rules:
   - `ok` → one line, `define ok · 3 declarations · 0.04s` (plus the schema
     delta if cheap to get).
   - `conceptRows` → aligned table, one column per output variable, header from
     `type.label`, cells from `value` (attributes/values) or a short iid tag
     (entities/relations).
   - `conceptDocuments` → table when every document is flat and shares keys,
     otherwise pretty JSON.
   - error → `code`, the first message line, and the caret excerpt verbatim.
4. **Error fallback that answers the real complaint.** When a *write* fails with a
   re-run-shaped error (`CNT9`, and similar constraint codes), the bridge
   re-issues the statement's match half as a read and the float shows *what is
   already there* as a table, headed by a one-line note (`already present — showing
   current state`). The graph keeps rendering the statement as today. This is the
   case where the float goes from useless to the most useful panel on screen.
5. **Span linking (second step).** Use `query.variables` + `constraints[].textSpan`
   to map a float table column back to the buffer range that introduced it, so
   moving the caret can highlight the matching column, and selecting a row can
   highlight the constraint that produced it.

## Map changes

- `gep` / `gee` / `<leader>geo`: same keys, same paragraph/line/buffer ranges, but
  `Tdb_runQueryShow` calls the bridge instead of `systemlist(typedb console …)`
  and renders the returned lines in the existing float.
- `geq…` reads: unchanged keys, table rendering by default, `fetch` as table with
  JSON on demand.
- Console stays for `database create/delete/list` and server start/stop
  (`StartTypeDBServer`, `Tdb_clearDB`, …) — those are not query evaluation.
- Failure of the bridge (not running) must fall back to the console path rather
  than leaving the float empty.

## Open questions

1. Who holds credentials — the bridge signing in to `:8000` itself, or Studio's
   existing connection? The bridge is simpler and works with no browser open.
2. Formatter in Python (reuse e_tdb, one subprocess per evaluation) versus a Lua
   port (no subprocess, duplicated logic). The approved direction favours Python.
3. Should the float ever show the graph's own summary (node/edge counts) so the
   two panels visibly agree?

## Where the recovered artifacts live

Session `ca446737-7047-4622-a3c8-03abcf75dd9f`, scratchpad
`/private/tmp/claude-501/-Users-at-Documents-Proj-sem-wb--reference-repos-tdb-typedb-studio/ca446737-.../scratchpad/`:
`probe.py` … `probe4.py` (the API probes), `typedb-server.log`. That directory is
temporary — copy it if the raw scripts matter. Re-running the probes needs a
TypeDB server on `:8000` and touches only the scratch database `z_http_check`.
