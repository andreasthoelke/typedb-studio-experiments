/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Injectable, NgZone, inject } from "@angular/core";
import { Subject } from "rxjs";
import {
    nextPane, nextPaneInCycle, paneAction, paneEscalation, panePrefix,
    type PaneAction, type PaneDirection, type PaneEscalation, type PaneGeometry, type PaneId,
} from "../framework/util/pane-focus";

interface PaneRegistration { element: HTMLElement; focusTarget: () => HTMLElement | null }

/** `<c-w>` window navigation, in the browser.
 *
 *  Panes are registered by the `tsPane` directive and resolved from live
 *  rects, so this holds no layout table. A motion that leaves the page
 *  entirely is escalated to the window manager through the Neovim bridge:
 *  the same "the in-app move was a no-op, so hand it up" rule that
 *  vim-tmux-navigator uses, which keeps the three surfaces (schema window,
 *  query window, Neovim) navigable without any of them knowing the others
 *  exist.
 *
 *  Pane focus routes Ctrl-e/y to that pane's scroller. Plain graph caret
 *  motions and z placements remain available from side panels, while inputs
 *  keep editing keys. `<c-w> Space j/k` asks the visible canvas to give the
 *  focused graph/panel pane more or less height. */
@Injectable({ providedIn: "root" })
export class PaneFocusService {
    private readonly zone = inject(NgZone);
    private readonly panes = new Map<PaneId, PaneRegistration>();
    /** The graph canvas consults this so a pending prefix never reaches its
     *  own shortcut table. Listener registration order between the canvas and
     *  this service is not guaranteed, so the guard is explicit rather than
     *  relying on `stopImmediatePropagation`. */
    chordPending = false;
    activePane: PaneId | null = null;
    lastAction = "";
    private focusRevision = 0;
    private previousPane: PaneId | null = null;
    private chordTimer?: ReturnType<typeof setTimeout>;
    /** `<c-w> Space` waits for j/k (taller/shorter focused pane). */
    private resizePending = false;
    /** Space in a side panel is a leader for Ctrl-n/p section jumps, as in the graph. */
    /** When Space last armed the leader; -Infinity = not armed. (0 would count as
     *  armed during a page's first second, when performance.now() < 1000.) */
    private sectionLeaderAt = -Infinity;
    private swallowSpaceUp = false;
    readonly resize$ = new Subject<{ pane: PaneId | null; grow: boolean }>();
    private topPending: PaneId | null = null;
    private topTimer?: ReturnType<typeof setTimeout>;
    /** The key that followed a panel g which turned out not to be gg. */
    private releasedG: KeyboardEvent | null = null;

    /** The panel swallows a lone g while it waits for gg. If the next key is
     *  something else, the g was the graph's (g;, geo): report it once, for
     *  this exact event, whether or not this listener has already run. */
    releasePanelG(event: KeyboardEvent): boolean {
        if (this.releasedG === event) { this.releasedG = null; return true; }
        if (!this.topPending || event.ctrlKey || ["g", "G", "Shift", "Alt", "Control", "Meta"].includes(event.key)) return false;
        this.topPending = null; clearTimeout(this.topTimer);
        return true;
    }
    private listening = false;
    private bridgeAbsent = false;
    /** True while the most recent focus event was this window being entered
     *  from outside. `<c-w>p` is a single timeline across panes and windows,
     *  so whichever happened last wins: arriving from Neovim makes `p` go back
     *  to Neovim, and any pane motion afterwards makes `p` in-page again. */
    private enteredFromOutside = false;

    register(id: PaneId, element: HTMLElement, focusTarget: () => HTMLElement | null): void {
        this.panes.set(id, { element, focusTarget });
        this.listen();
    }

    unregister(id: PaneId, element: HTMLElement): void {
        if (this.panes.get(id)?.element === element) this.panes.delete(id);
        if (this.activePane === id) this.activePane = null;
        if (this.previousPane === id) this.previousPane = null;
    }

    private listen(): void {
        if (this.listening) return;
        this.listening = true;
        // Capture on window so the prefix is seen before CodeMirror, Material
        // overlays and the graph canvas. Outside Angular: a focus move that
        // changes no bound state should not cost a change-detection pass.
        this.zone.runOutsideAngular(() => {
            window.addEventListener("keydown", this.onKey, true);
            window.addEventListener("keyup", this.onKeyUp, true);
        });
        window.addEventListener("focus", this.onWindowFocus);
        window.addEventListener("blur", this.cancelChord);
        document.addEventListener("visibilitychange", this.cancelChord);
    }

    private onWindowFocus = (): void => { this.enteredFromOutside = true; };

    private cancelChord = (): void => {
        this.chordPending = false;
        this.resizePending = false;
        if (this.chordTimer) clearTimeout(this.chordTimer);
        this.chordTimer = undefined;
    };

    /** A pane is navigable only while it is really on screen. Mirrors the
     *  canvas's own visibility test so a hidden output tab or a collapsed
     *  resizable pane is skipped rather than focused invisibly. */
    private visible(element: HTMLElement): boolean {
        if (!element.isConnected || element.closest(".invisible, [hidden], [inert], [aria-hidden='true']")) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    private geometry(): PaneGeometry[] {
        const graphVisible = this.panes.has("graph") && this.visible(this.panes.get("graph")!.element);
        return [...this.panes].filter(([id, pane]) => this.visible(pane.element) && !(id === "output" && graphVisible))
            .map(([id, pane]) => {
                const rect = pane.element.getBoundingClientRect();
                return { id, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
            });
    }

    /** Where a motion starts. An explicit `<c-w>` focus wins; otherwise the
     *  pane containing the real focus, so the first motion after clicking
     *  into the editor starts from the editor and not from wherever the
     *  keyboard was last handed to. */
    private origin(panes: PaneGeometry[]): PaneId | null {
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
            for (const [id, pane] of this.panes) {
                if (pane.element.contains(active) && panes.some(candidate => candidate.id === id)) return id;
            }
        }
        return this.activePane && panes.some(pane => pane.id === this.activePane) ? this.activePane
            : panes.find(pane => pane.id === "graph")?.id ?? panes[0]?.id ?? null;
    }

    get focusedPane(): PaneId | null { return this.origin(this.geometry()); }

    private get sectionLeader(): boolean { return performance.now() - this.sectionLeaderAt < 1000; }

    /** Guard in the canvas too: capture-listener registration order can vary. */
    handlesPanelKey(event: KeyboardEvent): boolean {
        if (event.altKey || event.metaKey || event.isComposing) return false;
        if (event.ctrlKey && !event.shiftKey && ["d", "f"].includes(event.key.toLowerCase())) return true;
        if (this.focusedPane === "panel" && event.ctrlKey && ["n", "p"].includes(event.key)
            && (this.sectionLeader || document.querySelector("ts-graph-side-panel .explorer-pane"))) return true;
        return !!this.focusedPane && !["graph", "query"].includes(this.focusedPane)
            && ((!event.ctrlKey && ["g", "G"].includes(event.key)) || (event.ctrlKey && ["e", "y"].includes(event.key)));
    }

    /** The main sections of the visible panel tab: Explorer's Links /
     *  Attributes / Relations, Customise's groups, and so on. Nested sections
     *  belong to their outer section. */
    private panelSections(): HTMLElement[] {
        const root = this.panes.get("panel")?.element;
        if (!root) return [];
        const all = [...root.querySelectorAll<HTMLElement>(".detail-section, .panel-section, button.section-header")]
            .filter(el => this.visible(el));
        return all.filter(el => !all.some(other => other !== el && other.contains(el) && !other.matches("button")))
            .filter((el, index, list) => !(el.matches("button.section-header") && list.some(other => other !== el && other.contains(el))));
    }

    private sectionTarget(section: HTMLElement): HTMLElement {
        if (section.matches("button")) return section;
        const target = section.querySelector<HTMLElement>("button.section-header:not(:disabled)")
            ?? [...section.querySelectorAll<HTMLElement>("button:not(:disabled), summary, a[href], [tabindex='0']")].find(el => this.visible(el));
        if (target) return target;
        if (!section.hasAttribute("tabindex")) section.setAttribute("tabindex", "-1");
        return section;
    }

    /** Space arms a one-second leader in any pane; Space Ctrl-f/d then cycles a
     *  sub-tab group ([data-subtabs]: Explorer here/every/data, Data rows from,
     *  Snaps grouping, Customise graph/background) instead of the main tabs.
     *  The group containing focus wins, else the first visible one in the panel. */
    private subtabKey(event: KeyboardEvent): boolean {
        if (event.altKey || event.metaKey || event.isComposing) return false;
        const editable = event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");
        if (!event.ctrlKey && !event.shiftKey && event.key === " " && !editable) {
            this.sectionLeaderAt = performance.now();
            return false;
        }
        if (!event.ctrlKey || event.shiftKey || !["f", "d"].includes(event.key.toLowerCase()) || !this.sectionLeader) return false;
        const panel = this.panes.get("panel")?.element;
        const groups = [...panel?.querySelectorAll<HTMLElement>("[data-subtabs]") ?? []].filter(group => this.visible(group));
        const active = document.activeElement;
        const group = groups.find(g => active instanceof Node && g.contains(active)) ?? groups[0];
        this.sectionLeaderAt = -Infinity;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!group) { this.lastAction = "Space Ctrl-" + event.key + ": no sub-tabs here"; return true; }
        const tabs = [...group.querySelectorAll<HTMLButtonElement>("[data-subtab]")].filter(tab => !tab.disabled && this.visible(tab));
        if (!tabs.length) return true;
        const current = tabs.findIndex(tab => tab.classList.contains("active") || tab.getAttribute("aria-checked") === "true");
        const next = tabs[(current + (event.key.toLowerCase() === "f" ? 1 : -1) + tabs.length) % tabs.length];
        const hadFocus = active instanceof Node && group.contains(active);
        next.click();
        if (hadFocus) next.focus();
        this.lastAction = "Space Ctrl-" + event.key + " sub-tab";
        return true;
    }

    private explorerKey(event: KeyboardEvent): boolean {
        if (this.focusedPane !== "panel" || event.altKey || event.metaKey || event.isComposing) return false;
        if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable='true']")) return false;
        if (!event.ctrlKey && !event.shiftKey && event.key === " ") {
            // Arm the leader; the graph canvas still sees Space for its own leader.
            // A focused button must not also activate on this Space.
            this.sectionLeaderAt = performance.now();
            if (event.target instanceof HTMLElement && event.target.closest("button, summary, [role='button']")) {
                event.preventDefault(); this.swallowSpaceUp = true;
            }
            return false;
        }
        if (!event.ctrlKey || event.shiftKey || !["n", "p"].includes(event.key)) return false;
        const direction = event.key === "n" ? 1 : -1;
        const active = document.activeElement as HTMLElement | null;
        if (this.sectionLeader) {
            this.sectionLeaderAt = -Infinity;
            const sections = this.panelSections();
            if (!sections.length) return false;
            const index = sections.findIndex(section => section === active || section.contains(active));
            const next = sections[index < 0 ? (direction > 0 ? 0 : sections.length - 1) : (index + direction + sections.length) % sections.length];
            this.sectionTarget(next).focus();
            next.scrollIntoView({ block: "nearest" });
            this.lastAction = "Space Ctrl-" + event.key + " section";
        } else {
            const root = this.panes.get("panel")?.element.querySelector<HTMLElement>(".explorer-pane");
            if (!root) return false;
            const items = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), summary, [tabindex='0']")].filter(el => this.visible(el));
            if (!items.length) return false;
            const index = items.indexOf(active as HTMLElement);
            items[index < 0 ? (direction > 0 ? 0 : items.length - 1) : (index + direction + items.length) % items.length].focus();
        }
        event.preventDefault(); event.stopImmediatePropagation(); return true;
    }

    private onKeyUp = (event: KeyboardEvent): void => {
        if (event.key !== " " || !this.swallowSpaceUp) return;
        this.swallowSpaceUp = false;
        event.preventDefault();
    };

    /** zc / zo on the focused panel section (the canvas owns the z prefix). */
    foldSection(open: boolean): boolean {
        if (this.focusedPane !== "panel") return false;
        const root = this.panes.get("panel")?.element;
        const active = document.activeElement as HTMLElement | null;
        const section = active?.closest(".detail-section, .panel-section");
        const header = (active?.matches("button.section-header") ? active : null)
            ?? section?.querySelector<HTMLElement>("button.section-header") ?? root?.querySelector<HTMLElement>("button.section-header");
        if (!header) return false;
        const expanded = header.getAttribute("aria-expanded") === "true" || !!header.querySelector(".fa-chevron-down");
        if (expanded !== open) header.click();
        header.focus({ preventScroll: true });
        return true;
    }

    private scrollPane(event: KeyboardEvent): boolean {
        if (event.altKey || event.metaKey || event.isComposing || event.defaultPrevented) return false;
        const cycle = event.ctrlKey && !event.shiftKey && ["d", "f"].includes(event.key.toLowerCase());
        if (event.composedPath().some(target => target instanceof HTMLElement &&
            (target.closest("[role='dialog'], [role='menu']") || (!cycle && (target.isContentEditable
            || target.closest("input, textarea, select, [role='textbox']")))))) return false;
        if (document.querySelector(".cdk-overlay-pane .mat-mdc-dialog-container, .cdk-overlay-pane .mat-mdc-menu-panel, .cdk-overlay-pane .mat-mdc-select-panel")) return false;
        const id = this.focusedPane;
        if (cycle && id) {
            const scope = document.querySelector(`[data-pane-tabs="${id === "graph" ? "output" : id}"]`);
            const tabs = [...scope?.querySelectorAll<HTMLElement>("[data-pane-tab], .mat-button-toggle-button") ?? []]
                .filter(tab => !tab.hasAttribute("disabled") && tab.getAttribute("aria-disabled") !== "true");
            if (!tabs.length) return false;
            event.preventDefault(); event.stopImmediatePropagation();
            if (!event.repeat) {
                const index = tabs.findIndex(tab => tab.classList.contains("active") || tab.getAttribute("aria-checked") === "true");
                const next = tabs[(index + (event.key.toLowerCase() === "f" ? 1 : -1) + tabs.length) % tabs.length];
                next.click();
                next.scrollIntoView({ block: "nearest", inline: "nearest" });
                // Tab changes can replace the focused scroll container.
                const revision = this.focusRevision;
                setTimeout(() => { if (revision === this.focusRevision) this.focus(id === "graph" ? "output" : id); });
            }
            return true;
        }
        if (!id || id === "graph" || id === "query") return false;
        const line = event.ctrlKey && !event.shiftKey && ["e", "y"].includes(event.key.toLowerCase());
        const top = !event.ctrlKey && event.key === "g";
        const bottom = !event.ctrlKey && event.key === "G";
        if (!line && !top && !bottom) {
            if (this.topPending && !["Shift", "Alt", "Control", "Meta"].includes(event.key)) this.releasedG = event;
            this.topPending = null; return false;
        }
        event.preventDefault(); event.stopImmediatePropagation();
        if (top && this.topPending !== id) {
            if (!event.repeat) {
                this.topPending = id; clearTimeout(this.topTimer);
                this.topTimer = setTimeout(() => this.topPending = null, 1000);
            }
            return true;
        }
        this.topPending = null; clearTimeout(this.topTimer);
        const pane = this.panes.get(id)!;
        const scrollable = (el: HTMLElement) => this.visible(el) && el.scrollHeight > el.clientHeight
            && /auto|scroll/.test(getComputedStyle(el).overflowY);
        let target = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        while (target && pane.element.contains(target) && !scrollable(target)) target = target.parentElement;
        if (!target || !pane.element.contains(target)) target = [pane.focusTarget(), pane.element,
            ...pane.element.querySelectorAll<HTMLElement>(".panel-scroll, .detail-content, [role='tabpanel']")]
            .find((el): el is HTMLElement => !!el && scrollable(el)) ?? null;
        // A panel at its boundary still owns this chord; never pan the graph behind it.
        event.preventDefault(); event.stopImmediatePropagation();
        if (target) {
            if (top) target.scrollTop = 0;
            else if (bottom) target.scrollTop = target.scrollHeight;
            else target.scrollTop += (event.key.toLowerCase() === "e" ? 1 : -1)
                * (parseFloat(getComputedStyle(target).lineHeight) || 20) * 2;
        }
        return true;
    }

    private onKey = (event: KeyboardEvent): void => {
        if (!this.panes.size) return;
        if (!this.chordPending) {
            // Material selects/menus use the same key manager for arrows. Native
            // selects need an explicit change because synthetic arrows have no default action.
            if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && ["n", "p"].includes(event.key)) {
                const target = event.target;
                if (target instanceof HTMLSelectElement) {
                    const options = [...target.options], direction = event.key === "n" ? 1 : -1;
                    let next = target.selectedIndex + direction;
                    while (options[next]?.disabled) next += direction;
                    if (options[next]) { target.selectedIndex = next; target.dispatchEvent(new Event("change", { bubbles: true })); }
                    event.preventDefault(); event.stopImmediatePropagation(); return;
                }
                if (target instanceof HTMLElement && target.closest("mat-select, input[role='combobox'], [role='listbox'], [role='menu'], .mat-mdc-menu-panel")) {
                    event.preventDefault(); event.stopImmediatePropagation();
                    const down = event.key === "n";
                    target.dispatchEvent(new KeyboardEvent("keydown", { key: down ? "ArrowDown" : "ArrowUp", code: down ? "ArrowDown" : "ArrowUp",
                        keyCode: down ? 40 : 38, bubbles: true, cancelable: true }));
                    return;
                }
            }
            if (this.subtabKey(event)) return;
            if (this.explorerKey(event)) return;
            if (this.scrollPane(event)) return;
            if (!panePrefix(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.chordPending = true;
            this.chordTimer = setTimeout(this.cancelChord, 1500);
            return;
        }
        if (["Shift", "Alt", "Control", "Meta"].includes(event.key)) return;
        if (this.resizePending) {
            this.cancelChord();
            event.preventDefault(); event.stopImmediatePropagation();
            const letter = event.key.toLowerCase();
            if (!event.altKey && !event.metaKey && (letter === "j" || letter === "k")) {
                const pane = this.focusedPane;
                this.lastAction = `Ctrl+w Space ${letter}`;
                this.zone.run(() => this.resize$.next({ pane, grow: letter === "j" }));
            } else this.lastAction = "Ctrl+w Space cancelled";
            return;
        }
        if (event.key === " " && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault(); event.stopImmediatePropagation();
            this.resizePending = true;
            clearTimeout(this.chordTimer);
            this.chordTimer = setTimeout(this.cancelChord, 1500);
            return;
        }
        const action = paneAction(event);
        if (!action) return;
        this.cancelChord();
        event.preventDefault();
        event.stopImmediatePropagation();
        if (action === "cancel") { this.lastAction = "Ctrl+w cancelled"; return; }
        this.zone.run(() => this.run(action));
    };

    private run(action: Exclude<PaneAction, "cancel">): void {
        const panes = this.geometry();
        const from = this.origin(panes);
        if (action.startsWith("jump:")) {
            let target = action.slice(5) as PaneId;
            if (target === "graph" && !panes.some(pane => pane.id === "graph")) target = "output";
            if (target === "explorer" && !panes.some(pane => pane.id === "explorer") && panes.some(pane => pane.id === "panel")) { this.focus("explorer", `Ctrl+w ${action}`); return; }
            if (panes.some(pane => pane.id === target)) this.focus(target, `Ctrl+w ${action}`);
            else this.lastAction = `Ctrl+w ${target} (not on this page)`;
            return;
        }
        if (action === "previous") {
            const pane = !this.enteredFromOutside && this.previousPane
                && panes.some(candidate => candidate.id === this.previousPane) ? this.previousPane : null;
            if (pane) this.focus(pane, "Ctrl+w p");
            else void this.escalate("previous");
            return;
        }
        if (action === "farLeft" || action === "farRight") {
            void this.escalate(action === "farLeft" ? "far-west" : "far-east");
            return;
        }
        if (action === "cycle") {
            const target = nextPaneInCycle(panes, from);
            if (target) this.focus(target, "Ctrl+w w");
            return;
        }
        const direction = action as PaneDirection;
        const target = from ? nextPane(panes, from, direction) : nextPaneInCycle(panes, null);
        if (target) this.focus(target, `Ctrl+w ${direction}`);
        else void this.escalate(paneEscalation[direction]);
    }

    focus(id: PaneId, label = ""): void {
        this.focusRevision++;
        this.topPending = null;
        clearTimeout(this.topTimer);
        if (id === "output" && this.panes.has("graph") && this.visible(this.panes.get("graph")!.element)) id = "graph";
        if (id === "graph" && (!this.panes.has("graph") || !this.visible(this.panes.get("graph")!.element))) id = "output";
        if (id === "explorer" && !this.panes.has("explorer") && this.panes.has("panel")) {
            this.panes.get("panel")!.element.querySelector<HTMLElement>('[data-panel-tab="explorer"]')?.click();
            id = "panel";
        }
        const pane = this.panes.get(id);
        if (!pane) return;
        const target = pane.focusTarget() ?? pane.element;
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        // preventScroll: focusing a pane must not jump its scroll position;
        // the user scrolls it deliberately afterwards, usually with Vimium.
        target.focus({ preventScroll: true });
        this.enteredFromOutside = false;
        if (this.activePane !== id) this.previousPane = this.activePane;
        this.activePane = id;
        this.lastAction = label;
        for (const [paneId, registration] of this.panes) {
            registration.element.classList.toggle("pane-active", paneId === id);
        }
    }

    /** Hand the motion to the window manager.
     *
     *  Gated on the bridge answering rather than on `nvim=1`: the escalation
     *  is useful on any locally served Studio window, and a route opened
     *  without the parameter should not silently swallow edge motions. A
     *  hosted deployment has no bridge, so the first attempt settles it and
     *  nothing is sent again. */
    private async escalate(direction: PaneEscalation): Promise<void> {
        this.lastAction = `Ctrl+w ${direction} (window)`;
        if (this.bridgeAbsent || !["localhost", "127.0.0.1"].includes(location.hostname)) return;
        try {
            const response = await fetch("/api/viewer/focus", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ direction }),
            });
            if (response.status === 404) this.bridgeAbsent = true;
        } catch {
            // Served from a local dev server with no bridge behind it. Edge
            // motions are best-effort, and retrying every keystroke is noise.
            this.bridgeAbsent = true;
        }
    }
}
