/** Keep browser/editor commands intact; graph shortcuts are deliberately unmodified. */
export type GraphShortcut = "previous" | "next" | "live" | "snap" | "find" | "help" | "focus" | "relayout";
export function graphShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "defaultPrevented" | "repeat">): GraphShortcut | null {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented || event.repeat) return null;
    const actions: Record<string, GraphShortcut> = { Enter: "focus", r: "relayout", h: "previous", l: "next", Backspace: "live", s: "snap", "/": "find", "?": "help" };
    return actions[event.key] ?? null;
}
