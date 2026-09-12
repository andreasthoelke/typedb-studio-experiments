# Graph visualization experiments for the mechanism specimen

The snap feature ships independently of a renderer migration. This note records
concrete follow-up experiments, not controls already available in Studio.
Reviewed against `specimens/mechanism/schema.tql` in the pts project, 2026-09-12.

## What is running now

The repo pins **Sigma 3.0.1**. Sigma draws the graph; the interactive layout is
**D3 force**. Compact/default/spacious currently vary centering gravity. Switching
renderer versions does not itself give the force simulation new semantic goals.
See `src/framework/graph-visualiser/engine/layout.ts` and `package.json`.

The v4 documentation is marked **alpha**. Its migration guide replaces reducers
with styles, and custom node/edge programs with a primitives/layers API. This
repo has custom shapes, labels outside outlines, curved edges, picking, highlight
reducers, and PNG compositing, so this is a rendering migration rather than a
version bump. [Official migration guide](https://v4.sigmajs.org/how-to/technical/migration-v3-v4/)

Saved `.snap.json` graphs give us reproducible fixtures for comparing v3 and v4
without rerunning queries or letting database edits change the test data.

## First experiments, in priority order

| Experiment | General TypeDB use | Mechanism specimen | Implementation boundary |
|---|---|---|---|
| Force controls | Separate link length, node repulsion, collision padding, and centering; keep drag-to-pin and provide release pins. | Keep the central goal readable while spreading motivation/gradient claims and their provenance. | Extend D3 controls on v3 first; expose a few meaningful sliders, not every simulation parameter. |
| Focus rings | Arrange graph-distance rings around a selected instance; preserve relation nodes between role players. | Goal at center, motivation/gradient claims in the first ring, mental states beyond them, evidence/source further out. | Optional layout of loaded data. Radius is a viewing choice, not a new database query. |
| Membership groups | Group by explicit membership relations rather than only by type or inferred communities. | Contours for claims in a `take` through `take-includes`; a scene groups occurrences and intents through its composition and `in-script` relations. | Support overlapping membership. One claim may belong to several takes. |
| Semantic edge styles | Distinguish link families and roles without spending all the color channels. | Solid domain links; dotted evidence or cross-layer identity links such as `occurrence-of`. Keep an explicit legend. | v4 prototype first; retain role labels and clickable relation nodes. |
| Layered schema view | Use type categories, inheritance and roles to build a stable reading order. | Separate scenic core from `domain:mechanism`, with role/ownership connections crossing the boundary. | Read schema annotations and explicit hierarchy; don't infer layers from screen proximity. |

A useful first control panel would offer **Free force**, **Focus rings**, and
**Group by type**, with **Group by membership** added once the relationship
selector can expose roles and actual group instances. Type grouping is simpler
but insufficient for comparing two takes containing the same kinds of claims.

## Dotted lines and the multiplex example

The multiplex example distinguishes marriage from business ties with separate
edge styling, including round-capped dashes. Its initial circular placement and
subsequent force simulation are separate from the rendering choices. This is a
useful model for showing several relationship families between the same objects.
[Multiplex source](https://v4.sigmajs.org/embed/cookbook/multiplex-network/)

In TypeDB, a relation is itself an instance. The diagram often contains a
relation node plus several `links` edges. A style rule based only on the edge tag
`links` cannot distinguish `motivation` from `evidence`: it must consider the
adjacent relation instance's type and the particular role. Keep ternary
`composition` and multi-player `tension` as relation nodes; flattening these into
pairwise edges would lose their meaning.

For this schema, try:

- solid lines for domain claims (`motivation`, `tension`, `gradient`);
- dotted lines for provenance (`evidence`) or an explicitly chosen cross-layer
  category (`occurrence-of`), with a legend identifying the chosen encoding;
- arrows only where a role has a meaningful direction: driver → motivation →
  target, for example. `tension:pole` is symmetric and should remain undirected.

`origin` and `disposition` are distinct dimensions. Do not overload dotted lines
with both “inferred” and “proposed”; if patterns encode relation family, use a
separate badge or color treatment for claim status. `confidence` could control
opacity only after defining its scale and an unknown-value treatment.

V4's edge examples offer straight, curved and stepped paths, arrow extremities,
gradients and dash layers. Stepped paths could help a schema hierarchy; gradients
should wait for a genuine source/target quantity rather than becoming decoration.
[Edge styles source](https://v4.sigmajs.org/embed/styling/edge-styles/)

## Contours should express a named group

The highlight-group example draws contour layers around nodes grouped by a
community-detection algorithm. The mechanism schema already contains meaningful
membership relations, so use those to supply the members instead. Communities
could remain an explicitly labelled exploratory option, not an inferred “take”.
[Highlight-group source](https://v4.sigmajs.org/embed/webgl-layers/highlight-group/)

Good first groups are a selected take's claims, a scene's occurrences/intents,
and the current finder selection. Avoid a giant contour around every attribute
node. A contour expresses membership, not a TypeDB containment constraint; it
must not imply that everything geometrically inside the outline belongs to the
group. Overlapping groups need separate toggles, low-opacity fills and names.

There is an important identity distinction here: `mental-state` is a referent,
while `occurrence` is one contextual use. A scenic composition view should place
occurrences and link back to referents, so the same mental state can appear in
more than one context without being merged into one placement.

## Authored placement and saved view positions are different

`placement-override` owns `pos-x` and `pos-y`, connected to an occurrence through
`override-of`. Those are authored realization facts with a `frame`. A graph snap
stores viewer coordinates in a file. Dragging nodes or restoring a snap must not
write placement overrides into the database.

A later **Use authored placement** mode could read overrides for a selected frame
and pin the corresponding occurrence nodes. Missing placements could use force
layout. That should be an explicit domain-aware view mode, with frame selection,
not the behavior of ordinary graph dragging.

## How to evaluate a v4 branch

1. Import the same saved data and schema snaps into both renderers, initially
   preserving all coordinates and the camera. Compare labels, role edges,
   hidden nodes, selection, picking, and PNG exports before changing layouts.
2. Add dotted edge rules for one relation family, then contours for the shared
   selection. Keep both features optional and compare readability at several
   zoom levels, including fullscreen and the narrow bottom-docked layout.
3. Add explicit take/scene membership groups. Fetch missing membership only on
   an explicit action; a styling toggle should not unexpectedly grow the graph.
4. Exercise drag/pin/release and layout controls on expanded graphs, not just
   the small initial query result. Preserve a snap schema independent of Sigma's
   rendering programs so later migrations do not discard saved work.

The expected payoff from v4 is a cleaner implementation of visual layers and
edge patterns. The useful layout choices still need application-level decisions
about relations, roles, membership, and the source schema.
