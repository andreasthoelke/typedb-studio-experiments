import type { GraphDirection, GraphNavigationMode } from "./graph-navigation";

export type GraphViewCommand = "centreCaret" | "caretTop" | "caretBottom" | "caretLeft" | "caretRight"
    | "panLeft" | "panRight" | "panUp" | "panDown" | "zoomIn" | "zoomOut" | "roomier" | "denser" | "focus" | "back" | "relayout" | "snap";

export type GraphShortcut = "roomier" | "denser" | "syncCaret" | "uiHints" | "isolate" | "previous" | "next" | "live" | "snap" | "find" | "help" | "focus" | "relayout" | "zoomIn" | "zoomOut"
    | "caret" | "clear" | "remove" | "deleteLeader" | "removeCaret" | "leader" | "hintLeader" | "centreLeader" | "centreCaret" | "hints" | "cancelLeader" | "geLeader"
    | GraphDirection | `nudge:${GraphDirection}` | "historyLeader" | "back" | "panLeft" | "panRight" | "panUp" | "panDown" | "caretTop" | "caretBottom" | "caretLeft" | "caretRight";
export type GraphKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented" | "repeat">;
export type GraphKeyLeader = "space" | "comma" | "z" | "d" | "g" | "ge";
const movement: Record<string, GraphDirection> = { h: "left", l: "right", k: "up", j: "down",
    n: "downLeft", o: "upRight", y: "upLeft", ".": "downRight" };

/** Option on macOS changes event.key (e.g. Option-h is ˙). Physical letter
 * codes are only a fallback for that modifier, preserving normal layouts. */
export function graphLetterKey(event: Pick<KeyboardEvent, "key" | "code" | "altKey">): string {
    return event.altKey && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
}

export function graphShortcut(event: GraphKeyEvent, mode: GraphNavigationMode = "normal", leader: GraphKeyLeader | null = null): GraphShortcut | null {
    if (event.metaKey || event.isComposing || event.defaultPrevented) return null;
    let action: GraphShortcut | null;
    const letter = graphLetterKey(event);
    const motionKey = (event.altKey && event.code === "Period") || (event.shiftKey && event.key === ">") ? "." : letter;
    if (event.ctrlKey) {
        if (event.altKey) return null;
        if (event.shiftKey) return mode === "caret" ? movement[motionKey] ?? null : null;
        // Ctrl-= / Ctrl-- step the layout density (roomier / denser).
        const chords: Record<string, GraphShortcut> = { e: "panDown", y: "panUp", h: "panLeft", l: "panRight", o: "back", "[": "clear", "=": "roomier", "-": "denser" };
        action = leader === "d" && event.key === "[" ? "cancelLeader"
            : chords[event.key] ?? null;
    } else if (event.key === "Escape") action = leader === "d" ? "cancelLeader" : "clear";
    else if (leader) {
        if (event.altKey || event.shiftKey) return null;
        action = leader === "space" ? (event.key === "h" ? "previous" : event.key === "l" ? "next" : event.key === "Enter" ? "syncCaret" : "cancelLeader")
            : leader === "comma" ? (event.key === "f" ? "hints" : "cancelLeader")
            : leader === "d" ? (event.key === "d" ? "removeCaret" : event.key === "Enter" ? "remove" : "cancelLeader")
            // geo mirrors Neovim's geo (Space Enter's alias): the caret in the other view.
            : leader === "g" ? (event.key === ";" ? "back" : event.key === "e" ? "geLeader" : "cancelLeader")
            : leader === "ge" ? (event.key === "o" ? "syncCaret" : "cancelLeader")
            : ({ z: "centreCaret", t: "caretTop", b: "caretBottom", h: "caretLeft", l: "caretRight" } as Record<string, GraphShortcut>)[event.key] ?? "cancelLeader";
        if (action === "cancelLeader" && event.key.length !== 1) return null;
    } else {
        // Shift-period is >; Option-period is ≥ on macOS. Keep ordinary
        // unmodified keys layout-aware, as with the physical Option-letter fallback.
        if (mode === "caret" && movement[motionKey]) action = event.shiftKey && !event.altKey ? `nudge:${movement[motionKey]}` : movement[motionKey];
        else if (event.altKey) return null;
        else {
            // Bare f addresses controls; comma-f addresses graph nodes.
            const actions: Record<string, GraphShortcut> = { "+": "zoomIn", "=": "zoomIn", "-": "zoomOut", Enter: "focus", r: "relayout", R: "isolate",
                c: "caret", z: "centreLeader", g: "historyLeader", d: "deleteLeader", " ": "leader", ",": "hintLeader", f: "uiHints", Backspace: "live", s: "snap", "/": "find", "?": "help" };
            action = event.shiftKey && letter === "r" ? "isolate" : actions[event.key] ?? null;
        }
    }
    const repeatable: GraphShortcut[] = ["left", "right", "up", "down", "downLeft", "upRight", "upLeft", "downRight", "back", "panLeft", "panRight", "panUp", "panDown", "zoomIn", "zoomOut"];
    return event.repeat && (!action || (!action.startsWith("nudge:") && !repeatable.includes(action))) ? null : action;
}
