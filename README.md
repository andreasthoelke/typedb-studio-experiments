# TypeDB Studio Experiments

An independent experimental fork of [TypeDB Studio](https://github.com/typedb/typedb-studio), exploring a close conversation between **TypeQL source, query results, and interactive graphs**.

TypeDB Studio and the foundations of this application were created by TypeDB and its contributors. This repository builds on their work; it is not an official TypeDB product or release. The upstream Git history, source notices, and [Mozilla Public License 2.0](LICENSE) are retained.

## The idea

Writing a query is often part of learning what a model means. A table can tell us what came back, but a graph can help us see why: which entities participate in a relation, which role each one plays, and how a small expression fits into a larger schema.

This project explores a workspace in which those representations stay close together. TypeQL remains the place to think and write. Neovim gives immediate, readable feedback. Studio offers two complementary views: the instances involved in an expression, and the types and roles that make that expression possible. Moving the editor cursor can become a way to ask the graph a more specific question.

The aim is to make modelling an iterative, inspectable activity: write a little, see what it means, follow a connection, revise the model, and keep a useful view for later. Graphs here are working material. They can be expanded, reduced, arranged, annotated through styles, and saved as snapshots that retain their data and context.

This is an exploration, not a finished visual language. Some context selection is deliberately pragmatic. A useful illustration may include related data beyond the returned rows, but it must remain distinguishable from the result of the executed statement. Errors stay errors; a helpful view of existing data must never suggest that a failed write succeeded.

## What is here

- **Complementary editor and graph results.** A local bridge executes a statement once and shares its structured result with Neovim and following Studio windows. Concept rows and flat fetch results become readable tables; raw JSON and query views remain available.
- **Parallel Query and Schema views.** One shows instances and relationships; the other provides a more stable map of types and roles, with focus derived from the source expression.
- **Navigation from TypeQL.** Jump from a variable, type or role to its graph counterpart. Bounded read-only illustrations can add missing context without replaying source writes.
- **Keyboard graph exploration.** A spatial caret, independent selection, directional movement, camera controls, pane navigation, and focused panel scrolling/tab cycling.
- **Editable working graphs.** Explore attributes and role players, inspect semantic role edges, adjust per-type/per-role styles, and isolate a useful subset for layout.
- **Snapshots and exports.** Save the rendered graph, positions, styles, selection, query provenance and expansions. Reopen connected snapshots as editable views, or inspect them offline.

The normal Studio query editor remains available. Neovim integration is optional. The current workflow is developed primarily on macOS with Neovim, a browser, and a local TypeDB 3.x server; cross-window navigation optionally uses Hammerspoon.

## Try the local viewer

Use Node **22.16+ within 22.x**, pnpm **10.12.1**, and a TypeDB **3.x** server. The integration tests currently exercise TypeDB CE **3.12.3**.

```sh
git clone --recurse-submodules https://github.com/andreasthoelke/typedb-studio-experiments.git
cd typedb-studio-experiments
pnpm install --frozen-lockfile
pnpm viewer:dev
```

Open [Query](http://localhost:1430/query?nvim=1) and [Schema](http://localhost:1430/schema?nvim=1) in separate browser windows, and connect them to the same TypeDB server/database. Local Query and Schema routes start with the graph maximised; the existing maximise toggle returns to the editor and surrounding panes.

The bridge reads `TYPEDB_ADDRESS`, `TYPEDB_USERNAME` and `TYPEDB_PASSWORD` from its environment. Defaults target local development at `http://localhost:8000` with TypeDB's default `admin` / `password` credentials. The viewer binds to loopback; it is a local development tool, not a hosted multi-user service.

For a static build, use `pnpm build:viewer` followed by `pnpm viewer`.

## Neovim and the rest of the workspace

The reusable Studio-side integration is included here:

- [Neovim bridge and navigation mappings](contrib/nvim/typedb_graph.lua)
- [Neovim result-float adapter](contrib/nvim/typedb_result.vim)
- [Optional Hammerspoon window-navigation helper](contrib/hammerspoon/typedb_panes.lua)
- [Setup, keymaps and workflow guide](docs/local-graph-viewer.md)
- [Execution and result-rendering contract](docs/nvim-result-rendering-plan.md)

The surrounding paragraph evaluation and float utilities come from my public [dotvim configuration](https://github.com/andreasthoelke/dotvim), particularly [the TypeDB integration](https://github.com/andreasthoelke/dotvim/blob/main/plugin/ftype/typedb.vim) and [floating-window helpers](https://github.com/andreasthoelke/dotvim/blob/main/plugin/utils/floatingWin.vim). These are references to a personal configuration, with local paths and other dependencies; they are not a requirement to adopt the entire setup, nor a standalone Neovim plugin distribution. The bridge in this repository is the current source for the Studio integration.

Remote view controls default to `\` and intentionally reach both following views. The division of responsibility between Query and Schema is still evolving; the [workflow guide](docs/local-graph-viewer.md) records the current behavior and limitations.

## Development and upstream updates

This repository keeps the original project history so useful upstream changes can be merged normally. In a fresh clone:

```sh
git remote add upstream https://github.com/typedb/typedb-studio.git
git fetch upstream
git switch -c integrate-upstream
git merge upstream/development
git submodule update --init --recursive
```

Review and test that integration branch before merging it into `main`. Dependencies, TypeQL syntax and graph behavior can change together; upstream merges are not automatic updates. See the [maintainer handoff](docs/LOCAL-FORK-HANDOFF.md) before changing graph lifecycle or bridge behavior, and the [retained upstream README](docs/UPSTREAM-README.md) for the original application/build introduction.

```sh
pnpm test:viewer
pnpm test:nvim-results
pnpm build:viewer
node scripts/viewer-shortcuts.browser.mjs
pnpm test:viewer-results
```

The browser tests require Chrome/Playwright. The result integration test also requires a TypeDB 3.x server binary (`TYPEDB_TEST_BINARY`); it starts its own temporary instance and database. Other live browser scripts are development fixtures with documented schema prerequisites, not a universal test suite for arbitrary databases.

## Attribution and license

Based on [TypeDB Studio](https://github.com/typedb/typedb-studio) by TypeDB and its contributors. The code is distributed under the repository's [MPL-2.0 license](LICENSE); existing source notices are preserved. Submodules and third-party dependencies retain their own licenses. TypeDB names and branding identify the upstream project and are not a claim of affiliation or endorsement.

Feedback and code reading are welcome. This repository shares an evolving experiment in understanding TypeQL through linked textual and visual representations, with the rough edges and tradeoffs documented alongside the implementation.
