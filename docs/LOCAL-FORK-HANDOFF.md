# Local Studio fork: maintainer handoff

Updated 2026-09-15. Read this first, then [the workflow guide](local-graph-viewer.md).
This is a personal, evolving graph exploration tool integrated with Neovim.
An upstream PR is not a goal. Keep working in this repository and reuse Studio's
existing components where helpful; improve the design as actual use suggests.

## Current entry points

- Working branch: `feat/nvim-studio-query`.
- Browser: **http://localhost:1430/query?nvim=1**, normal Studio with fullscreen,
  Explorer, and editable query tabs. Use `/schema?nvim=1` in a second tab for
  parallel schema context, or enable **Follow Neovim** on `/schema`.
- Neovim loader on this Mac: `~/.config/nvim/plugin/ftype/typedb_graph.lua`.
  It loads `contrib/nvim/typedb_graph.lua` from this checkout. Existing `gep`,
  `geq...`, schema inspector, and TypeDB start/stop integration also involve
  `~/.config/nvim/plugin/ftype/typedb.vim`. Those external files are not versioned
  here; inspect them before changing the integration.
- Current specimen project: `~/Documents/Proj/e2/pts`, database `pts-tour3`.
  Useful source files are `temp/schema_pts-tour3.tql`,
  `specimens/mechanism/schema.tql`, and `specimens/mechanism/tour.tql`.
- PNGs: `<project>/temp/imgs/<db>/`; data snaps:
  `<project>/temp/snaps/<db>/`. Never silently fall back to Downloads.
- Use `localhost:1430` consistently. Themes, saved connections, and project
  preferences belong to the full browser origin, including the port.

## Start and validate

Use Homebrew Node 22 at `/opt/homebrew/opt/node@22/bin/node` (the previous broken
shared-library installation was repaired). Typical commands:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pnpm install --frozen-lockfile
pnpm viewer:dev
```

The helper serves port 1430 and starts/proxies Angular on 1431. `pnpm build:viewer`
then `pnpm viewer` serves static assets instead. Initialize missing workspace
submodules with `git submodule update --init --recursive`; `typedb-web` is a real
Git submodule, not an intentionally empty application directory. Submodule edits
need their own Git commit and explicit communication.

Neovim starts the helper automatically. Use `:TypeDBGraphLog` to inspect its
terminal. `:TypeDBGraphStop` / `:TypeDBGraphStart` restart the job that Neovim owns.
Do not kill an existing user-owned job merely to test a change. Frontend dev
changes hot reload; Node server edits require restarting the bridge. Tests below
use independent ephemeral ports and temporary directories.

```sh
pnpm test:viewer
node scripts/nvim-caret.test.mjs
pnpm build:viewer
node scripts/viewer-shortcuts.browser.mjs
```

**Do not restart Hammerspoon to test a window-focus change.** It launches the
user's Alacritty/Neovim windows; killing it killed every running Neovim, and with
them the terminal buffers agents run in. Edit `~/.config/hammerspoon/init.lua`,
then ask the user to reload. The same rule the viewer job already has: never
restart something the user's session is living inside.

Pane navigation across windows cannot be covered by these: the browser check
stubs `windowFocus` so the suite never moves this machine's focus, and the
Neovim and Hammerspoon halves are checked by hand. Verify those by pressing
`<c-w>h` in Neovim's leftmost window and `<c-w>l` from the Studio side panel.

The unit/server suite covers query preparation, operation context, labels,
selection, snap parsing, path/counter behavior, deletion, and bridge transport.
The browser smoke test uses synthetic snaps and Angular's local-build debug API,
without connecting to TypeDB. It checks shared canvas keyboard handling, selection
through the real interaction handler, camera framing, file saving, and restoration.
It uses installed Chrome and finds an existing Playwright installation; alternatively
set `PLAYWRIGHT_MODULE` to `playwright/index.mjs` and `CHROMIUM_PATH` to Chromium.

To reproduce Vimium interception, also set `VIMIUM_PATH` to an unpacked extension
directory. The script copies it into a temporary profile and tests both default
bindings and the pass-through rule. Extension loading requires a Chromium build
that supports `--load-extension` (ordinary branded Chrome may ignore it).
On this Mac, the tested executable was
`~/Library/Caches/ms-playwright/chromium-1161/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
and the installed extension was under Chrome's Default profile at
`Extensions/dbepggeogbaibhgnhhndojpepiihcmeb/2.4.2_0`.
These versioned paths are conveniences, not project requirements.

Manual checks when modifying live graph lifecycle:

1. Submit a read from Neovim and inspect the same query tab in fullscreen.
2. Save a snap with expansions, hidden nodes, selection, theme, and camera changes.
3. Open it from a chip; verify the route stays `/query` or `/schema` and only that
   route's snap kind appears. Connected snaps become editable runs/views. Query
   restores its source into the editor, with the normal Explorer and no source rerun.
   Offline previews remain isolated and can return to the preserved live view.
4. Repeat with the panel docked below the graph; resizing/docking remounts canvases.
5. Submit a new Neovim query while viewing a snap; the new live result should appear.
6. Check the two actual project directories and delete a throwaway snap with ×.

## Architecture and ownership

| Concern | Main code |
| --- | --- |
| Neovim job startup and query/outcome delivery | `contrib/nvim/typedb_graph.lua` |
| Local HTTP helper, SSE, Angular proxy | `scripts/viewer-server.mjs` |
| Project resolution, safe snap/PNG files, numbering | `scripts/viewer-export.mjs` |
| Incoming events and query lifecycle | `src/service/nvim-query-bridge.service.ts` |
| Neovim identifier/variable navigation | `src/framework/util/editor-caret.ts`, `contrib/nvim/typedb_graph.lua` |
| `<c-w>` pane focus, and its escalation to the window manager | `src/framework/util/pane-focus.ts`, `src/service/pane-focus.service.ts`, `src/framework/pane-focus/pane.directive.ts`, `contrib/hammerspoon/typedb_panes.lua` |
| Bounded schema focus from original editor source | `src/framework/util/schema-focus.ts`, `src/module/schema/schema-page.component.ts` |
| Query conversion / compatible relation augmentation | `src/framework/util/graph-query.ts` |
| Context following writes/schema changes | `src/framework/util/operation-context.ts` |
| Canvas, finder, exports, inline snap overlay, shortcuts | `src/framework/graph-visualiser/canvas/graph-canvas.component.ts` |
| Snap context, HTTP requests, active filename | `src/service/graph-snapshot.service.ts` |
| Capture/restore, rendering, labels and camera | `src/framework/graph-visualiser/engine/index.ts` |
| Mouse caret inspection and exact modifier selection | `src/framework/graph-visualiser/engine/interaction-handler.ts` |
| Shared explicit selection and overlapping groups | `src/framework/util/graph-element-selection.ts` |
| Snap format/parser | `src/framework/util/graph-snap.ts` |
| Explorer tabs and inspectors | `src/framework/graph-visualiser/side-panel/`, `explorer/` |
| Theme persistence / display-attribute loading | `src/service/graph-style.service.ts`, `graph-label.service.ts` |

Neovim POSTs to `/api/viewer/query`. The helper pushes events over **SSE** at
`/api/viewer/events`; no custom WebSocket or dependency on Vite HMR is needed.
It retains the latest pending request. An enabled Query tab prepares a graph read
and runs it through normal Studio execution. An enabled Schema tab passes a focus
callback to the same bridge: it selects known types and bounded role/player context
in its loaded graph, without running the data query. Each tab receives independently.
Route attachment resets event deduplication so the latest SSE replay reaches the
new route. A schema operation refreshes the schema before focus; database switches
wait for the matching schema. Schema source provenance travels via the canvas's
`contextQuery` input. The existing project service remembers the incoming directory. Latest unpinned query tab is reused. Completed writes/schema
operations are **not replayed**: their outcome triggers a separate contextual read.
The workflow guide documents the payload and transaction rules in detail.

POST `/api/viewer/focus` takes one of `west/east/north/south/previous` and spawns
Hammerspoon's `hs -c`. It broadcasts nothing and leaves the replayable latest
query alone: a focus motion is an OS gesture, not viewer state. The direction is
a closed set and each one maps to a fixed Lua string, so nothing from the request
reaches the shell. `createViewerServer({ windowFocus })` overrides it, which the
tests use to avoid moving the machine's real window focus.

File API: POST `/api/viewer/project`, GET `/api/viewer/snaps`, GET/POST/DELETE
`/api/viewer/snap`, POST `/api/viewer/export`. Requests include database and project
temp context. Filename counters use exclusive filesystem creation, independent
per directory. Listing reads real files; no localStorage-only snap catalogue.
Project context inferred from a Neovim schema file can be overridden in Snaps.

## Preserve these invariants

- **Connected snaps restore as ordinary editable views.** QueryPageState creates
  a normal run from the saved graph, replaces an unpinned result, preserves pinned
  results, and creates a new query tab when the current tab is pinned. Root styles
  adopt the saved preset, as for live Studio styling. The source query is inserted
  but never executed. Run `restoredSnap` marks provenance and enables ordinary
  instance/type Explorer controls. Schema uses `VisualiserState.restoreSnapshot`.
- **Offline previews still use a separate renderer.** The canvas falls back to the
  child style injector/inline overlay when disconnected, on another database, or
  awaiting schema. Explore live promotes the preview after the connection is ready.
  Backspace/Live view closes only previews. Keep `/snap` for standalone imports/tests;
  chips stay on their existing route.
- **Remounting is not a new query.** Docking or fullscreen changes may replace DOM
  containers. Reattach both renderers; do not discard a snap simply because the
  live canvas is rebuilding. Schema also handles the canvas-rebuilt event. Returning
  live invalidates pending snap reads so a late response cannot reopen an overlay.
  Schema remounts import graph state before constructing `GraphVisualiser` so its
  explicit selection is initialized correctly (import the serialized export: importing
  a Graphology graph instance omits graph attributes), and retain the new reducers rather
  than callbacks bound to a destroyed visualiser.
- **Snapshots contain rendered data.** Query and expansion strings are provenance;
  restoring does not rerun them. Graph attributes, node positions, styles,
  display-attribute cache, selection, camera, and viewport are recorded. Explorer
  reads cached data in previews and current data in editable restored views. Exact
  pixels can vary with browser/window/fonts.
- **Inspection and explicit selection are separate.** Plain click or caret motion
  updates Explorer without affecting node/edge fading, search or shared selection.
  Ctrl-Shift motion / Shift-click adds exactly the destination; Option/Alt removes it, idempotently. Reducers
  use explicit selection, search/finder and style highlights independently of the
  inspected node/periphery. The first exact edit starts from the effective highlight
  set. Legacy neighborhood groups remain readable in snaps; new mouse gestures
  do not create groups. Sigma double-clicks use the same caret/edit path and
  suppress the default zoom, so rapid node clicks remain exact. None is active-empty;
  Clear restores style highlighting.
- **Keyboard ownership belongs to the visible graph.** Capture listeners ignore
  editable fields, overlays, composition, unrelated modifier chords, and hidden canvases.
  Only motion/nudge/pan/zoom repeat; Ctrl camera/reset chords are explicitly allowed.
  Track pointer/focus ownership when multiple graphs exist. Remove listeners on
  destroy. Enter in search inputs remains handled by those inputs.
- **Pane focus is separate from graph keyboard ownership.** `PaneFocusService`
  owns `<c-w>` on its own window capture listener and the canvas bails out while
  a chord is pending (`chordPending`), because listener order between the two is
  not guaranteed. The prefix must keep working inside the query editor and other
  editable fields — the one deliberate exception to the rule below — or focus
  could enter the editor and never leave. Focusing a pane hands the keyboard
  away from the graph through the existing `focusin` listener; that is the
  feature, not a regression, since it is what lets Vimium scroll the pane and
  put `f` hints on controls below the fold. Panes are resolved from live rects,
  so no layout table exists to fall out of date when the dock flips. Motions
  that find no pane escalate; nothing in the browser, the bridge or the Lua
  knows the user's column order.
- **An OS-level remap outranks everything here.** Karabiner intercepts below the
  browser, so a Ctrl-w rule silently eats the prefix. A rule conditioned on the
  frontmost application breaks only the browser half while Neovim keeps working,
  which hides the cause. Check `~/.config/karabiner/karabiner.json` before
  debugging the page.
- **Vimium runs earlier.** Keep UI f hints with the site's character exclusions
  `abcdghjklnoprstyzASDHJKLNOY.;/?>+-=` and custom mappings `map , passNextKey`,
  `unmap <c-e>` and `unmap <c-y>`. Comma and f must
  not be excluded. Studio accepts the forwarded f as graph hints. See the workflow
  guide for setup and custom-chord caveats. Validate in an isolated extension
  profile; never change the user's active browser settings implicitly.
- **Labels and attribute nodes are independent.** Loading display attribute values
  for labels must not add graph nodes. Explicit Explorer attribute expansion may.
- **SCSS host rules must stay isolated.** Several side-panel components share
  styles. Layout `:host` rules belong in the dedicated host stylesheet; see AGENTS.

## Remaining scope and next experiments

Sigma is pinned to **3.0.1**; layout is D3 force. No v4 migration has been done.
[Graph visualization experiments](graph-visualisation-experiments.md) records the
user's dotted edges, grouping, force controls, and semantic-layout ideas against
the mechanism schema. Saved snaps provide reproducible fixtures for that work.

Current augmentation is pragmatic and bounded. It cannot infer arbitrary query
intent or guarantee useful context after every failed write. Preserve the original
Neovim execution and make the separate graph query visible/editable. Explorer
expansions often offer better choices than asking the user to type relation names.

Current shortcuts: Ctrl-w h/j/k/l pane focus (w cycle, p previous across panes and windows, H/L outermost window, t/q/g/e/b direct, escalating past the last pane), c caret, hjkl spatial move, n/o/y/. diagonal move (↙/↗/↖/↘), Ctrl-o (also g;) caret history, Shift nudge, Ctrl-Shift add / Option remove destination, ,f node hints, Ctrl-y/e/h/l pan,
Esc/Ctrl-[ clear (or cancel pending deletion), dd remove caret / d Enter remove selection from view, Space h/l browse, Backspace close preview,
zz centre caret without zoom, zt/zb/zh/zl position it at a ⅛ viewport inset, Enter focus, +/- zoom, r re-layout, s save, / node picker, ? help.
In the picker, Ctrl-n/p or arrows browse; Enter sets the caret and Esc/Ctrl-[ cancels.
See the workflow guide for selection semantics and Vimium instructions. No hover
preview or tooltip is attached to snap chips; × deletes immediately, without a dialog.

The durable browser smoke test covers the shared canvas on the standalone surface.
It does not replace the live Query/Schema/docking checks above. Existing build
warnings about unused SpinnerComponent imports are unrelated to these features.
Keep new validation scripts reproducible and update this handoff as decisions change.

## Parallel schema validation

`node scripts/viewer-schema-focus.browser.mjs` is an additional live, read-only
browser check. It requires TypeDB and an existing database containing the current
specimen's `motivation`, `goal`, `scene`, and `scene-take` types. It defaults to the
local `pts-tour3` connection; override `TYPEDB_TEST_DATABASE` and
`TYPEDB_TEST_CONNECTION` if needed. It creates an isolated local HTTP server,
browser profile, and temporary project, and never submits a write transaction.
Synthetic schema-completion notifications exercise refresh/context handling.

It checks parallel Query/Schema delivery, role/player focus, no data run in the
Schema tab, pause/resume and replay, docking with subsequent selection edits,
schema refresh, snap provenance and return to live, and unknown-type fallback.
The normal unit suite includes the bounded selection algorithm and lexical cases.
Automatic schema framing waits up to 60 visible animation frames for a running
layout, and cancels when the user changes selection, opens a snap, pauses following,
or replaces/destroys the renderer. Avoid freezing a freshly loaded graph at its
initial random positions, especially in the second/background tab.

## Editable snap runs

`node scripts/viewer-live-snap.browser.mjs` exercises the full read-only workflow
against the same local specimen as the schema test: exact saved graph/camera/query
restoration; normal here/every inspectors; attribute and relation expansion;
hide/show; docking; a new expanded snap with provenance; source file immutability;
and pinned-run reuse after a subsequent Neovim query. The standalone shortcut smoke
test remains a preview/offline test. No database writes are used in these tests.

Query restoration lives in `QueryPageState.restoreSnap` and
`GraphOutputState.restoreSnapshot`. The mutable graph must be imported from a
**separate deep clone** of `_restoredView.graph`: Graphology reuses imported node
attribute objects, and constructor/style/label passes would otherwise corrupt the
saved restoration values. After constructor passes, restore captured attributes,
display-label cache, camera, and selection. Emit an inspected-node selection too,
so clicking the already-selected saved node does not leave Explorer empty.

Restored runs use the interactive D3 supervisor on reattachment, and capture their
current view/cache at detach. Expansion results push through the same GraphOutputState
as live runs; `onGraphUpdated` loads label values. GraphViewState routes restored-run
expansions through independent reads for their database, rejects database mismatches,
and destroyed outputs ignore late pushes. Cached inspector mode is used after a
connection/database mismatch. Saving takes the live run's expansionQueries rather
than the origin snap's older list.

`GraphSnapshotService` uses the same-origin BroadcastChannel
`typedb-studio-schema-context` to notify already-open following Schema tabs of a
restored Query source. NvimQueryBridge only consumes those messages in schema mode;
Query tabs do not execute them. The restoring Query bridge adopts the source with
pending=false. These are browser context notifications, not new Neovim/SSE requests;
new/reloaded tabs still receive the helper's latest Neovim event. Offline preview
restoration sends no context notification. The snap-file format remains version 1.


## Reversible working graphs

`GraphVisualiser.isolateSelection()` uses the same effective highlighted set as
Enter/Focus. It checkpoints topology, coordinates, bbox, and camera; physically
removes unselected nodes/incident edges; then redraws the induced graph. D3 needs
no second filtering path: omitted nodes cannot influence the simulation. Explorer
`removeFromGraph` and existing connection unloads share the reversible checkpoint;
removing one node stops layout and holds positions/camera, while existing bulk
unload callers may perform their normal gentle reheat.

`graph.attributes.workingContext` contains one `GraphWorkingContext` (nodes, edges,
bbox, camera), without graph attributes or nested contexts. The helper in
`src/framework/util/graph-working-context.ts` deep clones before saving/importing.
Restore brings back missing original nodes and edges, resets original node positions,
and retains new nodes/edges and current selection/styles. It is one return point,
not an undo stack. Context uses snap-format v1's extensible graph attributes; parser
validation checks parked graph geometry/topology before it can be restored.

The graph attribute survives normal run preservation, schema remounts, and snap
capture. Source and expansion queries remain provenance; isolation does not rewrite
or run TypeQL. No database mutation occurs. Incoming known schema source context
calls `restoreContext()` before computing node keys, preserving the stable full
schema's positions after local isolation. New schema source following a restored
schema snap still uses the existing full-schema refresh path.

Selection overrides are serialized in `elementSelection.neighborhoods.excluded`.
Exact toggles seed from the *effective* ordinary highlight when explicit selection
is inactive. Type edits reset group bookkeeping; Clear/All resets exclusions.
Inspecting remains separate. Selection reductions clear missing inspected nodes and
prune secondary anchors, preventing absent node keys in highlights and saved views.
The toolbar target now uses the same highlight set as Enter, not just inspection.

Validation: 53 unit/server tests; expanded shortcut browser test checks exact edits,
UI isolation, induced edges, and original camera/position restoration. Live snap test
checks Explorer expansion of a one-node subset, saved working context, remount and
restoration. Parallel-schema browser test checks full topology and every original
coordinate after a new source exits a working subset. No writes or production
browser profile changes are involved.

`handleQueryResponse` includes newly loaded graph keys in an active shared selection.
`includeAddedNodes` preserves neighborhood groups and exact exclusions; ordinary
inspection still recomputes periphery metadata for Explorer, without renderer fading.


## Dash styles and interruptible re-layout

`r` uses the shared graph shortcut handler and `GraphVisualiser.reLayout`. Running
D3 simulations stop before a replacement starts from current positions; settled
redraws randomize as before. No unbounded queue or deferred callbacks. All existing
reLayout callers get this behavior. Native key repeat and editable/overlay targets
are ignored for r; use the selective Vimium setup in the workflow guide.

`lineStyle` on node styles inherits type → kind → solid. Edge styles use
`edgeLineStyles` and `defaultEdgeLineStyle`, with optional fields for backwards
compatibility. GraphStyleService persists/captures them and graph-presets validates
the enum. Reducers resolve current styles for new nodes/edges and PNG rendering.
Four node programs share outline-dashes GLSL and line-style.ts's dash mask.
`withEdgeDashes` extends the pinned Sigma 3 rectangle/curve programs; it adds an
instanced attribute and fragment mask without changing their picking surface.
Curved patterns use the existing nearest Bezier parameter plus Simpson arc-length
approximation. The wrapper depends on the pinned upstream shader declarations;
recheck its insertion points when upgrading Sigma or @sigma/edge-curve.

`node scripts/viewer-dashes.browser.mjs` tests actual dropdown inheritance, the
four shape programs, straight/curved edge rendering, snap restoration, and PNG
export in a synthetic database-free fixture. It writes a gallery and PNG to the
OS temporary directory. The shortcut browser suite checks two actual r presses,
including the coordinates passed into a replacement running simulation.

## Schema Explorer additions in Query

The schema Explorer originally navigated only nodes already in the graph, which
disabled missing connections in the bounded Query results produced after `gep`
schema operations. With an attached schema-mode `RunOutputState`, connection
chips now call `GraphViewState.fetchSchemaTypes`; the full Schema route retains
its existing navigation behavior. Offline previews navigate only loaded nodes.

`schemaExplorerSeeds` resolves chips against the current loaded schema, maps role
chips to relations that relate those roles (including inherited roles), and
deduplicates. `schemaContextForTypes` is the existing editor schema-context builder
extracted for reuse. Reads use an independent read transaction, 50-seed batches
to preserve query structure, and the same 100000-row ceiling as schema loading.
Database/destroyed-run checks discard stale results. Successful responses push
through GraphOutputState and record expansionQueries, so shared selection,
deduplication, working graphs, and snap preservation use existing machinery.

Explorer keeps the source inspected for successive additions. Topology changes
get a soft reheat with preserved camera; an already-complete neighborhood is
revealed without another layout. Loading disables connection chips and errors
remain visible. Query's snap-kind filter now follows schemaMode, allowing these
schema-context snaps to appear and restore in Query, rather than requiring the
Schema route. The full Schema route still lists only schema snaps.

Validation: 55 unit/server tests, local viewer build, existing live-snap browser
test, and `node scripts/viewer-schema-expand.browser.mjs`. The latter reads the
live pts-tour3 schema before sending a synthetic completed-definition notice;
it never executes the definition. It clicks take → take-includes, checks roles
and player types, unchanged source/run/camera, duplicate suppression, reloading
after removal through a role chip, and section expansion after restoring a snap.
Test servers and saved files use ephemeral ports and temporary project folders.

The shared graph keyboard handler also maps literal `+` / `-` to zoom in/out.
`GraphVisualiser.zoom` shares the existing toolbar factor (0.7) and 150ms camera
animation with both controls. No modifier chord is required (Shift may produce
the literal `+`); editor/input protections and browser zoom chords remain intact.
The former `hlsr/?+-` Vimium pass-through list is superseded by the selective
setup in the workflow guide. The shortcut browser suite verifies
actual camera ratios and that typing these characters in the finder does not zoom.


## Caret graph navigation and exact selection

Neovim normal-mode Enter sends `/api/viewer/caret` with paragraph `source`,
zero-based `line` and UTF-16 `column`, `schemaOnly`, and optional `database`.
Ctrl-n/p call the user's existing `Tdb_MainStartBindingForw/Backw` and `ScrollOff`,
then send schema-only caret events after a successful move. The repo Lua helper
installs buffer-local maps after the existing filetype maps and on setup; the
external Neovim loader/config needs no source edits. Navigation never starts a
viewer job. Reload the helper and restart the user's Neovim-owned bridge to adopt
server changes; validation must continue to use isolated servers.

The SSE channel broadcasts non-replayed `caret` and `control` events, independently
of the latest executable `query`. Neovim geo aliases Enter; control_prefix defaults
to `<leader>gv`, avoiding the user's existing `<leader>v` argument-list maps. Lua
serializes navigation/control POSTs so Enter followed by a view command retains
wire order. `/api/viewer/control` accepts a finite command allowlist plus database
and project directory. Commands never open/switch databases or start viewers;
each following tab acts on its current matching canvas. `drainControls` waits for
caret reads and runs commands through `GraphCanvasComponent.runViewerCommand`.
Controls include z placement, pan, zoom, history, fitting, snapshot and re-layout.
Background-tab camera updates complete without animation. Snapshot commands use
the same project-aware save path as the browser. Neither event replays on reconnect.

`editorCaretTarget` reuses the lexical scanner and resolves declarations, scoped
roles, typed variables, anonymous/named relation bindings, literal attributes and
variable attributes. A later plays clause cannot turn entity take into a role.
A relation-line target now identifies that relation using **all** bound players;
explicit cursor placement on a variable still follows the player. The target's
paragraph binding graph is compiled by `editorIllustrationQuery` into a fresh
read, never source write text. Untyped variables include connected relation/has
patterns for inference. Reads are bounded to 20 rows and 32 variables. Unsupported
full-language constructs are not evaluated. Blank lines delimit the source context.

Manual Enter/geo now appends missing illustrative Query data, superseding the
previous visible-only preference. `GraphOutputState.pushIllustration` shares the
normal push path but suppresses selection growth. `placeIllustrationNodes` freezes
normalization and places only new nodes near existing neighbours, preserving old
coordinates/camera/highlights. Read provenance is appended to expansionQueries for
snapshots. Hidden targets stay hidden; zero matches leave the view unchanged.
Latest-request, current-run, renderer, connection/database and manual-caret guards
prevent a stale read from moving the caret **or appending nodes**. Schema jumps and
Ctrl-n/p remain navigation-only. Editor jumps use `pointCaret(key, "none", true)`,
sharing padded minimal follow with graph motions; explicit zz centres the node.

`centreCaret(x,y)` positions the node at a fractional viewport coordinate using
Sigma's inverse transform, preserving zoom and rotation. zz uses (.5,.5);
zt/zb use y=.125/.875, zh/zl use x=.125/.875. Both dimensions stay centred on
the unrequested axis. Vimium must pass b/t as well as the existing z/h/l keys.

Line thickness is a multiplier (0.25–8, default 1) next to the dash controls for
node kinds/types and default/per-label edges. `lineThickness` follows type → kind
inheritance; blank resets inheritance. `defaultEdgeLineThickness` and
`edgeLineThicknesses` follow the existing edge style cascade. Preset parsing,
storage, snapshot capture/restore and resets include these optional fields; old
presets retain their appearance. All four node shaders receive the multiplier;
edge reducers scale existing edge size for both straight and curved programs.

`src/framework/util/graph-navigation.ts` owns transient Normal/Caret state, a
screen-space directional heuristic, exact modifier intent and deterministic hint
labels. `moveNavigation` supplies Graphology's direct neighbours, regardless of
edge direction. `navigationPoints` also supplies screen-space half-width/height
from the same glyph scaling used for body fitting. Ranking first looks for node
bounds overlapping across the motion axis (columns for j/k, rows for h/l), then
chooses the next centre along the motion axis. Alignment/connection score and key
break ties at the same axis position. Thus wide, staggered nodes remain traversable
in vertical/horizontal order even when their centres fall outside the old cone.

Without overlapping bodies, ranking falls back to a forward 90-degree cone (or
half-plane if empty), then distance with lateral drift and a threefold connection
preference (divide the score by three). Diagonal n/o/y/. motions use normalised
45-degree vectors and strict quadrants (both coordinate deltas must have the
requested sign). Direct neighbours in that quadrant take priority over all
unconnected nodes; distance/alignment ranks each set. They do not use body overlap
or fall back outside the quadrant. Hidden/nonfinite nodes are omitted before ranking.
All three supplied screenshot layouts are regression fixtures: evidence → take-includes
→ goal with k; Fear → tension → motivation → goal with j; and stages → depiction
with n / stages → scene with o despite nearer unconnected candidates and occupied
cardinal rows/columns. Browser fixtures calibrate rendered body dimensions as well
as centres; unit tests also transpose/scale layouts to check invariance.
GraphCardinalDirection keeps camera pan restricted to horizontal/vertical axes. Shift and
Option work with all eight caret directions; Shift-period (>) and macOS
Option-period (≥, physical Period) normalise only for motion. Shift directions
nudge the caret node via `nudgeCaret`, five screen pixels using
Sigma's graph/viewport transforms (including rotation). Freeze bbox/camera and stop
layout first; pin the new position as for dragging, without reheating neighbours.
Selection/history are untouched. Horizontal pan is Ctrl-h/l, vertical Ctrl-y/e;
Ctrl-o (also g;) retraces history. Ctrl-Shift directions add the destination;
Shift-click and Shift hint completion still add, and Option removes. The Vimium
exclusions include n/o/y/. and N/O/Y/> as well as g/; for history.

Direction keys never consult history. `GraphNavigation.visit` records motions and
pointer/search/hint/c jumps, suppressing consecutive duplicates and retaining 256
prior visits. `back` pops to the next available non-hidden node without recording
the return as a fresh visit. g; stops at history's beginning and does
not change selection or trigger browser navigation/open-file. A new move after
backtracking creates a new branch. Renderer/result/reset/deletion starts fresh;
history is transient. This replaces the former opposite-key reversal and redo.
There is no Visual mode.

`GraphVisualiser.pointCaret` unifies clicks, picker results and hint jumps; `moveNavigation` uses
the same selection edit helper. Both inspect through `inspectKeyboardNode`,
retaining here/every preference and updating even another instance of the same
type. Plain inspection cannot alter reducer highlighting or clear searches.
Ctrl-Shift motion / Shift-click and Option edits use `toggleSingle` only when membership must actually change,
so they remain idempotent and legacy snap exclusions keep working. External
selection edits do not reset the caret. Re-layout, renderer remount and snap
restoration start Normal. Removing the caret externally clears stale state.

The canvas handles one-second Space/comma/z/g/d prefixes, the Ctrl allowlist and graph
hints. Hints use only on-screen non-hidden nodes (including dimmed ones), fixed
length labels from `asdhjkl`, and final-key modifiers. Escape cancels hints;
Ctrl-[ clears everything. Hint geometry is frozen and invalidated by camera/size/
source changes, pointer interaction, focus/window/visibility changes and teardown.
Key handling respects editors, overlays, composition, hidden canvases and native
button activation. Mac Option motion uses physical key codes when event.key is
an accented/symbol/dead key. Only motion/nudge/pan/zoom repeat.

Sigma's hover canvas renders four constant-width caret corners from reducer-only
attributes, including on dimmed nodes. No snapshot-format change or serialized
caret, history or hint/prefix state. Node hints are temporary DOM overlays.

Navigation stops layout and freezes normalization, minimally pans the caret into
a padded viewport, and only auto-zooms out if its body is too large. Enter fits
the effective highlighted bodies using Sigma glyph scaling. Zoom uses the explicit
selection's screen-space centre. New camera animations replace the old one; manual
pan does not change selection. `centreCaret` (zz) pans to the node’s normalized
coordinates, preserving ratio and angle. Sigma schedules the final projection
after camera animation completion; browser assertions wait for that render.
`removeSelectedFromGraph` and `removeCaretFromGraph` share removal machinery,
keeping camera/remaining positions and pruning only removed selection members.
A surviving caret stays put; a removed caret continues at the nearest direct
neighbour, then nearest visible node, without selecting it. Restore context uses
the existing single checkpoint.

Single d no longer deletes immediately: it arms the one-second deletion prefix.
`dd` removes the caret; `d Enter` removes the explicit selection. Timeout, invalid
continuations and Escape/Ctrl-[ cancel without mutation. Auto-repeat cannot arm or
complete deletion. Modifier-only keydowns wait for the complete chord, so
Ctrl-[ cancels a pending deletion without globally clearing selection. The prefix is tied to its renderer and caret so external
caret changes cannot redirect a pending dd. Existing focus/source/visibility
cancellation applies. Query-running guards block deletion. No new Vimium exclusions
are required because d was already passed through.

The former search/finder controls are one `Find node (/)` combobox. `finderEntries`
returns individual non-hidden nodes, including off-screen/dimmed nodes, and fuzzy
results are capped at 60. Input holds focus while Ctrl-n/p or arrows wrap through
suggestions; Enter/click commits through `pointCaret(..., "none", true)` and blurs
for graph navigation. Escape/Ctrl-[ only cancels the picker. Typing, browsing,
clearing and accepting never call selection/search-fade APIs. Focus leaving the
picker also dismisses it: Vimium can consume Escape in insert mode and blur the
input before Studio sees the key. Legacy `searchTerm` and `finderMatches` snap
fields remain readable; no snap-format change is needed.

`CustomiseTabComponent` persists section collapse booleans through `StorageService`
in `typeDBStudio.graphCustomiseSections`. Keep these separate from GraphStyleService:
UI changes in an offline preview must not save its captured preset as global styles.
Caret changes highlight/pin the matching Types row and scroll only `.panel-scroll`.
The row survives the manual filter/100-row cap. Do not auto-expand Types; the user's
collapsed state wins, and Reveal style is the explicit expansion action. Preferences
survive component recreation, routes, docking and reload on the same origin.

Unit checks are included in `pnpm test:viewer`. The shared browser helper in
`scripts/graph-navigation.browser-checks.mjs` runs in offline previews, live Query
and Schema, covering independent caret/highlights, exact modifier clicks/motion,
hints and final-key modifiers, body fit, anchored zoom, zz, Ctrl pan/reset, prefix
timeout, picker keyboard/click acceptance and cancellation, input protection,
spatial movement, screenshot geometry, g; after motions/clicks/search,
dd/d Enter, cancellation/repeat guards
and context restore. `graph-customise.browser-checks.mjs`
covers expansion persistence through tabs/docking/fresh pages/reload, real-click
caret type following, filter reachability and preset isolation.
The shortcut browser script also supports the installed Vimium in an isolated
profile. All browser fixtures use temporary working graphs and never write TypeDB.

`scripts/nvim-caret.test.mjs` starts a headless Neovim with an isolated config and
HTTP server. It checks real Ctrl-n/p/Enter/geo and viewer-control maps, unchanged editor cursor, scoped
paragraphs, Unicode byte-to-UTF-16 conversion, and unaffected non-TypeQL/insert maps.
`scripts/editor-caret.browser-checks.mjs`, called by the live Query suite, verifies
exact relation identities from the mechanism tour in two following Query tabs and
a Schema tab, bounded illustrations and preserved old positions/highlights/query,
hidden/no-match handling, stale-read rejection, remote view commands and real snap saving. The live fixture also requires
the tour's depiction, slot-def, occurrence and mental-state instances/ID values,
and visible take / scene-take instances for declaration-versus-role navigation.

Validated 2026-09-14: all 83 unit/server tests and the separate real-Neovim test pass; `pnpm build:viewer` succeeds
with only the existing unused Spinner warnings. Browser suites pass in ordinary
Chrome, Vimium 2.4.2 with selective exclusions, live Query and live Schema. The
extension test activates an actual Elements chip via bare f, then exercises ,f
node hints, modifier completion, zz, Ctrl-n/p, Enter, picker cancellation,
body-aware row/column progression and connected diagonal reachability across all
three screenshots, all four diagonal keys with Ctrl-Shift/Option (including >, ≥ and
dead-key Option-n), hidden-neighbour fallback, Ctrl-o visit history and dd/d Enter
deletion. The same shared navigation checks pass on live Query and live Schema.
All five z-position commands preserve zoom/rotation in browser checks. Thickness
inheritance, capture/restore, edge reducers and all four outline programs are
covered and visually inspected. All eight Shift nudges preserve camera, other node
positions, selection and history at two zoom levels and two rotations, including
with Vimium enabled. Live editor caret integration verifies declaration/plays
targets and exact camera preservation for visible targets; off-screen targets
stop at the padded edge. This latest run used read-only queries against pts-tour3
on TypeDB CE 3.12.3. The initial editor bridge validation also passed on a separate
temporary instance when the user's server was offline. The user's data directory
and Neovim-owned viewer job were not changed for validation.
Screenshots verify the caret on dimmed nodes, picker layout, matching type styles,
hint labels and selection framing in both right- and bottom-docked layouts.

## Semantic role edges (2026-09-15)

`framework/util/graph-edge.ts` separates role identity, rendered label, style
inheritance, and parallel geometry. Scoped role keys live in the existing
`edgeLabelColors`, `edgeLineStyles`, and `edgeLineThicknesses` preset maps;
no snapshot/preset version change. Resolve each property role → links → all.
The builder scopes named roles, deduplicates old short-key edges semantically,
and fans parallel edges symmetrically. Its order and `applyEdgeCurvature` agree;
reverse endpoint order flips curvature to avoid overlapping opposite edges.
The middle lane uses the straight program (avoid a zero-curvature curve shader).

`GraphLabelService` now also resolves omitted/unscoped roles with background reads
of up to 50 existing relation/player IID pairs per query. It never feeds these
reads through GraphBuilder or adds nodes; it replaces unknown edges with scoped
role edges and preserves explicitly requested short roles. Returned role types
supply the declaring scope for inherited roles. Recheck output, visualiser,
connection and database after awaits. No DB writes or unrelated expansions.
Viewer-owned neighbour/operation/Explorer queries bind fresh role variables up
front. Keep role variables distinct for different links in the same query.

`restoreLabels` and the edge reducer derive role names from metadata, never from
the generic links tag. Metadata's optional `defaultLabel` preserves expression
and function labels too. Colour restoration, answer-highlight restoration,
line/dash reduction and role unloading all use semantic helpers. Generic edge
highlight filters still operate on tags; role styling does not change selection.

Sigma 3's `enableEdgeEvents` enables actual picking on both straight and curved
bodies (dash gaps remain pickable). `InteractionHandler.inspectedEdge` is transient
and independent of node caret/highlights. Side-panel Explorer exposes endpoints
and Customise; the existing style rows are reused for scoped roles with a filter
and 100-row cap. The Customise panel watches edge add/drop events because role
resolution can replace an edge without changing graph order or size. Detach those
listeners on destroy/remount. Keep cheap labels at curve apexes; the stock curved
per-character label renderer previously caused severe slowdowns.

Validation: `pnpm test:viewer`, `pnpm build:viewer`,
`node scripts/viewer-role-edges.browser.mjs` (real WebGL edge click, independent
role overrides, inheritance/reset, endpoint caret, legacy label repair, snap
round-trip, PNG), plus `node scripts/viewer-live-snap.browser.mjs` which now
checks real omitted-role queries for motivation/composition via
`role-edges.browser-checks.mjs`. These use isolated servers and profiles.
Arrowheads remain a future per-role direction setting; no Sigma upgrade or
submodule change was needed.
