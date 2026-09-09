# Munsell graph presets

In the graph's **Themes** panel, choose **Import presets**, select one of these
JSON files, then **Apply** on its saved preset card:

- **munsell-ink.json** — charcoal `#121416`, muted rose entities, teal relations,
  ochre attributes, and quiet slate edges. A dark companion to the Munsell Vim
  colour scheme, with teal and ochre lifted for graph legibility.
- **munsell-paper.json** — cool paper `#E3E6E9`, dusty rose entities, teal relations,
  darker ochre attributes, and soft slate edges. Based on the light Munsell scheme.

The source preferences are the `TdbEntity`, `TdbRelation`, `TdbAttribute`, and
`TdbRelationRole` highlight groups in `munsell-blue-molokai.vim` and
`munsell-blue-molokai_light_1.lua`, referenced by `typedb_syntax.vim` in the user's
Neovim configuration. Colours are adjusted selectively for legibility on a canvas;
this is a visual interpretation, not an exact terminal-theme conversion.

Entities use rounded rectangles (echoing `▢`), attributes use diamonds (`⬥`), and
relations use hexagons. Studio currently offers four node shapes and cannot use
`⊃` directly as a glyph-shaped node. Roles use muted mauve ellipses. Node labels
are enabled, edge labels are hidden initially, degree scaling is off, and fills
are translucent. The presets style kinds rather than specific schema labels, so
they also work outside `pts-tour3`.

These presets set the graph background, not the surrounding application's theme.
Use Studio's app theme control separately if you want the surrounding UI to match.

**Export saved presets** downloads all custom presets. A saved card's menu also
has **Export preset** for a single preset. Built-in presets can be exported by
applying one, saving the current configuration, then exporting that saved card.
Imports add presets without applying them or overwriting existing names; duplicate
names receive a numeric suffix. Graph contents, hidden/dimmed nodes, connection
settings, and queries are not included.

The versioned JSON format is `typedb-studio-graph-presets`, version `1`. Imports
also accept an individual raw custom preset or a raw array, which is useful for
moving existing `typedb-studio-custom-presets` localStorage data between origins.
