/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Panes are the browser-side equivalent of Neovim windows: the focusable
 *  regions a `<c-w>` motion moves between. Ids are stable because the help
 *  overlay, the direct jumps and the docs all name them. A route registers
 *  only the panes it actually shows and motions are resolved from live rects,
 *  so docking the side panel below the graph changes the answers without any
 *  layout table needing an update. */
export type PaneId = "tool" | "query" | "graph" | "output" | "explorer" | "panel";

export type PaneDirection = "left" | "right" | "up" | "down";
export interface PaneRect { left: number; top: number; width: number; height: number }
export interface PaneGeometry { id: PaneId; rect: PaneRect }

export type PaneAction = PaneDirection | "farLeft" | "farRight" | "previous" | "cycle" | "cancel" | `jump:${PaneId}`;

/** What an escalated motion asks the window manager for. The `far-` pair keeps
 *  going until nothing is further that way, so one keypress crosses two
 *  windows in a three-column arrangement. */
export type PaneEscalation = "west" | "east" | "north" | "south" | "far-west" | "far-east" | "previous";

/** Screen direction to the window-manager direction Hammerspoon names. Edge
 *  motions escalate with these rather than with a column index, so the three
 *  columns stay an observation about the user's screen, not a hardcoded map. */
export const paneEscalation: Record<PaneDirection, PaneEscalation> = {
    left: "west", right: "east", up: "north", down: "south",
};

const motions: Record<string, PaneDirection> = { h: "left", l: "right", k: "up", j: "down" };
/** `t`/`b` follow Vim's top/bottom window jumps; the rest are mnemonics. */
const jumps: Record<string, PaneId> = { t: "tool", q: "query", g: "graph", e: "explorer", b: "panel" };

export type PaneKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented" | "repeat">;

/** True for the `<c-w>` prefix itself. Chrome on macOS closes tabs with Cmd-W,
 *  so Ctrl-W is free for us; Option-W and Cmd-W stay with the browser. */
export function panePrefix(event: PaneKeyEvent): boolean {
    return event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !event.defaultPrevented
        && !event.repeat && (event.key.toLowerCase() === "w" || event.code === "KeyW");
}

/** The key after the prefix. Vim accepts `<c-w><c-h>` as well as `<c-w>h`, so
 *  a still-held Ctrl is ignored. Anything unrecognised cancels rather than
 *  falling through to the graph, matching the leader machine in the canvas. */
export function paneAction(event: PaneKeyEvent): PaneAction | null {
    if (event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return null;
    if (["Shift", "Alt", "Control", "Meta"].includes(event.key)) return null;
    // Capitals first. These are window-level, not pane-level: they always
    // cross to the leftmost or rightmost window on screen, because `h`/`l`
    // already walk the panes and "rightmost pane" is ambiguous whenever a
    // full-width pane shares the page's right edge with a narrow one. Unlike
    // Vim's own <c-w>H/L they move the cursor, not the window.
    if (event.key === "H") return "farLeft";
    if (event.key === "L") return "farRight";
    const letter = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (motions[letter]) return motions[letter];
    if (letter === "p") return "previous";
    if (letter === "w") return "cycle";
    if (jumps[letter]) return `jump:${jumps[letter]}`;
    return "cancel";
}

/** Resizable splits and their drag handles carry a couple of negative pixels
 *  of margin, so adjacent panes can overlap slightly. */
const adjacencyTolerance = 4;

interface Projection { near: number; far: number; crossMin: number; crossMax: number }

/** Normalise a rect into the motion's frame: `near`/`far` run along the
 *  direction of travel (negated for left/up so every comparison is a `>`),
 *  and `crossMin`/`crossMax` are the perpendicular extent. */
function project(rect: PaneRect, direction: PaneDirection): Projection {
    const { left, top, width, height } = rect;
    switch (direction) {
        case "down": return { near: top, far: top + height, crossMin: left, crossMax: left + width };
        case "up": return { near: -(top + height), far: -top, crossMin: left, crossMax: left + width };
        case "right": return { near: left, far: left + width, crossMin: top, crossMax: top + height };
        case "left": return { near: -(left + width), far: -left, crossMin: top, crossMax: top + height };
    }
}

/** The graph's own `directionalGraphNode` is deliberately not reused here. It
 *  ranks by distance between centres, which is right for nodes of comparable
 *  size but wrong for panes: measured centre to centre, a short pane beside
 *  the graph beats the tall graph directly below the editor. Panes are large
 *  rectangles in a tiled layout, so the meaningful question is which pane the
 *  origin's edge actually abuts — nearest edge first, and on a tie the pane
 *  that shares the most of that edge. */
export function nextPane(panes: PaneGeometry[], from: PaneId, direction: PaneDirection): PaneId | null {
    const source = panes.find(pane => pane.id === from);
    if (!source) return null;
    const origin = project(source.rect, direction);
    const ranked = panes
        .filter(pane => pane.id !== from)
        .map(pane => ({ pane, projection: project(pane.rect, direction) }))
        // Beyond the origin's leading edge, and genuinely extending past it:
        // a pane merely nested inside the origin is not "in that direction".
        .filter(({ projection }) => projection.near >= origin.far - adjacencyTolerance && projection.far > origin.far)
        .map(({ pane, projection }) => ({
            id: pane.id,
            gap: Math.max(0, projection.near - origin.far),
            overlap: Math.max(0, Math.min(origin.crossMax, projection.crossMax) - Math.max(origin.crossMin, projection.crossMin)),
            crossDistance: Math.abs((projection.crossMin + projection.crossMax) / 2 - (origin.crossMin + origin.crossMax) / 2),
            top: pane.rect.top,
            left: pane.rect.left,
        }))
        .sort((a, b) => a.gap - b.gap || b.overlap - a.overlap || a.crossDistance - b.crossDistance
            || a.top - b.top || a.left - b.left || a.id.localeCompare(b.id));
    return ranked[0]?.id ?? null;
}

/** Reading order for `<c-w>w`, so the cycle is predictable regardless of the
 *  order routes happened to register their panes in. */
export function paneCycleOrder(panes: PaneGeometry[]): PaneId[] {
    return [...panes]
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.id.localeCompare(b.id))
        .map(pane => pane.id);
}

export function nextPaneInCycle(panes: PaneGeometry[], from: PaneId | null): PaneId | null {
    const order = paneCycleOrder(panes);
    if (!order.length) return null;
    const index = from ? order.indexOf(from) : -1;
    return order[(index + 1) % order.length];
}
