# Graph actions, terms and data views: proposal

Status: decided and implemented 2026-09-26 (the user approved the terms, the
icon row, direct database writes and `@meta` defaults, and delegated the rest).
Deviations from the proposal: the Data view is the Explorer's third mode
(**here · every 'x' · data**) rather than a seventh panel tab, which would not
fit the tab row at the standard 25% width; its default rows are the loaded graph
(the selection when instances are selected). Edits commit directly with safeguards
instead of composing into Neovim. Row keys (Enter/a/dd/s/m on focused Explorer
rows) and the §7 geo suggestions remain open. See the workflow guide's Explorer
section for the behaviour as built.
It answers the user's notes on unifying Explorer actions, naming, attribute
features, an "every x" Data tab, snap labels and edge direction. Open questions
are collected at the end.

## 1. Terms

Observed drift: "caret a node", "secondary/minor caret", "highlight", "dim",
"reveal", "mark", "inspect", "center" and "focus" have overlapping meanings.
The Explorer reuses "Reveal in graph" for pan + mark, while Customise uses
"Reveal style" to expand a row.

Proposed vocabulary. One verb per effect, and the effect is named after what the
user sees.

| Term | Meaning | Today |
| --- | --- | --- |
| **Caret** | The one node commands address (solid corners). Explorer always shows it. "Move the caret to X" / "go to X". | caret; "Inspect" |
| **Marks** | Dotted corners on other matches. Informational only; commands ignore them. Esc clears. | "secondary carets", "Mark in graph", Explorer "Reveal" |
| **Selection** | The explicit set (Shift-click, Ctrl-Shift motion). Drives fading, Enter fit, d Enter, isolate. | selection |
| **Highlighted / dimmed** | *Effects* of selection, search and style highlights, not commands. | highlight, dim, fade |
| **Hide / Show** | Keep in the graph but invisible (`viewHidden`). | Hide/Show, "Show & mark" |
| **Add** | Load from the database into the graph. | Add to graph |
| **Remove** | Drop from the working graph. Restore context brings it back; the database is unchanged. | Remove from graph, dd |
| **Isolate** | Remove everything except the selection. | Isolate & layout, R |
| **Go to** | Caret plus minimal pan. | Inspect, Reveal (self) |
| **Centre** / **Fit** | Camera only: zz keeps zoom; Enter zooms to the highlighted set. | zz, Enter "focus" |

"Caret" works as a noun (the vim cursor analogy holds). As a verb, prefer
"go to". "Secondary caret" is the misleading one: those markers accept no
commands, so **marks** fits better. The Explorer's "Mark in graph" already does
exactly this. "Reveal" would disappear as a verb. "Reveal style" becomes
"Show style row".

## 2. One action strip for every node

Today the same concept has different controls depending on where it appears:

- the self header has Reveal / Hide / Add to selection / Remove;
- relation cards have Inspect / Mark (top right) or Add;
- link rows have Reveal or Add player;
- attribute rows use arrow icons.

Proposal: a single, compact **state strip**, identical wherever a node appears
(self header, link rows, relation cards, attribute rows, later Data-tab rows).
Each glyph shows state and is also the toggle:

```
 tension  0x1e…07                      ● ◉ ◆ ⌜⌟ ×
 └ pole  Fear        mental-state      ● ◉ ◇ ⌜⌟ ×
 └ pole  Courage     mental-state      ○
   take-includes  0x1f…02              ● ◉ ◇ ⌜⌟ ×
```

| Glyph | Off → click | On → click |
| --- | --- | --- |
| ○ / ● in graph | Add | Go to (move the caret there) |
| ◉ visible (only when in graph) | Show | Hide |
| ◇ / ◆ selected | Add to selection | Remove from selection |
| ⌜⌟ marked | Mark | Unmark |
| × | — | Remove from graph |

Low noise:

- a not-loaded node shows only ○;
- off-state glyphs render at low contrast;
- ×, and the text labels in tooltips, appear on row hover or keyboard focus.

The header strip applies to the caret. When a selection exists, a second
"Selection (n)" strip applies the same actions to every selected node
(Hide all, Mark all, Remove all, Isolate). That makes the commands uniform
across single nodes and sets.

Keyboard: a focused Explorer row could accept the graph's own keys, for example:

- Enter: go to
- `a`: add
- `dd`: remove
- `s`: select
- `m`: mark

Space Ctrl-n/p and Ctrl-n/p already move focus through rows.

## 3. Data tab ("every x")

The Explorer's **here / every 'x'** switch is two views of one idea. Proposal:
keep Explorer as **here** (the caret instance and its neighbourhood) and move
**every x** into a sibling **Data** tab that shows up whenever the caret or
selection contains instances.

- Rows are the instances. Choose the source:
  - **loaded**: graph nodes only, no query;
  - **selection**;
  - **database**: a bounded read of the type, e.g. 200 rows.
- Columns are owned attributes (inherited `owns` included, `@key` first), then
  one column per played role with a count or player label.
- Several selected types: the union of columns, shared attributes first. This is
  the case the user described, comparing values across types that share fields.
- A row carries the state strip from §2. Clicking a cell moves the caret to that
  node (or to the attribute node, if loaded). Sort and filter per column.
- Snaps would save the tab's source/columns, like Customise sections.

## 4. Attributes in the Explorer, and editing

Read-only additions with little risk:

- value type and annotations: `@key`, `@unique`, `@card`, `@values` and range;
- which supertype the `owns` comes from;
- for **every x**, distinct count and the top values;
- for an attribute node, its owners.

Editing is feasible. TypeQL 3 supports `match $x iid 0x…; update $x has title "…";`
for single-cardinality attributes, and delete + insert for the rest. The risk is
drift: the user's `.tql` files in Neovim are the source of truth, and a direct
Studio write would bypass them. The bridge already has the safe execution path
(`/api/viewer/run`: run once, report an unknown outcome, never retry).
Recommended design: **Edit composes a TypeQL paragraph and sends it to Neovim**
(a scratch buffer, or appended under the paragraph's header) for the user to run
with the normal evaluation. After that run, Studio refreshes the node. Direct
commit from Studio would be an explicit, separate opt-in.

## 5. Snap labels from query shape

Compute a summary at save time, as an optional `summary` field in the snap-v1
graph attributes:

- kind: instances / types / both;
- counts: entities, relations, attributes, types;
- the three most frequent types.

For old snaps the server can derive the summary from the saved graph while
listing. A chip would read, for example, `occur·scene  I 12e 5r` or `schema  T 18`.
The Snaps tab gets **group by**:

- source header/title;
- kind;
- day.

## 6. Edge direction as schema metadata

Implemented: every role edge now points at the player by default.
The edge label names the role, so it reads "the relation's *role* is → player".
That makes one uniform direction coherent without semantic inference. Settings
resolve role → links → toward player, and any role can opt out.

For defaults that travel with the schema, TypeDB 3.12's `@meta` is the natural
carrier. The user's schemas already use `@meta("layer", …)`. Verified on an
isolated 3.12.3 server:

```typeql
define
relation tension @meta("graph-arrow", "none"),
  relates pole @meta("graph-arrow", "none");
relation occurrence-of,
  relates subject @meta("graph-arrow", "player");
```

- It is accepted, and it appears in the `/v1/databases/<db>/schema` dump.
- `match $rel label occurrence-of; $rel relates $r; let $a = get_meta("graph-arrow", $r);`
  returns the value per role.

Proposed precedence: user preset for the role → schema `@meta` on the role →
schema `@meta` on the relation → links preset → toward player. It costs one
read per schema load. The same mechanism could carry other visual defaults,
e.g. `@meta("graph-label", "title")` for the display attribute. The existing
`layer` metadata could colour or filter nodes by layer.

## 7. More "explanatory geo" candidates

Implemented this round:

- `relates r` → players;
- `plays R:r` in `T` → T instances that play it;
- `owns a` in `T` → owners, with their values;
- Schema role-type caret + Space Enter/geo → the role's players in Query.

Suggestions, not implemented:

- **geo on `@meta("layer", "scenic-core")`**: Schema marks every type in that
  layer; Query marks their loaded instances.
- **geo on `owns a` in Schema**: caret on the attribute type and mark the owner
  type. More generally, mark both ends of the clause.
- **geo on `@key` / `@unique`**: in Query, mark instances whose value is shared
  (for `@unique`) or missing (possible for `@card(0..)` attributes). Useful
  after imports.
- **geo on a `fun` name**: run the function with a bounded limit and mark the
  returned instances.
- **geo on a `sub` parent from Schema**: mark sibling subtypes (the other
  families of the same parent).

## Questions

1. **Terms**: adopt the §1 vocabulary (marks instead of secondary carets;
   go to instead of inspect/reveal)?
2. **Action strip**: a glyph strip with hover labels, or keep text buttons but
   make them identical everywhere? Should the header also get the
   "Selection (n)" strip that applies to every selected node?
3. **Data tab**: which default row source: loaded, selection or database?
   Should the Explorer then drop its **here / every** switch?
4. **Editing**: compose into Neovim (recommended), or commit from Studio?
5. **Arrows from `@meta`**: use the key name `graph-arrow` with values
   player/relation/none? Should Studio also read other visual keys
   (`graph-label`, `layer` colouring)?
6. **Snaps**: which chip badges, and which group-by as default?
