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
- Your `gep` and `geq...` commands continue showing their normal floating text
  results. Reads are mirrored; completed schema/data statements send their
  outcome so Studio can show a separate context view.
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
`select`, sorting, filtering, and limit stages retain their ordering. For the
schema inspector’s simple instance-and-concrete-type query, the graph copy adds
`select $item;` before context expansion. This keeps the auxiliary `$concrete`
type column from becoming a schema node with an `isa` edge; Neovim’s text result
still includes that type information. Explicit selections in other queries are
preserved.

The **Neovim** menu is available beside the output controls and inside the
fullscreen graph. It provides:

- **Include linked neighbours**: enabled initially; adds at most one relation
  hop from an entity, including the relation's other role players. A selected
  relation instead includes its own role players.
- **Seed variable**: blank chooses the first eligible directly typed entity or
  relation variable, such as `$item`. Set it explicitly for queries with several
  possible starting points.
- **Relation types**: a multiple-choice list from the current database schema,
  used as an allowlist for entity-neighbour expansion. No selection includes all
  compatible relation types. The chooser marks incompatible options using the
  seed type’s played roles, including inherited roles and permitted subtypes.
  Saved incompatible selections can be deselected or removed with **Clear relation
  filter**. Query generation skips them; if none of the selected types apply, it
  shows the seed instances without expansion and explains why. Selected relations
  still include their own role players, independently of this filter.

Changes save locally and automatically regenerate the latest query from the
original received source, after a 250 ms pause to combine quick edits. There is
no Apply step. The resulting query is visible and editable in Studio’s query
field. If a query is already running, the latest options wait for it to finish.

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

## Context after schema changes, writes, and errors

The paragraph runner sends its statement **after the console finishes**, together
with its operation kind and success/error outcome. Studio refreshes its schema
and generates a separate read query in the latest unpinned Query tab. Fullscreen
stays open. The original statement is never executed by the browser.

- **Schema changes:** focus the declared types, with optional attributes, roles,
  related types and hierarchy. This Query result uses the schema Explorer.
- **Data changes:** show existing instances of the referenced types, using
  literal attribute filters where available. Identifier-like attributes (such
  as `scene-id`) take precedence over other literal attributes, so a duplicate
  identifier can still show the existing instance when the attempted title differs.
  Unnamed relations are selected by type; this may include other instances of
  that relation type. This is contextual lookup, not an audit of inserted IIDs.
- **Errors:** use the same context lookup over existing data. If it is empty or
  cannot run, show the surviving referenced schema types. Unknown types cannot
  appear in the graph; when none of the references exist, keep the previous view
  and explain why. Malformed text is scanned only for known types and literal
  values; it is not repaired and re-executed.

The Neovim button marks failed statements. Its menu retains the original
statement and error, and explains which context is being shown. Neighbour and
relation-filter changes regenerate only the read query. A source seed variable
can narrow data context; leave it blank to include all discovered seeds. Schema
context ignores that field. An open Studio transaction must be closed before
loading this current context, including when it uses the same database.

After updating this feature, restart the bridge process and source both
`~/.config/nvim/plugin/ftype/typedb.vim` and
`~/.config/nvim/plugin/ftype/typedb_graph.lua`. A bridge started before this update
cannot forward execution outcomes; the helper reports that it needs a restart.

## Finding and framing nodes

The original **Search** field still dims nonmatches. It also searches the visible
node label, and **Enter** smoothly frames the matches (as does its target icon).

The second field, **Find types or labels**, provides fuzzy matching and multiple
selections. It searches type names, node labels, IIDs, and already-loaded
attribute values—including title/name/ID values loaded for labels.

1. Type a few letters, such as `mtvn` for `motivation`.
2. Check a type to select its nodes, or check individual node results.
3. Change the search text to add more selections; checked selections persist.
4. Press **Enter** or the target icon to frame the combined selection. Before
   starting a selection, Enter selects and frames the displayed matches (up to
   60). Hidden selected nodes are shown when focused. Click the field to reopen
   the list; Escape closes it.
5. Use **×** to clear the finder. Typing in the original Search also clears it.

The finder, **Elements → Types / Kinds**, and Explorer's **Add to selection /
Remove from selection** share one selection of nodes in the current graph:

- Type and kind tags select their current nodes, just like finder type checkboxes.
  A dashed tag and a mixed checkbox indicate a partial selection. Type counts
  show selected/total when partial. Clicking a partial group selects the rest.
- **All** selects every node, allowing you to exclude types by toggling them off.
  **None** explicitly selects nothing, allowing you to build a selection from
  scratch. **Clear** (or the finder's ×) restores normal graph highlighting.
- **Filter types** only narrows the tag list; it does not alter the selection.
  **Enter** anywhere in Elements, or its **Focus** button, frames highlighted
  nodes. Space still toggles a focused tag; double-click selects only that group.
- Edge tags retain their independent edge-highlighting controls.

The finder works on the graph already displayed; it does not query additional
data. Newly loaded nodes are initially unselected; a type can become partially
selected as more instances are loaded. Selections survive docking and switching
run tabs, and reset with a new result. Reduced-motion preferences disable
camera animation. Focusing pauses the force layout so the chosen nodes stay in
view; the redraw control can start a new layout.

## Downloading a graph image

Click the download icon to save the **current view** directly as PNG, preserving
its camera, zoom, selection highlighting, and hidden nodes. There is no export
menu. Explorer and other UI controls are not included in the image.

With the local viewer server, Neovim supplies the source project's `temp`
directory. PNGs are saved to **`<project>/temp/imgs/<database>/`**, creating
folders on the first export. For example, a query from
`~/Documents/Proj/e2/pts/temp/schema_pts-tour3.tql` saves to
`~/Documents/Proj/e2/pts/temp/imgs/pts-tour3/`.

The Neovim helper finds the nearest project `temp` directory from the source
buffer (including nested files under `specimens/`). At a Git root without one it
uses `<root>/temp`; without a source project it uses Neovim's working directory.
`vim.b.typedb_graph_temp_dir` or the helper's `temp_dir` setup option can override
this discovery. `schema_<db>.tql` and `data_<db>.tql` names also supply the database
when one wasn't explicitly provided.

The destination belongs to the result: Studio reruns retain that project, and
switching to an older result preserves its destination even after querying a
different project. Schema and newly opened views use the last project remembered
for their database. The bridge can also recover the destination from a recent
Neovim request when the browser has not remembered it yet.

Open the **Snaps** tab beside **Explorer** in the upper side panel. Expand
**Project folder…** to select another project: paste an absolute path or `~/…`
pointing to the project root, its `temp` folder, or a file directly inside
`temp` (such as `schema_pts-tour3.tql`), then click **Use folder** or press Enter.
This creates `temp/snaps/<database>/` and `temp/imgs/<database>/` immediately,
shows both destinations, and remembers the project
for that database. On a result tab it updates that result's destination; other
existing results keep theirs.

If no project is known, saving activates the Snaps tab with this setting open. Missing server connections,
unwritable folders and other save errors are reported; files never silently
fall back to Downloads.

The filename uses distinct entity and relation type names from the query attached
to the displayed result, in query order: for example,
`scene-scene-take-take-00.png`. Editing the query without running it does not
change the export name. Attribute-only queries use their attribute names;
queries without explicit type names fall back to types in the displayed graph.
Long names are shortened to fit filesystem limits.

The server checks the actual directory, trying `00`, `01`, `02`, etc. until it
can create a new file without overwriting one. This also works after restarting
Studio and when two windows export simultaneously. A notification shows the
saved path. Counters are independent for each project/database folder.

After updating, reload `~/.config/nvim/plugin/ftype/typedb_graph.lua`, restart the
viewer (`:TypeDBGraphStop`, then `:TypeDBGraphStart`), reload the browser, and run
one query from the project to establish the destination.

These project saves require the local viewer at `http://localhost:1430`.
Serving Angular directly or opening hosted Studio does not provide access to
project folders. The UI gives an explicit message if the bridge needs starting
or restarting.

## Saving and reopening graph snaps

**Snap**, beside the PNG download button, saves a `.snap.json` file in
`<project>/temp/snaps/<database>/`. PNGs go separately into `temp/imgs/<database>/`. Names use the query's types and the
first free counter, for example `motivation-00.snap.json`. PNGs and data snaps
have independent counters; these are separate saves, not automatically paired
files. Restart the viewer server after updating to enable the snap endpoint.

A snap contains:

- the executed graph query, including Neovim's automatic query augmentation;
- every currently loaded node and edge, including Explorer expansions, hidden
  nodes, labels, and cached attributes that aren't separate graph nodes;
- node coordinates, graph bounds, camera position/zoom, viewport dimensions,
  density setting, and the current selection/search/filter state;
- the graph's styling and display-attribute choices;
- successfully executed expansion queries recorded through the graph loading
  path, for reference. Expansions made before this update still survive as graph
  data even when their query text was not recorded.

The upper side panel has **Explorer** and **Snaps** tabs, separate from the
lower Elements / Themes / Customise tabs. With no node selected, Snaps is active.
Selecting a graph node activates Explorer; clearing that selection returns to
Snaps. You can also choose Snaps while a node is selected.

The **query route shows data snaps**, and the **schema route shows schema snaps**,
newest first. Clicking a chip restores the saved graph directly inside the
current canvas. The URL stays on the same route, including in full-screen mode.

Chips show two-letter abbreviations of the distinct node type names, splitting
hyphenated names into words: `mental-state`, `goal`, `source` become
`me st go so`. Long lists end in `..`. There are no hover tooltips. Use `h` / `l`
to browse snaps (see keyboard controls below). The loaded snap's chip is highlighted.

Each chip has an **×** button that immediately deletes that `.snap.json` file,
without a confirmation dialog. Other snaps and PNGs are unaffected. Deleting the
snap currently on screen removes its chip but keeps the loaded graph visible.
Deletion failures are shown and leave the chip available for retry.

The saved graph includes its positions, camera, highlights and styling. It
loads without querying TypeDB and keeps its layout stopped. **Saved query** in
the Snaps tab shows its query and recorded expansions. The Explorer uses cached
values while inspecting a saved view. **Live view** returns to the original
query result or schema graph; running another query also returns to live output.
The original graph and its style service are kept separate while a snap is open.

The library reads real `.snap.json` files, so existing snaps appear too.
**Refresh** picks up files added outside Studio. **Project folder…** contains
the folder setting, both save destinations and **Import snap file…** for files
elsewhere; imports must match the current route's snap type. The project is
remembered in this browser across reloads; after changing browser/origin, run a
query from Neovim or select the project again.

Positions and the normalized camera are preserved exactly. A differently sized
window or dock arrangement can reveal a different amount of the graph, and
fonts or future renderer changes can affect pixels. The stored viewport size
provides a reference; the PNG button remains the way to save an exact image.
A snap is a saved visualization, not a database backup or a write to authored
`pos-x` / `pos-y` attributes. Select the snap from the list after a browser refresh if needed.

A tested nine-node graph with Explorer-added attributes occupied about 27 KB;
storing coordinates is a small part of that. The current file format is version
1 with a 64 MiB limit. Unknown formats and invalid graphs are rejected before
replacing the current saved view.

See [Graph visualization experiments](graph-visualisation-experiments.md) for
Sigma v4, dotted edges, layout controls and group contours mapped to the
mechanism schema. Those are proposed follow-up experiments, not part of this
snap implementation.

## Exploring and styling a result

Use Explorer's **here** mode to inspect an individual node and add its actual
relations, links, or attributes. These actions change the graph result without
rewriting the query. The Neovim menu controls the initial automatic expansion;
Explorer is the more direct way to explore further.

Beside **Reveal in graph**, **Hide / Show** hides the selected node and its incident
edges. **Add to selection / Remove from selection** changes the same selection
as the finder and Elements tags. Hidden nodes remain in the result, including
its counts and layout; they are not deleted from TypeDB. **Restore hidden / dimmed
nodes** in the panel footer clears these view overrides. Reveal also unhides the
inspected node. Overrides survive docking and switching run tabs, but a new query
result starts fresh. They are separate from saved styling presets.

The type Explorer's **Display attribute** selector loads values for node labels
without adding attribute nodes. New query results load label values automatically
and restore your saved choice for each type and database. **(auto)** uses Studio's
existing attribute-name heuristic. Attribute chips and the instance Explorer's
**Add to graph** buttons still add separate attribute nodes when you want them.
Label values and choices survive docking and switching run tabs.

All graph routes, including **/schema**, use the same label renderer. Labels use
1.5 times the normal label area before wrapping, whether or not a narrower wrap
would have fitted. Ellipsis limits long values to three lines. Tapered shapes
such as diamonds and hexagons do not clip individual letters.

On **/schema**, select a node to explore its type in the right-hand Explorer:

- Supertypes/subtypes, attributes, played roles and relation types, and related
  roles appear as clickable chips. Inherited schema connections are included.
- Attribute types list their owners; role types list their relations and the
  types that can play the role.
- Clicking a chip reveals that type and opens its Explorer details. The **\***
  chip reveals the whole group with the selected type, showing any hidden nodes.
- **Hide / Show**, **Add to selection / Remove from selection**, and **Reveal in
  graph** work on the selected schema node. Selection is shared with the finder
  and Elements tags. The panel footer restores all hidden or dimmed nodes.

These are view controls over the loaded schema; they do not alter the database.
Schema refresh rebuilds the graph and clears its temporary visibility changes.
The same controls are available in fullscreen and with the Explorer docked below
the graph.

The **Themes** panel imports and exports custom presets as JSON. Importing keeps
existing presets and adds a suffix to duplicate names; choose Apply to activate
an imported preset. Saved backgrounds, colours, shapes, labels, and edge options
travel together. Each saved preset's menu also exports that preset individually.

Two presets inspired by the Neovim TypeQL palette are available in
[contrib/graph-presets](../contrib/graph-presets/README.md): **Munsell Ink** and
**Munsell Paper**. See that guide for import instructions and the colour choices.

## Keyboard controls and additive graph selection

**Shift-click** a node to toggle it and its periphery in the shared selection.
A first Shift-click extends the neighborhood of the node you were already
inspecting. Subsequent Shift-clicks add or remove groups. Shared nodes stay
selected while another selected group still includes them. This uses the same
periphery rules as ordinary inspection, including relation role players; it does
not issue a query or load more nodes. It works in Query, Schema, and saved views.

The finder checkboxes and Elements tags reflect the result. Editing those controls
establishes a new explicit selection, so subsequent Shift-clicks extend that base.
Removing the last group selects **None**; **Clear** restores ordinary highlighting.
Neighborhood groups survive snap save/restore. Ordinary clicking still opens the
Explorer without replacing an explicit selection.

| Key | Action |
| --- | --- |
| `h` / `l` | Previous / next snap in the displayed route-specific list, wrapping at the ends |
| `Backspace` | Return from a saved view to the preserved live view |
| `Enter` | Smoothly focus the current shared selection or ordinary highlights |
| `s` | Save a snap |
| `/` | Focus the fuzzy finder |
| `?` | Open/close shortcut help in Snaps |

These work across the visible graph view; snap chips do not need keyboard focus.
Inputs, the query editor, dialogs, menus, modified browser shortcuts, and key
repeat are left alone. After typing, click an empty area of the graph to use graph
shortcuts. Enter inside either search field keeps that field's existing behavior.
The Snaps **Keys** button shows help and the last shortcut Studio received.

**Vimium setup:** in Vimium's popup/options, add an exclusion rule with pattern
`http://localhost:1430/*` and excluded/pass-through keys `hls/?`, then save.
Use your actual port if different. Leave the keys field empty to disable Vimium
entirely for this site, or press `i` for temporary pass-through (Escape ends it).
Default Vimium does not map Enter or Backspace. Custom mappings for those keys
may require a full site exclusion or insert mode.

Vimium 2.4.2 was tested from this machine's installed extension in an isolated
browser profile: default `h`/`l` never reached Studio's window capture listener;
the exclusion rule passed them through. No real Chrome profile was modified.
A web page cannot override an extension that consumes the event first. See
[Vimium's exclusion documentation](https://github.com/philc/vimium/wiki/Disabling-Vimium).

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
Incoming statements without a completion outcome must be a single read `match`
pipeline. Schema changes and writes are never replayed: completed-operation
events generate separate context reads instead. Pressing Studio's own
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

An optional absolute `projectTempDirectory` (for example,
`/Users/at/Documents/Proj/e2/pts/temp`) travels with the request and its result.
The Neovim helper supplies it automatically. Export requests include this path
and the result's database; the server creates `snaps/<database>/` for data snaps
and `imgs/<database>/` for PNGs beneath it.
`projectSnapshots: true` in the acknowledgement and health response indicates
support for project destinations.

An optional `execution` object reports a completed console statement:
`{ "kind": "read" | "write" | "schema", "status": "success" | "error", "error": "optional error text" }`.
Error text is limited to 8000 characters. Without an outcome, incoming mutations
remain rejected. A successful acknowledgement includes `executionContext: true`
when the running bridge supports these events.

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


The local bridge also exposes `GET /api/viewer/snaps` (list) and
`GET /api/viewer/snap` (open by `filename`), scoped by `database` and
`projectTempDirectory`. `POST /api/viewer/project` accepts `database` and `path`
query parameters, resolves the project and creates the destination. Explicit
project metadata wins over the last project received for that database. The
`snapLibrary: true` health capability identifies a server with these endpoints;
`imageFolders: true` identifies PNG routing into `imgs`. Snap listings include
`kind` (data/schema/unknown), `nodeCount` and a compact `abbreviation` when readable,
and both destination paths. `DELETE /api/viewer/snap` uses the same project/DB
parameters and `filename` to remove one snap; it rejects traversal and non-snap filenames.
