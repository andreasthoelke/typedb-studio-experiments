import { toSignal } from "@angular/core/rxjs-interop";
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Component, ChangeDetectorRef, Injector, DestroyableInjector, ElementRef, EventEmitter, HostBinding, inject, Input, DoCheck, OnChanges, OnDestroy, Output, ViewChild, AfterViewInit, AfterViewChecked } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ResizableDirective } from "@hhangular/resizable";
import { Subscription } from "rxjs";
import { GraphVisualiser } from "../engine";
import { newGraph } from "../engine/graph";
import { Layouts } from "../engine/layout";
import { createSigmaRenderer, defaultSigmaSettings } from "../engine/sigma-settings";
import { GraphControlsComponent } from "./graph-controls/graph-controls.component";
import { GraphSidePanelComponent } from "../side-panel/graph-side-panel.component";
import { GraphContextMenuComponent } from "../context-menu/graph-context-menu.component";
import { GraphStyleService, buildBackgroundCSS } from "../../../service/graph-style.service";
import { RunOutputState } from "../../../service/query-page-state.service";
import { SelectionMode } from "../../../service/graph-view-state.service";

import { Router } from "@angular/router";
import type { GraphSnap } from "../../util/graph-snap";
import { GraphSnapshotContext, GraphSnapLibrary, GraphSnapshotService, SavedGraphSnap } from "../../../service/graph-snapshot.service";
import { DriverState } from "../../../service/driver-state.service";
import { SchemaState } from "../../../service/schema-state.service";
import { SnackbarService } from "../../../service/snackbar.service";
import { graphExportBaseName, ExportType } from "../../util/graph-export-name";
import { GraphKeyLeader, GraphViewCommand, graphLetterKey, graphShortcut } from "../../util/graph-shortcuts";
import { fuzzyGraphMatches, GraphFinderEntry } from "../../util/graph-finder";

import { graphNodeHints, graphSelectionEdit, GraphNodeHint, GraphDirection } from "../../util/graph-navigation";
import { PaneDirective } from "../../pane-focus/pane.directive";
import { PaneFocusService } from "../../../service/pane-focus.service";

export type GraphCanvasStatus = "ok" | "running" | "noQueryAnswers" | "noInstancesFound" | "error" | "graphlessQueryType" | "answerOutputDisabled" | "multiQuery" | "emptySchema" | "emptySnap" | "needsTransaction";
export type GraphCanvasStatusAction = "viewLog" | "openTransaction" | "switchToAuto";

@Component({
    selector: "ts-graph-canvas",
    templateUrl: "graph-canvas.component.html",
    styleUrls: ["graph-canvas.component.scss"],
    imports: [NgTemplateOutlet, MatTooltipModule, ResizableDirective, PaneDirective, GraphControlsComponent, GraphSidePanelComponent, GraphContextMenuComponent],
})
export class GraphCanvasComponent implements OnChanges, DoCheck, AfterViewInit, AfterViewChecked, OnDestroy {
    private liveVisualiser: GraphVisualiser | null = null;
    private liveCanvasRebuilding = false;
    private liveStatus: GraphCanvasStatus = "ok";
    private snapVisualiser: GraphVisualiser | null = null;
    inlineSnap: GraphSnap | null = null;
    snapInjector: DestroyableInjector | null = null;
    private snapStyles: GraphStyleService | null = null;
    private snapStylesSub?: Subscription;
    private injector = inject(Injector);
    protected paneFocus = inject(PaneFocusService);
    private host = inject<ElementRef<HTMLElement>>(ElementRef);
    private static keyboardOwner: GraphCanvasComponent | null = null;
    shortcutHelpOpen = false;
    lastShortcut = "None received yet";
    leaderPending: GraphKeyLeader | null = null;
    nodeHints: GraphNodeHint[] = [];
    hintPrefix = "";
    private hintGeometry = "";
    get visibleNodeHints() { return this.nodeHints.filter(hint => hint.label.startsWith(this.hintPrefix)); }
    private geometrySignature(): string {
        const v = this.visualiser;
        return v ? JSON.stringify([v.graph.order, v.sigma.getCamera().getState(), v.sigma.getDimensions()]) : "";
    }
    private leaderTimer: ReturnType<typeof setTimeout> | null = null;
    private leaderVisualiser: GraphVisualiser | null = null;
    private leaderCaret: string | null = null;

    private cancelKeySequence = (): void => {
        this.leaderPending = null;
        this.nodeHints = []; this.hintPrefix = ""; this.hintGeometry = "";
        if (this.leaderTimer !== null) clearTimeout(this.leaderTimer);
        this.leaderTimer = null;
        this.leaderVisualiser = null;
        this.leaderCaret = null;
    };

    get navigationMode() { return this.visualiser?.navigation.mode ?? "normal"; }

    /** Commands from Neovim address this route's current canvas, including in a
     * background tab. They do not synthesize keyboard events or steal focus. */
    async runViewerCommand(command: GraphViewCommand): Promise<boolean> {
        const v = this.visualiser;
        if (!v || this.queryRunning) return false;
        this.cancelKeySequence();
        switch (command) {
            case "centreCaret": return v.centreCaret();
            case "caretTop": return v.centreCaret(.5, .125);
            case "caretBottom": return v.centreCaret(.5, .875);
            case "caretLeft": return v.centreCaret(.125, .5);
            case "caretRight": return v.centreCaret(.875, .5);
            case "panLeft": case "panRight": case "panUp": case "panDown":
                v.panNavigation(command === "panLeft" ? "left" : command === "panRight" ? "right" : command === "panUp" ? "up" : "down"); return true;
            case "zoomIn": case "zoomOut": v.zoom(command === "zoomIn" ? "in" : "out"); return true;
            case "focus": v.focusHighlightedNodes(); return true;
            case "back": return v.backNavigation();
            case "relayout": v.reLayout(); return true;
            case "snap": if (!this.canExportPng()) return false; await this.saveSnap(); return true;
        }
    }

    private isKeyboardVisible(): boolean {
        const el = this.host.nativeElement;
        return el.isConnected && !el.closest(".invisible, [hidden], [inert], [aria-hidden='true']")
            && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    }

    private ownKeyboard = (event: Event): void => {
        this.cancelKeySequence();
        if (!event.composedPath().some(target => target instanceof HTMLElement && target.closest(".graph-finder"))) this.finderOpen = false;
        if (event.composedPath().includes(this.host.nativeElement)) GraphCanvasComponent.keyboardOwner = this;
        if (event.type === "pointerdown" && event.composedPath().includes(this.host.nativeElement)
            && event.target instanceof HTMLCanvasElement) this.paneFocus.focus("graph");
    };

    private onGraphKey = (event: KeyboardEvent): void => {
        if (!this.isKeyboardVisible() || document.hidden) { this.cancelKeySequence(); return; }
        // A pending <c-w> owns the next key wherever focus is. Listener order
        // between window-capture handlers is not guaranteed, so ask rather
        // than rely on the pane service having stopped propagation first.
        if (this.paneFocus.chordPending) { this.cancelKeySequence(); return; }
        const owner = GraphCanvasComponent.keyboardOwner;
        if (owner && owner !== this && owner.isKeyboardVisible()) { this.cancelKeySequence(); return; }
        // Includes CodeMirror, native controls, shadow-DOM editors, and open Material overlays.
        if (event.composedPath().some(target => target instanceof HTMLElement &&
            (target.isContentEditable || target.closest("input, textarea, select, [role='textbox'], [role='dialog'], [role='menu']")))) { this.cancelKeySequence(); return; }
        if (document.querySelector(".cdk-overlay-pane .mat-mdc-dialog-container, .cdk-overlay-pane .mat-mdc-menu-panel, .cdk-overlay-pane .mat-mdc-select-panel")) { this.cancelKeySequence(); return; }
        if ((this.leaderPending || this.nodeHints.length) && this.leaderVisualiser !== this.visualiser) this.cancelKeySequence();
        if (this.leaderPending === "d" && this.leaderCaret !== this.visualiser?.navigation.caret) { this.cancelKeySequence(); return; }
        if (this.nodeHints.length && this.onHintKey(event)) return;
        // A modifier's own keydown is not the chord yet. In particular, let
        // Ctrl-[ cancel an armed deletion before considering a global clear.
        if (["Shift", "Alt", "Control", "Meta"].includes(event.key)) return;
        const action = graphShortcut(event, this.navigationMode, this.leaderPending);
        if ((action === "panUp" || action === "panDown") && this.paneFocus.focusedPane
            && this.paneFocus.focusedPane !== "graph") { this.cancelKeySequence(); return; }
        if (!action) {
            if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) this.cancelKeySequence();
            return;
        }
        if ((action === "focus" || action === "leader") && event.composedPath().some(target => target instanceof HTMLElement &&
            target.closest("button, a[href], [role='button']"))) { this.cancelKeySequence(); return; }
        GraphCanvasComponent.keyboardOwner = this;
        event.preventDefault();
        event.stopImmediatePropagation();
        const prefix = this.leaderPending === "d" ? "d " : this.leaderPending && (action === "previous" || action === "next") ? "Space " : event.ctrlKey ? "Ctrl+" : "";
        this.lastShortcut = `${prefix}${event.key === " " ? "Space" : event.key} → ${action}`;
        this.cancelKeySequence();
        if (action === "leader" || action === "hintLeader" || action === "centreLeader" || action === "deleteLeader" || action === "historyLeader") {
            if (action === "deleteLeader" && this.queryRunning) return;
            this.leaderPending = action === "leader" ? "space" : action === "hintLeader" ? "comma" : action === "deleteLeader" ? "d" : action === "historyLeader" ? "g" : "z";
            this.leaderVisualiser = this.visualiser;
            this.leaderCaret = this.visualiser?.navigation.caret ?? null;
            this.leaderTimer = setTimeout(this.cancelKeySequence, 1000);
            return;
        }
        if (action === "cancelLeader") return;
        if (action === "help") { this.shortcutHelpOpen = !this.shortcutHelpOpen; this.showSnapsTab(); }
        else if (action === "clear") { this.finderOpen = false; this.shortcutHelpOpen = false; this.visualiser?.clearGraphSelection(); }
        else if (action === "centreCaret") { if (!this.visualiser?.centreCaret()) this.lastShortcut += " (no caret)"; }
        else if (action === "caretTop" || action === "caretBottom" || action === "caretLeft" || action === "caretRight") {
            if (!this.visualiser?.centreCaret(action === "caretLeft" ? 0.125 : action === "caretRight" ? 0.875 : 0.5,
                action === "caretTop" ? 0.125 : action === "caretBottom" ? 0.875 : 0.5)) this.lastShortcut += " (no caret)";
        }
        else if (action === "hints") { this.startNodeHints(); }
        else if (action === "caret") {
            if (this.queryRunning) return;
            this.visualiser?.enterNavigation();
            if (this.sidePanel && this.navigationMode !== "normal") this.sidePanel.inspectorTab = "explorer";
        }
        else if (action === "left" || action === "right" || action === "up" || action === "down"
            || action === "downLeft" || action === "upRight" || action === "upLeft" || action === "downRight") {
            if (!this.queryRunning && !this.visualiser?.moveNavigation(action, graphSelectionEdit(event))) this.lastShortcut += " (no node in that direction)";
        }
        else if (action.startsWith("nudge:")) {
            if (!this.queryRunning && !this.visualiser?.nudgeCaret(action.slice(6) as GraphDirection)) this.lastShortcut += " (no caret)";
        }
        else if (action === "back") {
            if (!this.queryRunning && !this.visualiser?.backNavigation()) this.lastShortcut += " (no earlier node)";
        }
        else if (action === "panLeft" || action === "panRight" || action === "panUp" || action === "panDown") {
            this.visualiser?.panNavigation(action === "panLeft" ? "left" : action === "panRight" ? "right" : action === "panUp" ? "up" : "down");
        }
        else if (action === "remove") {
            if (!this.queryRunning) this.lastShortcut += ` (${this.visualiser?.removeSelectedFromGraph() ?? 0} removed from view)`;
        }
        else if (action === "removeCaret") {
            if (!this.queryRunning) this.lastShortcut += ` (${this.visualiser?.removeCaretFromGraph() ?? 0} removed from view)`;
        }
        else if (action === "relayout") { if (!this.queryRunning) this.visualiser?.reLayout(); }
        else if (action === "zoomIn" || action === "zoomOut") { this.visualiser?.zoom(action === "zoomIn" ? "in" : "out"); }
        else if (action === "focus") { this.visualiser?.focusHighlightedNodes(); }
        else if (action === "live") { if (this.inlineSnap || this.snapsBusy) this.closeInlineSnap(); }
        else if (action === "find") {
            const input = this.finderInput?.nativeElement;
            input?.focus(); input?.select();
            this.updateFinder(this.finderText);
        } else if (action === "snap") { if (this.canExportPng()) void this.saveSnap(); }
        else if ((action === "next" || action === "previous") && !this.snapsBusy) {
            this.showSnapsTab();
            void this.stepSnap(action === "next" ? 1 : -1);
        }
    };

    private startNodeHints(): void {
        if (this.queryRunning || !this.visualiser) return;
        this.nodeHints = graphNodeHints(this.visualiser.graphHintPoints());
        this.leaderVisualiser = this.visualiser;
        this.hintGeometry = this.geometrySignature();
        this.hintPrefix = "";
    }

    private onHintKey(event: KeyboardEvent): boolean {
        if (event.defaultPrevented || event.isComposing) return true;
        if (["Shift", "Alt", "Control", "Meta"].includes(event.key)) return true;
        if (this.hintGeometry !== this.geometrySignature()) { this.cancelKeySequence(); return true; }
        if (event.ctrlKey && event.key === "[") { this.cancelKeySequence(); return false; }
        if (event.ctrlKey || event.metaKey) { this.cancelKeySequence(); return false; }
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.repeat) return true;
        if (event.key === "Escape") { this.cancelKeySequence(); return true; }
        if (event.key === "Backspace") { this.hintPrefix = this.hintPrefix.slice(0, -1); return true; }
        const letter = graphLetterKey(event);
        this.hintPrefix += letter;
        const matches = this.visibleNodeHints;
        if (!matches.length) { this.cancelKeySequence(); return true; }
        const match = matches.find(hint => hint.label === this.hintPrefix);
        if (match) {
            this.cancelKeySequence();
            this.visualiser?.pointCaret(match.key, graphSelectionEdit(event), true);
            if (this.sidePanel) this.sidePanel.inspectorTab = "explorer";
            this.lastShortcut = `Graph hint ${match.label} → ${graphSelectionEdit(event) === "none" ? "inspect" : graphSelectionEdit(event)}`;
        }
        return true;
    }

    private showSnapsTab(): void { if (this.sidePanel) this.sidePanel.inspectorTab = "snaps"; }

    private async stepSnap(direction: number): Promise<void> {
        if (!this.snapLibrary) await this.refreshSnaps();
        const files = this.snapFiles;
        if (!files.length || this.destroyed) return;
        const current = files.findIndex(file => this.isActiveSnap(file.filename));
        const next = current < 0 ? (direction > 0 ? 0 : files.length - 1) : (current + direction + files.length) % files.length;
        await this.openSavedSnap(files[next].filename);
    }

    private cdr = inject(ChangeDetectorRef);
    private rehomingSnap = false;
    @ViewChild("snapCanvasEl") snapCanvasEl?: ElementRef<HTMLElement>;

    @Input() set visualiser(value: GraphVisualiser | null) {
        if (this.inlineSnap && !this.liveCanvasRebuilding && value?.graph !== this.liveVisualiser?.graph) this.closeInlineSnap();
        this.liveCanvasRebuilding = false;
        this.liveVisualiser = value;
    }
    get visualiser(): GraphVisualiser | null { return this.snapVisualiser ?? this.liveVisualiser; }
    @Input() set status(value: GraphCanvasStatus) { this.liveStatus = value; }
    get status(): GraphCanvasStatus { return this.inlineSnap ? "ok" : this.liveStatus; }
    @Input() graphPercent = 75;
    @Input() stylesPanePercent = 25;
    @Input() maximised = false;

    /** Side-panel size when docked bottom. Kept separate from
     *  `stylesPanePercent` (the right-dock width) because a width-tuned value
     *  is too short as a height — bottom defaults taller. */
    private bottomPanePercent = 45;
    /** The run that owns this canvas's graph. Passed through to the side panel
     *  so the Inspector knows where to push instances/attributes/links. */
    @Input() run: RunOutputState | null = null;
    @Input() restoreSavedView?: (snap: GraphSnap) => void;
    /** Query pages keep a shared canvas reference for future runs as well. */
    @Input() parentManagesCanvas = false;
    /** True if the parent surface tracks a "Reset changes" capability and the
     *  graph currently has something to reset (e.g. a graph-view tab whose
     *  contents have diverged from the initial query). Drives the
     *  reset-changes button's enabled state in the zoom-controls panel. */
    @Input() hasChanges = false;
    /** When non-null, an in-canvas toggle is shown for switching between
     *  type-selection and instance-selection modes. Null hides the toggle
     *  (e.g. for canvas usages that don't have a type/instance distinction
     *  like chat output). */
    @Input() selectionMode: SelectionMode | null = null;
    /** Original source for schema context exports when there is no query run. */
    @Input() contextQuery = "";
    /** True for the schema visualiser surface (graphs schema type nodes, not
     *  data instances). Passed to the side panel so the type explorer hides
     *  instance-oriented UI (the "N in graph" count and connection chips). */
    @Input() schemaMode = false;
    private externalSnapshotMode = false;
    private externalSnap: GraphSnap | null = null;
    @Input() set snapshotMode(value: boolean) { this.externalSnapshotMode = value; }
    get snapshotMode(): boolean { return !!this.inlineSnap || this.externalSnapshotMode; }
    @Input() set loadedSnap(value: GraphSnap | null) { this.externalSnap = value; }
    get loadedSnap(): GraphSnap | null { return this.inlineSnap ?? this.externalSnap; }

    @Output() maximisedChange = new EventEmitter<boolean>();
    @Output() graphPercentChange = new EventEmitter<number>();
    @Output() stylesPanePercentChange = new EventEmitter<number>();
    @Output() statusAction = new EventEmitter<GraphCanvasStatusAction>();
    @Output() resetChangesClicked = new EventEmitter<void>();
    @Output() selectionModeChange = new EventEmitter<SelectionMode>();
    /** Fires when the `#canvasEl` host node is rebuilt (dock axis flip rebuilds
     *  the resizable subtree). Surfaces are responsible for re-homing their
     *  sigma renderer onto the new element. The internal `[run]`-driven path in
     *  `ngAfterViewChecked` already handles this for the graph page; surfaces
     *  with `parentManagesCanvas` listen to this instead. Emits the new
     *  element. */
    @Output() canvasElRebuilt = new EventEmitter<HTMLElement>();

    get queryRunning() { return this.status === "running"; }

    @ViewChild(GraphSidePanelComponent) sidePanel?: GraphSidePanelComponent;

    @ViewChild("canvasEl", { static: false }) canvasElRef?: ElementRef<HTMLElement>;

    @HostBinding("class.graph-dark") isDark = true;
    @HostBinding("class.graph-light") isLight = false;

    private stylesSub: Subscription;

    constructor(private liveStyleService: GraphStyleService) {
        window.addEventListener("keydown", this.onGraphKey, true);
        window.addEventListener("pointerdown", this.ownKeyboard, true);
        window.addEventListener("focusin", this.ownKeyboard, true);
        window.addEventListener("blur", this.cancelKeySequence);
        window.addEventListener("resize", this.cancelKeySequence);
        window.addEventListener("wheel", this.cancelKeySequence, true);
        document.addEventListener("visibilitychange", this.cancelKeySequence);
        this.stylesSub = this.styleService.styles$.subscribe(() => {
            this.updateControlTheme();
            this.applyBackground();
        });
        this.updateControlTheme();
    }

    /** The canvas element currently hosting the sigma renderer. When the dock
     *  axis flips, the `@if` rebuilds `.canvas-element`, so we detect the new
     *  node here and move the renderer onto it (preserving graph + camera). */
    private attachedCanvasEl: HTMLElement | null = null;

    @ViewChild("finderInput") finderInput?: ElementRef<HTMLInputElement>;
    @ViewChild("finderOptions") finderOptions?: ElementRef<HTMLElement>;
    private static nextFinderId = 0;
    readonly finderListId = `graph-finder-${GraphCanvasComponent.nextFinderId++}`;
    finderText = "";
    finderOpen = false;
    finderResults: GraphFinderEntry[] = [];
    finderIndex = -1;
    private finderVisualiser: GraphVisualiser | null = null;
    private finderGraphOrder = -1;
    private scrollFinder = false;

    get finderActiveId(): string | null {
        return this.finderOpen && this.finderIndex >= 0 ? `${this.finderListId}-${this.finderIndex}` : null;
    }

    updateFinder(text: string): void {
        this.finderGraphOrder = this.visualiser?.graph.order ?? -1;
        this.finderText = text;
        this.finderOpen = true;
        // One destination per row, never a type-wide selection or search fade.
        this.finderResults = fuzzyGraphMatches(this.visualiser?.finderEntries() ?? [], text).slice(0, 60);
        this.finderIndex = this.finderResults.length ? 0 : -1;
        this.scrollFinder = true;
    }

    onFinderBlur(event: FocusEvent): void {
        // Vimium may consume Escape in insert mode and blur the input itself.
        // Also dismiss on Tab, retaining focus moves to the clear button inside.
        if (!(event.relatedTarget instanceof Node) || !(event.currentTarget as HTMLElement).contains(event.relatedTarget)) this.finderOpen = false;
    }

    onFinderKey(event: KeyboardEvent): void {
        if (event.isComposing || event.defaultPrevented || event.metaKey || event.altKey) return;
        const key = event.key.toLowerCase();
        const next = event.ctrlKey ? key === "n" : event.key === "ArrowDown";
        const previous = event.ctrlKey ? key === "p" : event.key === "ArrowUp";
        const cancel = event.key === "Escape" || (event.ctrlKey && event.key === "[");
        const accept = !event.ctrlKey && event.key === "Enter";
        if (!(next || previous || cancel || accept)) return;
        event.preventDefault(); event.stopPropagation();
        if (cancel) { this.closeFinder(); return; }
        if (accept) { if (!event.repeat) this.acceptFinder(); return; }
        if (!this.finderOpen) this.updateFinder(this.finderText);
        if (this.finderResults.length) {
            this.finderIndex = (this.finderIndex + (next ? 1 : -1) + this.finderResults.length) % this.finderResults.length;
            this.scrollFinder = true;
        }
    }

    acceptFinder(index = this.finderIndex): void {
        const entry = this.finderResults[index];
        if (!entry || this.queryRunning || !this.visualiser?.pointCaret(entry.nodes[0], "none", true)) return;
        this.closeFinder();
        if (this.sidePanel) this.sidePanel.inspectorTab = "explorer";
    }

    closeFinder(): void {
        this.finderOpen = false;
        // Return keyboard control to the graph, without clearing inspection or highlights.
        this.finderInput?.nativeElement.blur();
    }

    clearFinder(): void {
        this.updateFinder("");
        this.finderInput?.nativeElement.focus();
    }

    private get styleService(): GraphStyleService { return this.snapStyles ?? this.liveStyleService; }

    closeInlineSnap(): void {
        ++this.snapOpenRequest;
        this.snapVisualiser?.destroy();
        this.snapVisualiser = null;
        this.inlineSnap = null;
        this.snapStylesSub?.unsubscribe();
        this.snapStyles = null;
        this.snapInjector?.destroy();
        this.snapInjector = null;
        this.finderVisualiser = null;
        this.ngOnChanges();
        this.updateControlTheme();
        this.applyBackground();
        if (!this.destroyed && this.liveVisualiser?.sigma.getContainer().querySelector("canvas")) {
            this.liveVisualiser.applyStyleUpdate();
            this.liveVisualiser.applyEdgeStyleUpdate();
        }
    }

    private restoreInlineSnap(snap: GraphSnap): void {
        if ((snap.schemaMode ? "schema" : "data") !== this.snapKind) throw new Error(`Open this snap from the ${snap.schemaMode ? 'schema' : 'query'} route.`);
        if (!this.snapInjector) {
            this.snapInjector = Injector.create({ providers: [GraphStyleService], parent: this.injector });
            this.snapStyles = this.snapInjector.get(GraphStyleService);
            this.snapStylesSub = this.snapStyles.styles$.subscribe(() => { this.updateControlTheme(); this.applyBackground(); });
        }
        this.inlineSnap = snap;
        this.cdr.detectChanges();
        this.renderInlineSnap(snap);
        this.finderVisualiser = null;
        this.ngOnChanges();
        this.cdr.detectChanges();
        if (this.sidePanel) this.sidePanel.inspectorTab = "snaps";
    }

    private renderInlineSnap(snap: GraphSnap): void {
        const container = this.snapCanvasEl?.nativeElement;
        if (!container || !this.snapStyles) return;
        this.snapVisualiser?.destroy();
        this.snapStyles.applyCapturedPreset(snap.style);
        const graph = newGraph();
        graph.import(snap.graph);
        const sigma = createSigmaRenderer(container, defaultSigmaSettings as any, graph);
        this.snapVisualiser = new GraphVisualiser(graph, sigma, Layouts.createD3ForceSupervisor(graph), this.snapStyles);
        for (const node of snap.graph.nodes) graph.replaceNodeAttributes(node.key, structuredClone(node.attributes!));
        for (const edge of snap.graph.edges) graph.replaceEdgeAttributes(edge.key!, structuredClone(edge.attributes!));
        this.snapVisualiser.restoreSnapView(snap);
        this.applyBackground();
    }

    private libraryContextKey = "";
    private destroyed = false;
    ngDoCheck(): void {
        if (this.nodeHints.length && (this.leaderVisualiser !== this.visualiser || this.hintGeometry !== this.geometrySignature())) this.cancelKeySequence();
        const key = JSON.stringify([this.snapshotDatabase, this.snapshotContext]);
        if (key !== this.libraryContextKey) {
            this.libraryContextKey = key;
            ++this.libraryRequest;
            this.snapLibrary = null;
            this.snapsBusy = false;
            setTimeout(() => this.refreshSnaps());
        }
        if (this.finderOpen && this.finderGraphOrder !== (this.visualiser?.graph.order ?? -1)) this.updateFinder(this.finderText);
    }

    ngOnChanges() {
        if (this.finderVisualiser !== this.visualiser) {
            this.finderText = this.loadedSnap?.view.finderText ?? ""; this.finderResults = []; this.finderOpen = false;
            this.finderIndex = -1;
            this.finderVisualiser = this.visualiser;
        }
        if (this.selectionMode) this.visualiser?.interactionHandler.setSelectionMode(this.selectionMode);
    }

    ngAfterViewInit() {
        this.applyBackground();
    }

    ngAfterViewChecked() {
        if (this.scrollFinder) {
            this.scrollFinder = false;
            const list = this.finderOptions?.nativeElement;
            const option = list?.children.item(this.finderIndex) as HTMLElement | null;
            if (list && option) {
                const row = option.getBoundingClientRect(), box = list.getBoundingClientRect();
                if (row.top < box.top) list.scrollTop -= box.top - row.top;
                else if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom;
            }
        }
        const snapEl = this.snapCanvasEl?.nativeElement;
        if (this.snapVisualiser && snapEl && snapEl !== this.snapVisualiser.sigma.getContainer() && !this.rehomingSnap) {
            this.rehomingSnap = true;
            const current = this.snapVisualiser.captureSnap(this.inlineSnap!.query, this.inlineSnap!.schemaMode, this.inlineSnap!.expansionQueries);
            setTimeout(() => {
                if (!this.destroyed && this.inlineSnap) { this.renderInlineSnap(current); this.cdr.detectChanges(); }
                this.rehomingSnap = false;
            });
        }
        const el = this.canvasElRef?.nativeElement ?? null;
        if (el && el !== this.attachedCanvasEl && this.attachedCanvasEl !== null) {
            // The host element was rebuilt (dock axis changed). Re-home the
            // renderer onto the new node.
            this.attachedCanvasEl = el;
            this.liveCanvasRebuilding = true;
            if (this.run && !this.parentManagesCanvas) {
                // Graph page: this canvas owns its run, so re-home here.
                // GraphOutputState.attach/detach preserves the graph and
                // restores the camera, so no graph state is lost. Deferred via
                // setTimeout so detach() (which sets visualiser=null) doesn't
                // mutate parent-read state inside the same CD cycle and trip
                // ExpressionChangedAfterItHasBeenCheckedError on GraphTabComponent.
                const run = this.run;
                setTimeout(() => {
                    run.graph.detach();
                    run.graph.attach(el);
                    this.applyBackground();
                    // Use run.graph.visualiser, not this.visualiser: the @Input
                    // hasn't been re-checked yet, so this.visualiser still points
                    // at the destroyed pre-detach instance.
                    run.graph.visualiser?.sigma.resize();
                    run.graph.visualiser?.sigma.refresh();
                });
            } else {
                // Query page (and run-less surfaces): the parent manages
                // attach/detach centrally, so hand it the new element. Deferred
                // for the same CD-safety reason as above.
                setTimeout(() => {
                    this.applyBackground();
                    this.canvasElRebuilt.emit(el);
                });
            }
        } else if (el && this.attachedCanvasEl === null) {
            // First view-check after the parent's initial attach(); record it.
            this.attachedCanvasEl = el;
        }
    }

    ngOnDestroy() {
        this.cancelKeySequence();
        window.removeEventListener("keydown", this.onGraphKey, true);
        window.removeEventListener("pointerdown", this.ownKeyboard, true);
        window.removeEventListener("focusin", this.ownKeyboard, true);
        window.removeEventListener("blur", this.cancelKeySequence);
        window.removeEventListener("resize", this.cancelKeySequence);
        window.removeEventListener("wheel", this.cancelKeySequence, true);
        document.removeEventListener("visibilitychange", this.cancelKeySequence);
        if (GraphCanvasComponent.keyboardOwner === this) GraphCanvasComponent.keyboardOwner = null;
        this.destroyed = true;
        ++this.libraryRequest;
        this.stylesSub.unsubscribe();
        this.closeInlineSnap();
    }

    private applyBackground() {
        const el = this.inlineSnap ? this.snapCanvasEl?.nativeElement : this.canvasElRef?.nativeElement;
        if (!el) return;
        const css = buildBackgroundCSS(this.styleService.background);
        el.style.backgroundColor = css.color;
        el.style.backgroundImage = css.image;
        el.style.backgroundSize = css.size;
    }

    private updateControlTheme() {
        const hex = this.styleService.effectiveBackgroundHex;
        const h = hex.startsWith("#") ? hex.slice(1) : hex;
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        this.isDark = luminance < 0.5;
        this.isLight = luminance >= 0.5;
    }

    get canvasEl(): HTMLElement | undefined {
        return this.canvasElRef?.nativeElement;
    }

    /** Which edge the side panel docks to (graph-wide, persisted). */
    get dock() {
        return this.styleService.sidePanelDock;
    }

    /** True when the outer split stacks vertically (panel docked bottom). */
    get isVertical(): boolean {
        return this.dock === "bottom";
    }

    /** Side-panel size for the current dock (height for bottom, width for right). */
    get sidePanelPercent(): number {
        return this.isVertical ? this.bottomPanePercent : this.stylesPanePercent;
    }

    /** Persist a side-panel resize against the right dock-orientation slot. */
    onSidePanelPercentChange(percent: number): void {
        if (this.isVertical) {
            this.bottomPanePercent = percent;
        } else {
            this.stylesPanePercent = percent;
            this.stylesPanePercentChange.emit(percent);
        }
    }

    toggleMaximised() {
        this.maximised = !this.maximised;
        this.maximisedChange.emit(this.maximised);
        document.body.classList.toggle("graph-fullscreen", this.maximised);
        setTimeout(() => {
            this.visualiser?.sigma.resize();
            this.visualiser?.sigma.refresh();
        });
    }

    private schemaState = inject(SchemaState);
    private snapshots = inject(GraphSnapshotService);
    private router = inject(Router);
    private driver = inject(DriverState);
    private connectionStatus = toSignal(this.driver.status$);
    private snackbar = inject(SnackbarService);

    private exportBaseName(): string {
        const schema = this.schemaState.value$.value;
        const fallback: ExportType[] = [];
        this.visualiser?.graph.forEachNode((_key, attrs) => {
            const concept = attrs.metadata.concept;
            if ("type" in concept && concept.type && "label" in concept.type) fallback.push(concept.type);
            else if ("label" in concept) fallback.push({ label: concept.label, kind: concept.kind });
        });
        const known = schema ? [...Object.values(schema.entities), ...Object.values(schema.relations), ...Object.values(schema.attributes)] : fallback;
        return graphExportBaseName(this.loadedSnap?.query || this.run?.query || this.contextQuery, known, fallback);
    }

    snapsBusy = false;
    snapsError = "";
    projectPath = "";
    snapLibrary: GraphSnapLibrary | null = null;
    private libraryRequest = 0;
    private snapOpenRequest = 0;

    get snapshotDatabase(): string {
        return this.loadedSnap?.database ?? this.run?.graph.database ?? this.driver.database$.value?.name ?? "";
    }

    private get snapshotContext(): GraphSnapshotContext | undefined {
        return this.loadedSnap?.project ?? this.run?.snapshotContext ?? this.snapshots.forDatabase(this.snapshotDatabase);
    }

    private useSnapshotContext(context: GraphSnapshotContext): void {
        this.snapshots.remember(context.database, context.projectTempDirectory);
        if (this.run && !this.inlineSnap) this.run.snapshotContext = context;
        if (this.loadedSnap) this.loadedSnap.project = context;
        this.libraryContextKey = JSON.stringify([this.snapshotDatabase, this.snapshotContext]);
    }

    get snapKind(): "data" | "schema" {
        const path = this.router.url.split(/[?#]/)[0];
        // Query also hosts schema-context runs from editor definitions. Their
        // snaps must be listed and restored here without a route change.
        return path === "/schema" || this.schemaMode ? "schema" : "data";
    }

    get snapFiles(): SavedGraphSnap[] { return this.snapLibrary?.files.filter(file => file.kind === this.snapKind) ?? []; }

    snapName(file: SavedGraphSnap): string {
        if (file.abbreviation) return file.abbreviation;
        const words = file.filename.replace(/-\d+\.snap\.json$/, "").split(/[-_\s]+/);
        return words.slice(0, 10).map(word => [...word].slice(0, 2).join("")).join(" ") + (words.length > 10 ? " .." : "");
    }

    isActiveSnap(filename: string): boolean {
        const active = this.snapshots.activeFile;
        return !!this.loadedSnap && active?.filename === filename && active.database === this.snapshotDatabase
            && active.projectTempDirectory === this.snapLibrary?.projectTempDirectory;
    }

    async deleteSnap(filename: string): Promise<void> {
        if (!this.snapLibrary || this.snapsBusy) return;
        const { database, projectTempDirectory } = this.snapLibrary;
        this.snapsBusy = true;
        this.snapsError = "";
        try {
            await this.snapshots.request("snap", { database, projectTempDirectory, filename }, { method: "DELETE" });
            if (this.isActiveSnap(filename)) this.snapshots.activeFile = null;
            await this.refreshSnaps();
        } catch (error) { this.snapsError = error instanceof Error ? error.message : String(error); }
        finally { this.snapsBusy = false; }
    }

    async refreshSnaps(): Promise<void> {
        if (this.destroyed) return;
        const revision = ++this.libraryRequest;
        const database = this.snapshotDatabase;
        const context = this.snapshotContext;
        this.snapLibrary = null;
        this.projectPath = context?.projectTempDirectory ?? "";
        this.snapsError = "";
        if (!database) { this.snapsError = "Select a database to browse its snaps."; return; }
        this.snapsBusy = true;
        try {
            const library = await this.snapshots.list(database, context);
            if (revision !== this.libraryRequest || database !== this.snapshotDatabase) return;
            this.snapLibrary = library;
            this.projectPath = library.projectTempDirectory;
            // Browsing an older result must not replace the last source project for this DB.
            if (!context) this.useSnapshotContext({ database, projectTempDirectory: library.projectTempDirectory });
        } catch (error) {
            if (revision === this.libraryRequest) this.snapsError = error instanceof Error ? error.message : String(error);
        } finally { if (revision === this.libraryRequest) this.snapsBusy = false; }
    }

    async chooseSnapshotProject(): Promise<void> {
        if (this.snapsBusy || !this.snapshotDatabase) return;
        this.snapsBusy = true;
        this.snapsError = "";
        const database = this.snapshotDatabase;
        const run = this.run;
        const snap = this.loadedSnap;
        try {
            const context = await this.snapshots.selectProject(database, this.projectPath);
            if (database !== this.snapshotDatabase || run !== this.run || snap !== this.loadedSnap) return;
            this.useSnapshotContext(context);
            await this.refreshSnaps();
        } catch (error) { this.snapsError = error instanceof Error ? error.message : String(error); }
        finally { this.snapsBusy = false; }
    }

    get inspectionPreview(): boolean {
        return this.snapshotMode || (!!this.loadedSnap && (this.connectionStatus() !== "connected" ||
            this.snapshotDatabase !== this.driver.database$.value?.name));
    }

    private openGraphSnap(snap: GraphSnap): void {
        if ((snap.schemaMode ? "schema" : "data") !== this.snapKind) throw new Error(`Open this snap from the ${snap.schemaMode ? "schema" : "query"} route.`);
        if (this.restoreSavedView && this.connectionStatus() === "connected" &&
            snap.database === this.driver.database$.value?.name && this.schemaState.value$.value && !this.schemaState.isRefreshing) {
            this.restoreSavedView(snap);
            this.closeInlineSnap();
        } else this.restoreInlineSnap(snap);
    }

    explorePreview(): void {
        if (!this.inlineSnap || !this.restoreSavedView) return;
        try {
            if (this.connectionStatus() !== "connected") throw new Error("Connect to the snap's database to explore current data.");
            this.restoreSavedView(this.inlineSnap);
            this.closeInlineSnap();
        } catch (error) { this.snackbar.warnPersistent(error instanceof Error ? error.message : String(error)); }
    }

    async openSavedSnap(filename: string): Promise<void> {
        if (!this.snapLibrary || this.snapsBusy) return;
        const { database, projectTempDirectory } = this.snapLibrary;
        const request = ++this.snapOpenRequest;
        this.snapsBusy = true;
        try {
            const snap = await this.snapshots.openSaved({ database, projectTempDirectory }, filename);
            if (this.destroyed || request !== this.snapOpenRequest) return;
            this.openGraphSnap(snap);
            this.snapshots.activeFile = { database, projectTempDirectory, filename };
            if (this.sidePanel) this.sidePanel.inspectorTab = "snaps";
        } catch (error) { this.snapsError = error instanceof Error ? error.message : String(error); }
        finally { this.snapsBusy = false; }
    }

    private async requireSnapshotContext(): Promise<GraphSnapshotContext | undefined> {
        if (this.snapshotContext) return this.snapshotContext;
        await this.refreshSnaps();
        if (!this.snapshotContext && this.sidePanel) this.sidePanel.inspectorTab = "snaps";
        return this.snapshotContext;
    }

    snapping = false;
    async saveSnap(): Promise<void> {
        if (!this.visualiser || this.snapping) return;
        this.snapping = true;
        try {
            const visualiser = this.visualiser;
            const context = await this.requireSnapshotContext();
            if (!context || this.visualiser !== visualiser) return;
            const snap = visualiser.captureSnap(this.loadedSnap?.query || this.run?.query || this.run?.graph.query || this.contextQuery, this.loadedSnap?.schemaMode ?? this.schemaMode,
                this.inlineSnap?.expansionQueries ?? this.run?.expansionQueries ?? this.loadedSnap?.expansionQueries ?? []);
            snap.view.finderText = this.finderText;
            snap.view.typeFilter = this.sidePanel?.elements?.typeFilter ?? "";
            snap.database = context.database;
            snap.project = context;
            const result = await this.snapshots.request<{ path: string }>("snap", { name: this.exportBaseName(), ...context }, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap, null, 2),
            });
            this.snackbar.success(`Saved ${result.path}`);
            await this.refreshSnaps();
        } catch (error) { this.snackbar.errorPersistent(error instanceof Error ? error.message : String(error)); }
        finally { this.snapping = false; }
    }

    async openSnap(event: Event): Promise<void> {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0]; input.value = "";
        if (!file) return;
        try { const snap = await this.snapshots.open(file); if (!this.destroyed) { this.openGraphSnap(snap); this.snapshots.activeFile = null; } }
        catch (error) { this.snackbar.errorPersistent(error instanceof Error ? error.message : String(error)); }
    }

    exporting = false;
    async exportPng() {
        const visualiser = this.visualiser;
        if (!visualiser || this.exporting) return;
        const baseName = this.exportBaseName();
        this.exporting = true;
        try {
            const context = await this.requireSnapshotContext();
            if (!context || this.visualiser !== visualiser) return;
            const health = await this.snapshots.request<{ imageFolders?: boolean }>("health", {});
            if (!health.imageFolders) throw new Error("Restart the local viewer server to save PNGs in temp/imgs.");
            const blob = await visualiser.exportPng("currentView");
            const saved = await this.snapshots.request<{ path: string }>("export", { name: baseName, ...context }, {
                method: "POST", headers: { "Content-Type": "image/png" }, body: blob,
            });
            this.snackbar.success(`Saved ${saved.path}`);
        } catch (err) {
            console.error("[Graph PNG Export]", err);
            this.snackbar.errorPersistent(`Could not save graph: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.exporting = false;
        }
    }

    canExportPng(): boolean {
        return !!this.visualiser && this.visualiser.graph.order > 0 && this.status === "ok";
    }
}
