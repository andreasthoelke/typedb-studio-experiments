# Neovim queries in TypeDB Studio

Open **http://localhost:1430/query?nvim=1**. This is Studio's normal Query page,
including the graph's Explorer, themes, search, zoom, layout, and fullscreen
controls. Neovim updates the latest **unpinned** query tab and runs the query.
Incoming results also refresh the fullscreen graph. Exit fullscreen to inspect or
edit the actual graph query, or use the rest of Studio.

The earlier dedicated `/viewer` implementation is preserved on
`feat/local-graph-viewer` at `78b4eff5`. The current implementation is on
`feat/nvim-studio-query`; `/viewer` redirects to `/query?nvim=1`.

## Complementary result floats

Ordinary Neovim evaluation now has a shared execution path: the local bridge runs
TypeDB once, returns a readable float result, and sends the same structured
answer to Studio. Concept rows and flat fetch documents render as tables; nested
fetch documents preserve their JSON structure. Schema operations include a
current-schema table when a context read can be derived. Failed writes keep the
original error and can include a separately labelled table of current data.
That table does not imply the failed write succeeded or that its exact intended
record already exists.

Inside the float, **gr** shows raw JSON, **gt** restores the formatted view, and
**gq** shows the executed and context queries. These mappings use `nowait` to avoid waiting for longer Neovim mappings such as `grr`; the less frequent alternatives are **<leader><leader>r**, **<leader><leader>t** and **<leader><leader>q**. These stay attached to that float,
even after another evaluation. Original errors, full untruncated cell values and
query structure are available in raw JSON.

**I** moves to the next table column and **Y** to the previous one, keeping the
current row. These controls also work in generated-schema inspection floats.
Floats start with line wrapping disabled, as do normal windows in the local
Neovim configuration. Use `:setlocal wrap` when you want wrapping in a window.

The initial Query graph renders the shared answer. Use **Neovim → Read graph
context** for a subsequent read with the neighbours/seed/relation options; option
changes also request context. Schema following and Explorer expansion work as
before. A browser reconnect renders the completed answer without executing the
source statement again. Connect Studio to the same HTTP server/database as the
bridge to receive these results.

The bridge uses `TYPEDB_ADDRESS`, `TYPEDB_USERNAME`, `TYPEDB_PASSWORD` from its
launching environment (defaults: `http://localhost:8000`, `admin`, `password`).
The existing keys/ranges are preserved for commands using `Tdb_runQueryShow`.
The specialised generated-schema inspector continues to use its existing helper.
An old/unavailable bridge falls back to the console only before submitting a run.
After submission, a lost response reports **outcome unknown** and never retries a
possible write. Inspect the current data before explicitly running it again.

For an existing Neovim session, reload the integration and restart its viewer job
when convenient:

```vim
:luafile ~/.config/nvim/plugin/ftype/typedb_graph.lua
:source ~/.config/nvim/plugin/ftype/typedb.vim
:TypeDBGraphStop
:TypeDBGraphStart
```

Set `g:typedb_structured_results = 0` to use the legacy console evaluation path.
If an older helper reports **TypeDB request rejected before execution** with a
request ID containing `e+` (for example `1.0102836952708e+14-53874`), reload it with
`:luafile ~/.config/nvim/plugin/ftype/typedb_graph.lua`, then run the command again.
This was a clock-formatting bug after longer uptime; the rejected request did not
execute. The fix requires no Studio, bridge, or Neovim restart.
See [the result-rendering design](nvim-result-rendering-plan.md) for the HTTP
contract, supported context patterns, implementation and isolated tests. The
mirror-only behavior described later applies to `/api/viewer/query`; completed
`/api/viewer/run` results are ingested instead of rerun.

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

## A parallel schema reminder

Keep these two browser tabs open:

- **http://localhost:1430/query?nvim=1** for the data/context result.
- **http://localhost:1430/schema?nvim=1** for the related schema neighborhood.

The URL parameter is `nvim=1` (equals one). It enables the Neovim event receiver
for that browser tab and is remembered in session storage. `nvim=0` disables it.
On the Schema page, **Follow Neovim** enables it without editing the URL; click
**Neovim · following** to pause while you explore manually. **Refocus** reapplies
the latest received source after you change the selection or camera.

Each `gep` / mirrored query now reaches both enabled routes independently. Query
usually shows instances; schema declarations and some empty/error operation
contexts can already show types there. The parallel Schema page always uses the
loaded schema graph and never executes the original statement as a data query.

The schema focus starts from known type names in the **original Neovim source**,
including declarations, anonymous relation inserts, and attribute references.
Comments, string values, and variable names do not seed unrelated types. It adds:

- owned attributes and direct subtypes of referenced types;
- relations that those types can play in, with their roles and other player types;
- owners when an attribute is referenced;
- ancestor paths needed to explain inherited connections.

Expansion stops before recursively following the other players' unrelated
relations. It uses the current schema, independently of instance availability or
the Query page's data-augmentation allowlist. This is a pragmatic reference scan,
not query inference: a generic query using only type variables or opaque function
calls may provide no usable type names. In that case the previous schema view is
kept and the Neovim button's status explains why.

Selected types share the existing Elements selection; remaining schema
nodes are dimmed and remain available. Enter focuses your edited selection.
A fresh layout gets a short settling period before automatic framing. A background
tab frames when it can render. Changing the selection cancels a pending automatic
frame. New received context replaces a restored schema view with a fresh full
schema before focusing; it also closes any offline preview.

A completed schema-operation notification refreshes the schema before focusing,
including when the operation failed (surviving types can still explain the error).
An open Studio transaction must be closed before following new schema context.
Saving a focused schema snap records its original source, selection and viewport,
and uses the incoming project's `temp/snaps/<db>/`; PNGs use `temp/imgs/<db>/`.

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
  Its connection chips add types and their immediate schema neighborhood to the
  current graph, including types not yet drawn. For example, select `take` and
  click `take-includes` under Relations to load that relation, its roles and
  player types. A role chip loads its relation's neighborhood; **\*** adds the
  whole section. The source stays selected for successive additions, with a
  gentle layout update and preserved camera. Repeated loads deduplicate nodes
  and edges; chips can also bring removed types back. The editor retains the
  original context query and snaps record the separate expansion queries.
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

**Find node (/)** is a single fuzzy node picker. It searches type names, node
labels, IIDs and already-loaded attribute values, including values used for labels.
Each suggestion represents one node; there are no selection checkboxes or type
groups. Dimmed and off-screen nodes are searchable; explicitly hidden nodes are
omitted until restored. Search uses the loaded graph and never queries more data.

1. Press **/** to open the picker. Its previous query is selected so typing replaces
   it. Type a few letters, such as `mtvn` for `motivation`.
2. Use **Ctrl-n / Ctrl-p** or **Down / Up** to move through matching suggestions,
   wrapping at either end. Input focus stays in the field, so you can keep typing.
3. Press **Enter**, or click a suggestion, to place the caret on that node, update
   Explorer and bring it into view. The picker closes and **hjkl** work immediately.
4. **Escape / Ctrl-[** closes the picker without changing the caret or highlights.
   **×** clears only the search text. Neither typing nor browsing suggestions
   changes the graph's selection or moves its caret before acceptance.

Up to 60 suggestions are shown; keep typing to narrow a long list. This follows
an editor picker flow: search, choose a result, then continue navigating from it.
Use **zz** after accepting a result when you want it exactly centred at the current
zoom, rather than merely visible.

**Elements → Types / Kinds**, modifier clicks/motions and Explorer's **Add to
selection / Remove from selection** share one selection of nodes:

- Type and kind tags select their current nodes. A dashed tag indicates a partial
  selection; type counts show selected/total. Clicking a partial group selects
  the rest.
- **All** selects every node, allowing you to exclude types by toggling them off.
  **None** explicitly selects nothing, allowing you to build a selection from
  scratch. **Clear** restores normal graph highlighting.
- **Filter types** only narrows the tag list. **Enter** in Elements, or its
  **Focus** button, frames highlighted nodes. Space toggles a focused tag;
  double-click selects only that group.
- Edge tags retain their independent edge-highlighting controls.

Selections survive docking and switching run tabs, and reset with a new result.
New query nodes are initially unselected; Explorer expansions join an active
selection. Reduced-motion preferences disable camera animation. Focusing pauses
the force layout so targets stay in view; the redraw control starts a new layout.

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

Open **Snaps** in the shared side-panel tab row. Expand
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

When the query has a `# ─ ` title, PNGs and snaps are named after it: each word
is cut to four characters, words are joined with `-`, the name stays under about
28 characters, and the counter is a single digit starting at 0 — `# ─ 8d · Read
the pattern bindings.` saves `8d-read-the-patt-bind-0.png`, then `-1`, and so on.
The PNG also carries the title and comment in its top-left corner, as on screen.

Untitled queries use distinct entity and relation type names from the query attached
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
`<project>/temp/snaps/<database>/`. PNGs go separately into `temp/imgs/<database>/`. Titled queries use the
shortened title and a single-digit counter (`8d-read-the-patt-bind-0.snap.json`,
see PNG naming above); untitled ones use the query's types and a two-digit
counter, for example `motivation-00.snap.json`. PNGs and data snaps
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

The side panel has one row: **Explorer / Snaps / Elements / Themes / Customise / Source**.
It starts on Snaps. While browsing Explorer or Snaps, inspecting a node opens
Explorer and clearing inspection returns to Snaps. Styling tabs stay open while
you move the caret. You can choose Snaps while a node is inspected.

The **query route shows snaps matching the current graph**: data snaps for data
results, schema snaps for schema-context results. The **schema route shows schema
snaps**, newest first. Clicking a chip restores the saved graph directly inside the
current canvas. The URL stays on the same route, including in full-screen mode.
Restored schema-context Query snaps support the same Explorer additions as a fresh run.

A titled snap's chip shows its shortened title and index (`8d read the patt bind 0`).
Other chips show two-letter abbreviations of the distinct node type names, splitting
hyphenated names into words: `mental-state`, `goal`, `source` become
`me st go so`. Long lists end in `..`. There are no hover tooltips. Use `h` / `l`
to browse snaps (see keyboard controls below). The loaded snap's chip is highlighted.

Each chip has an **×** button that immediately deletes that `.snap.json` file,
without a confirmation dialog. Other snaps and PNGs are unaffected. Deleting the
snap currently on screen removes its chip but keeps the loaded graph visible.
Deletion failures are shown and leave the chip available for retry.

When connected to the snap's database, opening a chip restores an **editable graph
run**. Query puts the saved query into the current query tab and replaces its
unpinned result; a pinned result is retained, and a pinned query tab causes a new
query tab to be created. The source query is not executed during restoration.
Saved positions, camera, labels and highlights provide the starting view, styled
with the current theme. The captured preset is not applied.
There is no separate previous-live-view overlay to return to in this mode.

Click a node to use the normal Explorer: **here**, **every '<type>'**, display
attributes, **Add all to graph**, individual relation/attribute additions, and
**Hide / Show**. Expansions read current database data and use the normal gentle
layout update. Thus a saved graph can include older captured nodes alongside
newly fetched data; it is not a historical database transaction. Types or instances
that no longer exist may have no current details or expansion results.

Already-open **following Schema tabs** receive the restored Query source as a
schema-context notification. Other Query tabs do not execute it. The Neovim menu
in the restoring Query tab also adopts the source, so its explicit augmentation
controls work from that query. Schema snaps restore directly as editable schema
views; a later Neovim event reloads the full schema before focusing new context.

Pin the restored result if you want to keep exploring it after the next query.
**Snap** saves a new numbered file including subsequent expansions and view edits;
opening or editing a snap never overwrites its original file.

Without a connection to the matching database (or while its schema is loading),
the graph opens as an isolated **preview** using saved values. The preview keeps
the previous live graph underneath; **Live view / Backspace** closes it. After
connecting/selecting the database, **Explore live** promotes it to an editable run.
**Saved query** displays preview provenance. Switching a restored run to a different
database, or disconnecting, limits its inspector to cached values until the matching
database is connected again.

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

**Reveal in graph** marks the node(s) with dotted secondary carets and pans only
as far as needed to bring them into view — it never zooms, and the Explorer keeps
its node. On the inspected node itself it places the primary caret the same way.
Beside it, **Hide / Show** hides the selected node and its incident
edges. **Add to selection / Remove from selection** changes the same selection
as the Elements tags. Hidden nodes remain in the result, including
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
  graph** work on the selected schema node. Selection is shared with Elements tags. The panel footer restores all hidden or dimmed nodes.

These are view controls over the loaded schema; they do not alter the database.
Schema refresh rebuilds the graph and clears its temporary visibility changes.
The same controls are available in fullscreen and with the Explorer docked below
the graph.

**Customise → Graph** remembers whether **Settings**, **Kinds**, **Types** and
**Edges** are expanded. Choices survive switching tabs, docking, route changes
and browser reloads on the same Studio origin. They are UI preferences, separate
from styling presets and snaps.

When the caret moves, the **Caret type** indicator follows it. If **Types** is
expanded, the matching style row is highlighted, placed first and brought into
view inside the panel. It stays reachable even when a type filter or the 100-row
limit would otherwise omit it. Collapsed sections stay collapsed; **Reveal style**
opens Types on request. Following the caret never changes the type's actual style.

The **Themes** panel imports and exports custom presets as JSON. Importing keeps
existing presets and adds a suffix to duplicate names; choose Apply to activate
an imported preset. Saved backgrounds, colours, shapes, labels, and edge options
travel together. Each saved preset's menu also exports that preset individually.

Two presets inspired by the Neovim TypeQL palette are available in
[contrib/graph-presets](../contrib/graph-presets/README.md): **Munsell Ink** and
**Munsell Paper**. See that guide for import instructions and the colour choices.

## Keyboard controls and additive graph selection

The caret is the node you are inspecting; highlights are the set you are working
with. A plain node click moves the caret and updates Explorer without changing
highlights, including when you click a dimmed node. It never expands a node's
neighborhood or toggles selection. Quick repeated clicks use the same semantics
and do not trigger a separate node zoom.

**Shift-click** adds only the clicked node. **Option-click** on macOS (**Alt-click**
elsewhere) removes only that node. Both are idempotent: repeating an add keeps the
node selected; repeating a removal keeps it unselected. Option wins if both
modifiers are down. Command/Ctrl-click has no special selection meaning.

Elements tags and Explorer's **Add to selection / Remove from
selection** use the same shared set. The first modifier edit starts from the
currently highlighted nodes. If all nodes are highlighted, Shift-click has
nothing to add; use **Elements → None** to build a fresh set, or Option-click to
subtract from the current set. **Clear** returns to ordinary style highlighting.
Exact selections survive snaps. Older neighborhood-based snaps remain readable,
but clicks no longer create or toggle neighborhood groups.

### Stable focus and a working graph

Mouse and Explorer selection edits only change highlighting. **Enter**, **Focus**, and the lower-right
target button frame the same effective selection without changing node positions.

**R**, or **Elements → Isolate & layout**, makes the highlighted nodes the actual working
graph. Only edges whose two endpoints remain selected participate in its new force
layout. Excluded nodes do not repel, attract, or anchor anything. This works in
Query, Schema, and saved views; the displayed query remains provenance, not a
rewritten query for the subset. An empty selection does nothing.

For the shared `title` example: use **Kinds → All**, then turn off the attribute
kind (or exclude just `title` using its type chip / Option-click), and choose
**Isolate & layout**. Alternatively build a smaller entity/relation selection first.
For schema graphs, keep the role nodes connecting the relation types to their
players if you want those connections in the reduced layout.

- Explorer **Remove from graph** removes the selected node and incident edges
  from the working data, without changing the database. It preserves the remaining
  positions and camera. **Redraw graph** then lays out the remaining graph.
- Explorer expansions still add current data with the existing gentle settling
  and camera preservation. Newly loaded nodes join an active selection, so they
  are highlighted immediately. You can isolate the extended selection again.
- **Restore context**, available in Elements and as a back-arrow above the graph
  controls, restores the original graph's nodes, edges, positions, and camera.
  Newly explored nodes are retained. It keeps your current selection and styling.
  Repeated reductions share one original context; this is not a multi-step undo.
- Saving a snap records both the working subset and its restorable context.
  Opening it restores the reduced view; Restore context still works after opening
  or moving the panel. The extra context can make the snap file larger.
- A new Neovim/snap source in the following Schema tab first restores the original
  full schema arrangement, then changes its highlights and camera as usual.

**Hide** remains a visual-only option for compatibility: hidden nodes still affect
layout. Use selection plus **Isolate & layout**, or **Remove from graph**, to remove
that influence. None of these view edits execute the original query or modify data.

### Caret navigation and node hints

In a Neovim `.tql` (or `.tqls`) buffer, normal-mode **Ctrl-n / Ctrl-p** retain
the existing next/previous binding motions and send a caret jump to following
**Schema** tabs. Normal-mode **Enter** keeps the source cursor in place and sends
the identifier under or to its right on the current line to all following Schema
and Query tabs on that database. Insert-mode Enter keeps its ordinary behavior.
Use **Follow Neovim** or open the routes with `?nvim=1` to receive these gestures.

Schema follows a type or scoped role name. **geo** is an alias for normal-mode
Enter. A variable uses its `isa` type when known. Cursor position distinguishes
`entity take` from a later `plays scene-take:take` clause: the declaration focuses
`take`; the plays clause focuses the scoped role in Schema and a `scene-take`
relation instance in Query.

A data relation line focuses the **relation instance**, using all available player
bindings. For `depiction-slot (host: $d, slot: $sg);`, the literal IDs for both `$d`
and `$sg` identify the intended relation, distinguishing the agent/goal/barrier
slots. `scene-take (scene: $s, take: $t);` and `stages (scene: $s, root: $d);`
similarly focus those relations. Move the source cursor directly onto `$sg`, `$s`,
or another variable to inspect that player instead. A role label within a data
relation points Schema to its role and Query to the relation.

**Enter/geo may add missing illustrative data to the current Query graph.** The
read is built from supported paragraph constraints (`isa`, `iid`, literal string
`has`, variable attributes and relation players), including connected patterns
needed to resolve untyped variables. This makes a partial paragraph such as
`role-binding …; occurrence-of …; $r has title $who;` useful even when its relations
or owned title attributes were omitted from the original Query result. Reads are
limited to **20 answer rows** and **32 connected variables**, so one gesture stays
bounded. The read never executes the source's insert/update/delete stages.

Illustrations append to the current run and are recorded in its expansion queries
and saved snapshots. Existing node positions, highlights and original query text
stay unchanged; new nodes are placed near existing neighbours. Repeating the same
illustration does not duplicate nodes or edges. Deliberately hidden targets remain
hidden. If the database has no matching data, the view stays unchanged and a notice
explains the miss. The read first uses the whole paragraph's connected pattern, so `$intent isa
stage-intent;` in a scene/take paragraph resolves to that paragraph's intents
rather than every stage-intent; when the whole pattern finds nothing (for
example an uncommitted insert) the focused type read is used instead. Every
matching node gets a dotted **secondary caret**; the primary caret stays on the
current match or goes to the one nearest the camera centre. Unknown untyped bindings do not
fall back to unrelated nodes. Blank lines delimit the source context; this is not
a full evaluator for arbitrary functions, expressions, negations or query stages.

Neovim jumps use the same padded follow as graph motions: a comfortably visible
node leaves the camera unchanged; an off-screen node is brought just inside the
padded viewport. Caret jumps only pan; they never zoom. Use **zz** to centre
explicitly and **Enter** to fit (and zoom to) the highlighted set. Ctrl-n/p remain Schema-only navigation and do not add Query data.

Neovim can also control all following viewers without switching applications.
The default buffer-local prefix is **`\`**. Remote commands intentionally reach both following Query and Schema views:

| Neovim sequence after `\` | Viewer action |
| --- | --- |
| `zz / zt / zb / zh / zl` | Centre / top / bottom / left / right caret placement |
| `Ctrl-h / Ctrl-l` | Pan camera left / right |
| `Ctrl-y / Ctrl-e` (also `Ctrl-k / Ctrl-j`) | Pan camera up / down |
| `+` or `=` / `-` | Zoom in / out |
| `Ctrl-o` | Previous caret visit |
| `Enter` | Fit highlights |
| `s` | Save a snapshot in the project |
| `r` | Re-layout |

The prefix avoids the existing argument-list maps on `<leader>v` and `<leader>vs`.
Set `control_prefix` in the helper's setup options to change it (or `false` to
disable these maps). Commands go to **all following Schema/Query tabs on the
matching database**; `s` saves each receiving view. Navigation and controls are
transient and never replay when a tab reconnects. Controls wait for pending caret
lookups; `geo` and controls leave the source cursor in place. They follow an
already-running bridge and do not open a browser or start a viewer as a side effect.

After updating the bridge/helper, run
**`:luafile ~/.config/nvim/plugin/ftype/typedb_graph.lua`**, then
**`:TypeDBGraphStop`** followed by **`:TypeDBGraphStart`**.
`:TypeDBGraphCaret` is also available as an explicit command.

The lower-left indicator shows **Normal** or **Caret**, with the explicit selection
count. **c** draws four caret corners around the visible node nearest the camera
centre (or the nearest loaded node if all are off screen). It does not change
highlights. Clicking a node also enters Caret. Explorer follows the caret while
retaining the **here / every** preference. Schema nodes inspect types and roles;
data nodes inspect instances or their types.

**h / j / k / l** move left / down / up / right in screen coordinates. Each
motion uses the current layout and the rendered node bodies, independently of
how you reached the node. For **j/k**, nodes whose horizontal bounds overlap form
a visual column; movement chooses the next centre below/above. **h/l** uses the
same rule for a row: overlapping vertical bounds, then the next centre left/right.
This lets wide, staggered nodes be traversed in screen order even when their
centres are quite diagonal. A farther, more centred node does not skip the next
node in that visual column or row.

If no node overlaps that column/row in the requested direction, movement falls
back to a 90-degree cone (or the forward half-plane when empty), balancing distance
and lateral drift with a stronger connection preference: a direct neighbour's
distance/alignment score is divided by three. Connections also break
comparable choices at the same row/column position. Hidden nodes are skipped;
dimmed nodes remain reachable. No candidate means no movement, with no wrapping.

For the evidence / take-includes / goal arrangement, **k** moves from evidence
to take-includes and another **k** to goal, even after arriving at evidence with
**j** from motivation. **l** from take-includes reaches motivation. In the wide-node
Fear / tension / motivation / goal arrangement, repeated **j** advances through
those nodes in their vertical order rather than skipping tension for a more
centred motivation node. These screenshot layouts are covered by regression tests.

**n / o / y / .** add diagonal directions, so rows and columns do not prevent
reaching diagonal connections:

```text
y ↖    k ↑    o ↗
h ←           l →
n ↙    j ↓    . ↘
```

Diagonal motions first consider direct neighbours in the requested quadrant;
if none exists, they consider other nodes there. Distance and alignment choose
among candidates. A diagonal never falls back to another quadrant or a node
directly above/below/left/right. In the stages screenshot, **n** reaches
**depiction: Conflict stage** and **o** reaches **scene: Approach-avoidance, held**,
even with closer unconnected nodes and occupied rows/columns. **y** and **.**
reach the upper-left and lower-right depiction-slot nodes when no connection
competes in those quadrants. **,f** remains an exact jump when several nodes
compete for one direction.

**Shift + h/j/k/l/n/o/y/.** moves the caret node itself by 5 screen pixels in that
direction, regardless of zoom or camera rotation. Hold the chord to repeat. The
camera, other nodes, caret identity and highlights stay fixed; like dragging,
the new position is anchored against later layout reheats and saved in snaps.
Only the caret node moves even when several nodes are highlighted. Ctrl-h/l and
Ctrl-y/e pan the camera; Ctrl-o goes back through caret history. Ctrl-n/p inside
the picker and in Neovim keep their existing meanings.

**Ctrl-o** (also **g;**) retraces previous caret visits, one at a time, independently of direction.
It includes motions, node clicks, accepted search results, graph hints and **c**
jumps, skips hidden/removed nodes, and brings an off-screen destination into view.
Repeated visits to the same current node do not add history. Backtracking preserves
highlights, including selection edits made while moving. New movement after going
back starts a new branch; there is no automatic redo attached to direction keys.
History holds the latest 256 visits and stops at its beginning without wrapping.
Clearing/exiting navigation, node deletion or replacing/remounting the graph
starts fresh; re-layout keeps the caret, its history and secondary carets. Caret
history is not saved in snaps.

Hold **Ctrl-Shift** during a motion to add its destination, or **Option/Alt** to remove
it. This applies to all eight directions; **Ctrl-Shift-.** adds
the down-right destination, and **Option-.** removes it. The starting node is
untouched. There is no Visual mode. Caret navigation stops
the force layout so targets stay stable; **r** re-layouts while keeping the caret
on its node and retaining selection. Elements/Explorer selection edits keep the caret.

**Comma, then f** opens graph hints on nodes currently on screen, including dimmed
nodes. Type a label to move the caret and inspect that node. Labels use `asdhjkl`:
two letters for up to 49 nodes, then longer labels for denser views. Hold Shift or
Option on the **final letter** to add or remove that node. **Backspace** corrects
a partial label; **Escape** cancels hints without changing highlights. Invalid
labels, pointer interaction, resizing, camera changes or a new source cancel the
picker. Bare **f** hints UI controls.

Camera following minimally pans the caret into a padded viewport and zooms out
only if its body will not fit. **zz** centres the caret exactly, preserving zoom
and rotation; without a caret it does nothing. **Enter** explicitly fits the highlighted set,
accounting for node bodies. **+ / -** zoom around the explicit selection centre,
retaining that point on screen; without one, zoom uses the camera centre. Manual
panning changes neither caret nor selection.

**dd** removes just the caret node and its incident edges from the working graph,
even if that node is not highlighted. Other selected nodes keep their membership.
**d Enter** removes the explicit selection; without an explicit selection it does
nothing. Both preserve the camera and remaining node positions. After deleting
the caret, navigation continues at the nearest surviving direct neighbour, then
the nearest other visible node, or returns to Normal if none remain.

The first **d** only arms a one-second prefix, shown in the mode indicator. It
never deletes immediately or on timeout. **Escape / Ctrl-[** cancels the prefix
without clearing the caret or highlights; an invalid second key also cancels.
Holding d cannot repeat deletion. **dd** without a caret does nothing.
**Restore context** restores the original arrangement using the existing single return point. These actions never delete
database data or execute the source query.

Outside the search picker, hints and pending deletion, **Escape / Ctrl-[** clears
inspection, selection and search highlights, returning to Normal. **Ctrl-[** also
performs that full reset during hints. New
snaps/results and rebuilt renderers start in Normal; snaps save selection and
camera without persisting the caret, motion history or partial key sequences.

| Key | Action |
| --- | --- |
| `c` | Place caret nearest camera centre; preserve highlights |
| Click | Place caret on that node and inspect it; preserve highlights |
| `h` / `j` / `k` / `l` | Move caret left/down/up/right using the current layout |
| `n` / `o` / `y` / `.` | Move caret ↙ / ↗ / ↖ / ↘; prefer connections in that quadrant |
| Shift + direction | Nudge only the caret node 5 screen pixels; hold to repeat |
| `Ctrl-o` (also `g;`) | Go back through previous caret visits; preserve highlights |
| Ctrl-Shift + motion / Shift + click | Add only the destination node |
| Option/Alt + motion/click | Remove only the destination node |
| `,f` | Show graph hints; type label to inspect, final Shift/Option to add/remove |
| `Ctrl-y` / `Ctrl-e` | Move camera up/down (graph moves down/up on screen) |
| `Ctrl-h` / `Ctrl-l` | Move camera left/right |
| `Escape` / `Ctrl-[` | Clear selection, inspection/highlights, and return to Normal; Escape only cancels active hints; either key cancels the search picker or pending deletion |
| `dd` | Remove the caret node from the view; preserve other selected nodes |
| `d Enter` | Remove explicitly selected nodes from the view; Restore context brings them back |
| `zz` | Centre the caret in the viewport, preserving zoom |
| `zt` / `zb` | Place the caret ⅛ of the viewport height from the top/bottom |
| `zh` / `zl` | Place the caret ⅛ of the viewport width from the left/right |
| `Enter` | Fit the highlighted node bodies; in the picker, accept its active suggestion |
| `+` (also `=`) / `-` | Zoom in/out around explicit selection, or camera centre |
| `Space h` / `Space l` | Previous/next snap in the route-specific list, wrapping at the ends |
| `Space Enter` (also `go`) | Mark the caret's type in the other view (subtypes in Query, supertypes in Schema) |
| `Backspace` | Close an offline preview and return to the preserved live view |
| `r` | Re-layout, keeping the caret; if running, stop and restart from current positions |
| `s` | Save a snap |
| `/` | Open the node picker and select its previous query text |
| `Ctrl-n` / `Ctrl-p` | In the picker, browse next/previous suggestion; Enter sets the caret |
| `?` | Open/close shortcut help in Snaps |

Space, comma, z, g and d are one-second prefixes: release the prefix, then type the next
key. Focus changes, clicks, leaving the window or hiding the page cancel a prefix.
Bare h/l do not browse snaps. Controls work across the visible graph view; snap
chips need no keyboard focus. Motion, node nudging, pan and zoom repeat; deletion, saving,
re-layout and snap browsing do not. Inputs, the query editor, dialogs, menus and
composition keep their normal behavior. Enter on buttons remains native; in the
side panel Space is the leader (Space Ctrl-n/p), so it does not click a focused button.
The Snaps **Keys** button shows the last shortcut Studio received.

### Moving focus between panes, windows and Neovim

**Ctrl-w** works as it does in Neovim: it is a prefix, and the next key moves
focus. Inside a Studio window the panes are the tool window on the left, the
query editor, the graph, the Explorer and the tabbed panel.

| Key | Effect |
| --- | --- |
| `Ctrl-w h/j/k/l` | Move to the pane in that direction, or to the next window at the edge |
| `Ctrl-w H/L` | Go straight to the leftmost or rightmost window on screen |
| `Ctrl-w w` | Cycle through the panes in reading order |
| `Ctrl-w p` | Go back to wherever focus was last, pane or window |
| `Ctrl-w t/q/g/e/b` | Jump to the tool window, query editor, graph, Explorer or tabbed panel |
| `Ctrl-w Space j/k` | Give the focused graph or panel 10% more/less height (docks the panel below) |

`Ctrl-w H/L` are window level, not pane level. They do not stop at the edge of
the page first, because `h`/`l` already walk the panes and "rightmost pane" is
ambiguous whenever a full-width pane shares the page's right edge with a narrow
one. In the three-column arrangement `Ctrl-w H` reaches the schema window and
`Ctrl-w L` reaches Neovim, from anywhere. In Neovim these replace Vim's own
`<c-w>H/L`, which *move* a window to the far left or right; `:wincmd H` still
does that.

`Ctrl-w p` follows one merged timeline across panes and windows: whichever
focus change happened last is what it undoes. Arriving in the query window from
Neovim makes `Ctrl-w p` go back to Neovim; moving between panes afterwards
makes it return to the previous pane instead. Neovim tracks the same thing with
a `FocusGained` autocommand, so `Ctrl-w p` there returns to the browser window
you came from, and falls back to Vim's own `wincmd p` once you have moved
between Neovim's splits. Arriving somewhere by clicking rather than by a motion
leaves the window-level half of this pointing at the last motion's origin.

Motions are resolved from where the panes actually are, not from a fixed map, so
docking the side panel below the graph changes what `Ctrl-w j` does without any
setting. A pane that is not on the current route, or is hidden behind another
output tab, is skipped. `Ctrl-w Ctrl-h` and the like work too, as in Vim.

After focusing the Explorer or a Snaps, Elements or Themes panel, **Ctrl-e/y**
scroll that pane down/up. They never pan the graph while a side pane has focus,
even at the scroll boundary. **h j k l** continue moving the graph caret (in
caret mode), so you can inspect another node without leaving the Explorer.
**f** can reach controls below the fold after scrolling. `Ctrl-w g` or clicking
the graph returns Ctrl-e/y to graph panning. Text inputs retain editing keys.

**Past the last pane, focus leaves the window.** `Ctrl-w h` from the leftmost
pane, or `Ctrl-w l` from the rightmost, moves to the next window on screen. This
needs [Hammerspoon](https://www.hammerspoon.org/) running with its command line
tool reachable; the bridge asks it to resolve the direction geometrically, so it
works with whatever arrangement of windows you have rather than assuming a
particular one. Nothing happens if there is no window in that direction.

Hammerspoon only answers `hs` once its IPC module is loaded, so `init.lua` needs:

```lua
require('hs.ipc')
```

Without it every escalation silently does nothing. The bridge reports the first
failure in `:TypeDBGraphLog` rather than once per keystroke.

Neovim does the same in reverse. Add this to the Studio plugin's setup:

```lua
require('typedb_graph').setup({ window_navigation = true })
```

`Ctrl-w h/j/k/l` then behave normally inside Neovim and only escalate when the
motion changed no window — the rule `vim-tmux-navigator` uses between Vim and
tmux. It is off by default because these would be the plugin's only global maps.

For `Ctrl-w p` to cross windows as well, load the Hammerspoon helper from
`contrib/hammerspoon/typedb_panes.lua` in `~/.config/hammerspoon/init.lua`:

```lua
package.path = package.path .. ';/path/to/typedb-studio/contrib/hammerspoon/?.lua'
require('typedb_panes')
```

The helper chooses windows by geometry, independent of recent focus. With
Schema, Query and Neovim arranged left to right, west from Neovim reaches Query
even after jumping directly there from Schema. Far motions select the outermost
window in one operation. Without the helper, cardinal directions use
Hammerspoon's built-in geometric focus.

After updating an already loaded helper, reload only this module in the
Hammerspoon console:

```lua
package.loaded["typedb_panes"] = nil; require("typedb_panes")
```

Do not restart Hammerspoon or call `hs.reload()`; it owns the terminal sessions.

The arrangement this was built for is the schema route, the query route and the
Neovim terminal side by side. Opening the two routes as their own windows rather
than as tabs in one window is what makes them addressable — Chrome's
`--app=http://localhost:1430/query?nvim=1` gives a window with no tab strip, the
same way `init.lua` already opens other sites. Two tabs in one window cannot both
be visible, so only whichever is in front can be reached.

Ctrl-w is free in Chrome on macOS, where Cmd-W closes tabs. On Windows and Linux
Ctrl-W is a reserved close-tab accelerator that a page cannot intercept, so this
prefix is macOS-only.

**Check for an OS-level Ctrl-w remap first.** Karabiner and similar tools
intercept below the browser, so a rule on Ctrl-w eats the prefix before any page
sees it — and a rule conditioned on the frontmost application will break only
the browser half, leaving the Neovim half working and the cause non-obvious.
This setup had `Chrome next window map`, which aliased Ctrl-w to Cmd-` while
Chrome was frontmost; it was removed because Cmd-` is macOS's own
cycle-windows-of-the-front-app shortcut and remains available, and because
`Ctrl-w h/l` does the same job directionally.

Chrome remembers each `--app` window's position per URL and prefers that over
`--window-position` / `--window-size`, so those flags act as first-run defaults.
Place the two windows once and later launches reuse the placement.

### Native hints and Vimium exclusion

Disable Vimium entirely for **`http://localhost:1430/*`** by adding an exclusion
rule with an **empty Excluded keys field**. Use the actual host/port when running
elsewhere. This supersedes the selective character exclusions and global
`map , passNextKey` / `unmap` workaround previously documented here.

Studio now supplies **f** hints for visible, enabled buttons, links, and inputs,
including controls in open menus and dialogs. Type the displayed label to click
or focus the control. **Backspace** corrects a label; **Escape / Ctrl-[** cancels.
Scroll the panel first to reach controls below the fold; scrolling, resizing, or
pointer interaction cancels stale hints. Editable text fields keep their normal
keys. **,f** remains the separate graph-node picker.

The browser regression suite can load Vimium in an isolated profile and verifies
that its full-site exclusion leaves Studio's shortcuts and native hints working.


## Query lifecycle

`?nvim=1` enables receiving on the local Query page and remembers it for that
browser tab's session, including after connection setup or navigating away and
back. `?nvim=0` disables it. Ordinary Studio sessions are not enabled by default.
Each enabled Query tab executes incoming queries independently; an enabled Schema
tab instead focuses its schema graph.

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


## Outline and edge styles

In **Customise → Graph**, the Kinds, Types, and Edges sections have a **Dashed**
dropdown: Solid, Dotted, Short dash, Long dash, and Dash-dot. Kind settings apply
to all nodes of that kind; Types can override them or choose **Inherit**. **All
edges** supplies the default edge pattern, with individual edge categories such
as `has`, `links`, and `owns` able to override it or inherit.

The adjacent **Thickness ×** field scales the existing line weight from **0.25×
to 8×**. **1×** is the previous appearance. Kinds set the outline default; a type
can override it. **All edges** sets the edge default, and each edge category can
override it. Clear an override field to inherit again, or use the row's reset
button. Thickness works with every dash pattern and with straight or curved
edges, and is included in saved styles, portable presets, snaps and PNGs.

Patterns apply to all four node outlines and both straight and curved edges.
They are drawn by WebGL, follow camera movements, and appear in PNG exports.
They are included in local style persistence, preset import/export, and snaps;
older presets start solid. Labels, fills, and click targets stay intact.

Press **r** with the graph focused to re-layout. Repeated requests do not build up
an animation queue: an active layout is stopped and replaced from its current
positions. A request after settling performs the usual fresh redraw. The same
behavior applies to the redraw buttons. Holding the key does not auto-repeat;
text inputs and browser modifier shortcuts keep their normal behavior. With
Vimium, use the Studio site exclusion described under Keyboard controls.

## Role labels, role styles, and edge inspection

Query edges between a relation and its players show the **role name**: for
example, motivation uses `driver` and `target`, and composition uses `host`,
`slot`, and `child`. Label/style refreshes preserve those names. The short name
stays on the graph; the full name, such as `composition:host`, identifies its
style and appears in the edge inspector.

Viewer-generated neighbour/Explorer queries now return role variables. If a
query omits them, a background read resolves roles for the relation–player pairs
already in the graph. This does not add unrelated nodes, change the query editor,
or change the caret/highlight set. It can replace one unresolved `links` edge
with several role edges when that player has several roles in the same relation.
An explicitly named role remains restricted to that role. An unavailable database
or an old offline snap without role metadata can still show `links`; connect and
open the snap as an editable view to resolve it from current data. Offline snaps
with role metadata need no lookup.

In **Customise → Graph → Edges → Role types**, each loaded role has its own
colour, dash pattern, and thickness. The filter searches full names. Inheritance
is **role → links → all edges**, independently for each property. For example,
make `links` dotted, then make `composition:host` solid and thicker; all the other
roles keep the dotted default. `depiction-slot:host` is a separate style. Clear a
field or choose **Inherit** to remove that property's override; the row's reset
button removes all its overrides. Role styles travel with themes, portable
presets, snapshots, and PNG exports.

**Click an edge** to inspect its role and endpoints. This leaves the node caret
and highlight selection intact; a small thickness accent marks the inspected
edge. **Go to relation / Go to player** moves the caret with normal padded
following. **Customise role** opens Edges and reveals that role's style row.
Clicking a node or moving the caret returns to node inspection. Edge inspection
also works in offline snaps and on generic/schema edges.

Parallel edges are separated into stable curves on both sides of the straight
path, even when their endpoint directions differ. In a TypeDB relation-node
view, these often mean **one player occupies multiple roles in the same relation**.
Repeated answer rows for the same relation/player/role are deduplicated. Different
relation instances remain separate relation nodes; they are not collapsed into
parallel person-to-person links.

**`isa` and `isa!` point from instance to type**, on straight or curved edges.
Their arrow tips follow the actual node outline and are included in PNG exports,
including when labels are hidden. There is no arrow preference for these
unambiguous type assertions.

In **Customise → Graph → Edges → Role types**, each role now has **None /
Toward relation / Toward player**. None is the default. A useful starting point
is `motivation:driver` toward the relation and `motivation:target` toward the
player; symmetric `tension:pole` can remain arrowless. Direction is explicit,
not inferred from a role's name. Settings are shared by the light/dark palettes,
export with presets, and render in PNGs. Relation-valued players work too.


## Panel navigation and startup

Local `/query` and `/schema` routes start with the graph maximised. The existing
maximise toggle returns to the surrounding editor/tool panes; this is Studio's
own graph mode, not the browser's permission-gated fullscreen API.

With a side panel focused, **Ctrl-e/y** scroll its content, **gg** goes to the
top and **G** to the bottom. Explorer uses its actual instance/type detail
scroller, including after a graph caret move replaces the inspected content.
Graph caret motion remains available from panels.

**Explorer / Snaps / Elements / Themes / Customise / Source** share one tab row and one
content pane in either dock orientation. **Ctrl-f** selects the next tab and
**Ctrl-d** the previous tab, wrapping through all six. **Ctrl-w e** opens Explorer
and focuses the shared panel; **Ctrl-w b** focuses its current tab. Caret motion
keeps Themes/Customise/Elements open so styling a node doesn't hide the controls.
Node/edge clicks also keep those tabs open; **Ctrl-w e** opens Explorer when needed.

Outside the side panel, the focused pane determines the tab group: Log/Table/Graph/Raw
or the query tabs. Tab commands also work while editing a query. Dialogs and menus
keep their keys.

### Correspondence between Schema and Query

**Space Enter** (or **go**, mirroring Neovim's `geo`) sends the caret's type to
the other loaded view on the same server/database and follows the isa closure.
Schema → Query marks every visible loaded instance of the type **and of all its
subtypes** (`sub`/`sub!` descendants), so an abstract type such as `stage-intent`
finds its families' instances. Query → Schema places the caret on the instance's
exact type and marks its supertypes. The primary caret (solid corners) prefers
the current caret, then the nearest exact match; the others get dotted secondary
carets. Explicit selection is unchanged. No query is executed and no hidden
nodes are revealed. **Escape** clears the markers with the ordinary graph reset.

This works across browser tabs/windows at the same Studio origin. It does not
switch OS focus. Status names the type, how many sub/supertypes were included and
how many nodes were marked, or reports no answering view. Secondary carets are
markers: commands (zz, motions, dd, …) still act on the one solid caret.

### Layout spacing

New graphs start **Compact**. The density menu also offers **Dense** and **Tight**,
plus the former spacing levels **Balanced** and **Spacious**. These presets vary
centering force while retaining collision avoidance. Redraw keeps the chosen
spacing; a snap retains its saved density and node positions. Very dense layouts
can still have crowded labels, so use the menu to suit the graph.

### Snap appearance

Opening a snap restores its data, layout, camera, and selection using the
**current theme**. A dark capture opened after switching to a light theme stays
light, including its nodes and edges. Saved appearance metadata remains in the
file for compatibility, but opening the snap does not apply that preset.

### Anonymous relations in the initial graph

Graph context names top-level anonymous relations in a separate read, so patterns
such as `composition (...)` and `occurrence-of (...)` return relation nodes along
with their players. Fetch results remain unchanged in Neovim; the graph read
removes fetch and returns the source concepts. A successful plain match/insert
gets a separate read of its original patterns with named relations. The write is
never replayed. Negative/nested scopes and explicit select/reduce are not widened.
The graph note distinguishes this current-data context from the executed answer.
A **failed** plain insert (for example a duplicate key on a second `gep`) reads the
same insert patterns first, labelled as existing data, so a repeat shows the same
relations as the successful run rather than every attribute of the referenced
items. Only when those patterns find nothing does the looser referenced-type read
(with attributes) apply.

### Markdown emphasis in TypeQL comments

The local Neovim configuration shares the existing Markdown emphasis maps with
`.tql` / `.tqls` buffers: **,b** toggles bold on a word or visual selection,
and **,,b** removes a surrounding bold span. Comment syntax supports the resulting
`**bold**` markup while preserving the old single-asterisk convention.
Use them in comments; formatting an executable identifier changes the query text.
The maps reuse `utils.markdown_emphasis` without replacing TypeQL navigation maps.


## Caret illustrations and the two graph profiles

On a relation name, `geo` targets the relation. On a tuple role, or `links` just
before that role, Query targets the role player while Schema targets the scoped
role. Attribute variables resolve by their type and value. Variables without an
explicit `isa` can resolve to schema types through the paragraph's role and
ownership constraints, including inherited plays/owns.

The Query graph starts with the shared answer or labelled read context. Anonymous relations explicitly present in top-level source patterns are included
in the initial graph context. A subsequent `geo` can add a bounded illustration
of other missing relations or players. Schema keeps the full
schema as a stable context and highlights a relevant subset. **Isolate & layout**
uses that subset when a smaller working view is helpful. This remains a pragmatic
context policy, not an attempt to reconstruct every possible relationship on
every evaluation.


## Paired appearance and instance/type outlines (2026-09-22)

Themes now presents one **Munsell Paper · Light** and one **Ink · Dark** palette,
based on the exported Munsell Paper 8 and Ink9. The UI's effective light/dark
mode selects the graph palette automatically. Shapes, sizes, outline patterns,
thickness, label options and role arrows are shared; node/edge/background colours
remain separate. Customise saves automatically. Structural edits also reach the
other open Studio window through storage events. Colour edits affect the active
palette. Export light and dark saves both as portable presets.

The initial pair uses a muted red entity family, green relation family, ochre
attribute family and purple role family. Pale Paper and dim Ink type overrides
were adjusted against their backgrounds for readable outlines. **Solid outlines
mean instances; dotted outlines mean type nodes.** Shape/colour continue to
express entity/relation/attribute categories. The per-type dash overrides in the
original exports were removed from the initial pair because those apply to both
an instance and its type node, overriding the kind-level distinction. Future
explicit per-type edits still take precedence. Existing presets remain under
Archived presets; the previous current style is backed up on first migration.

## Pane refinements

The initial Ctrl-w motion starts from the graph if no element has acquired focus.
It no longer spends the first chord merely choosing a starting pane. A delayed
focus after a tab switch cannot override a newer explicit pane motion.

**Ctrl-w Space j / k give the focused area ten percentage points more / less
height**: with the graph focused, j pushes the panel down; with the lower panel
focused, j expands it upward. At least 15% remains for each area. From a
right-docked layout the command docks the panel below first. It measures the
rendered split, so a dragged handle is respected. The older **Ctrl-,** still
expands the focused area where the browser/OS delivers it.
**Ctrl-n/p** supplement arrow navigation in Material selects/menus and native
selects. The Query route exposes its maximised graph and fullscreen toggle once
connected with a database selected, even before the first run.

In Explorer, relations already present in the graph show **In graph** or
**Hidden**. **Mark in graph** adds a secondary dotted caret and frames the
relation while keeping the current Explorer node. **Inspect** moves the primary
caret and changes Explorer. Hidden entries offer Show & mark / Show & inspect.
**Ctrl-o** follows the existing graph caret history: marks add no history entries.
**Ctrl-n/p** move between visible Explorer controls; **Space Ctrl-n/p** jump
between the panel's main sections (Explorer's Links / Attributes / Relations,
Customise's groups, …). Space on a focused header does not click it; use Enter.
**zc/zo** close/open the section containing the focused control (or the first
section when none is focused). Every other z command — **zz/zt/zb/zh/zl** —
still places the graph caret while the panel has focus, just like hjkl. Only
Ctrl-e/y and gg/G scroll the focused panel: they act on the view you are
reading, whereas z commands are about the caret.
These actions change the view, not database contents.

## Source provenance

Neovim submissions capture the originating file, line and header text alongside
the executed query. A header beginning `# ─ ` supplies the graph title (trailing
`───` decoration is dropped), and contiguous following comment lines supply its
explanation. Both appear top-left on one translucent plate over the canvas
(click it to open Source), and in exported PNGs. The Neovim button sits top-right
beside Snap. Schema paragraphs keep their title in Query too: the helper ignores
the `define` line the runner prepends when matching the header. The sixth
panel tab, **Source**, shows the title, expandable comment and submitted query;
a different generated graph-context query is separately expandable.

**Space s** opens Source; **Space o** asks the originating Neovim session to open
the file. The jump matches the saved header text first (choosing the nearest
match to the recorded line), then falls back to that line. It uses the existing
session without forcing unsaved buffers closed. Window focus remains available
through Ctrl-w. If that Neovim session has ended, send the snippet again to
refresh its source link. Snaps retain provenance without executing any source.
Old snaps can still derive a title/comment from their saved query, but cannot
invent an absent file location. Fetching/re-running edited source is deferred.

The local code-link generator also recognises `# ─ ` headers, retaining the
existing `‖/` search suffix and `ˍ` space encoding. It no longer produces an empty
`‖*` suffix for the tour headers. This fixes the shared generator used by the
local relative/absolute link maps (currently Space cl/cL in the config).

Frontend changes hot reload. The source endpoint needs the Neovim-owned helper
restarted with `:TypeDBGraphStop` then `:TypeDBGraphStart`; reload the local Lua
loader to attach provenance to new submissions:

```vim
:source ~/.config/nvim/plugin/ftype/typedb_graph.lua
:source ~/.config/nvim/plugin/utils/NewBuf-LinkPaths.vim
```

No Hammerspoon change or restart is involved.
