# Local Studio fork: maintainer handoff

Updated 2026-09-12. Read this first, then [the workflow guide](local-graph-viewer.md).
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
pnpm build:viewer
node scripts/viewer-shortcuts.browser.mjs
```

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
   route's snap kind appears. Return to live; its graph and theme should be intact.
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
| Bounded schema focus from original editor source | `src/framework/util/schema-focus.ts`, `src/module/schema/schema-page.component.ts` |
| Query conversion / compatible relation augmentation | `src/framework/util/graph-query.ts` |
| Context following writes/schema changes | `src/framework/util/operation-context.ts` |
| Canvas, finder, exports, inline snap overlay, shortcuts | `src/framework/graph-visualiser/canvas/graph-canvas.component.ts` |
| Snap context, HTTP requests, active filename | `src/service/graph-snapshot.service.ts` |
| Capture/restore, rendering, labels and camera | `src/framework/graph-visualiser/engine/index.ts` |
| Mouse inspection and Shift-click neighborhoods | `src/framework/graph-visualiser/engine/interaction-handler.ts` |
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

File API: POST `/api/viewer/project`, GET `/api/viewer/snaps`, GET/POST/DELETE
`/api/viewer/snap`, POST `/api/viewer/export`. Requests include database and project
temp context. Filename counters use exclusive filesystem creation, independent
per directory. Listing reads real files; no localStorage-only snap catalogue.
Project context inferred from a Neovim schema file can be overridden in Snaps.

## Preserve these invariants

- **Live and saved views are separate renderers.** Opening a chip creates an inline
  overlay in the shared canvas, with its own graph and child `GraphStyleService`
  injector. Never apply saved styles to the root live service. Closing it destroys
  the overlay/injector and exposes the original live graph. The old `/snap` route
  remains available for standalone imports/testing; chips must not navigate there.
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
  reads cached data in a snap. Exact pixels can vary with browser/window/fonts.
- **Inspection and explicit selection are separate.** Plain click selects the
  inspected node/periphery; finder/type chips/Explorer selection controls share
  `GraphElementSelection`. An active explicit set takes priority in reducers.
  Shift-click unions neighborhood groups and retains overlap. Explicit checkbox
  edits reset group bookkeeping to a new base. Groups serialize with selection.
  None is an active empty selection; Clear restores ordinary highlighting.
- **Keyboard ownership belongs to the visible graph.** Capture listeners ignore
  editable fields, overlays, modifier chords, repeated keys, and hidden canvases.
  Track pointer/focus ownership when multiple graphs exist. Remove listeners on
  destroy. Enter in search inputs remains handled by those inputs.
- **Vimium runs earlier.** Tested 2.4.2 consumes h/l before page listeners. Use the
  per-site pass keys `hls/?` at `http://localhost:1430/*`, or disable it for the site.
  The Keys panel's last-received diagnostic helps distinguish interception from
  app state. Do not try to modify a user's active browser profile behind their back.
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

Current shortcuts: h/l browse, Backspace live, Enter focus, s save, / finder, ? help.
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
