/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Component, ElementRef, EventEmitter, HostBinding, inject, Input, DoCheck, OnChanges, OnDestroy, Output, ViewChild, AfterViewInit, AfterViewChecked } from "@angular/core";
import { DatePipe, NgTemplateOutlet } from "@angular/common";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ResizableDirective } from "@hhangular/resizable";
import { Subscription } from "rxjs";
import { GraphVisualiser } from "../engine";
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
import { fuzzyGraphMatches, GraphFinderEntry } from "../../util/graph-finder";

export type GraphCanvasStatus = "ok" | "running" | "noQueryAnswers" | "noInstancesFound" | "error" | "graphlessQueryType" | "answerOutputDisabled" | "multiQuery" | "emptySchema" | "emptySnap" | "needsTransaction";
export type GraphCanvasStatusAction = "viewLog" | "openTransaction" | "switchToAuto";

@Component({
    selector: "ts-graph-canvas",
    templateUrl: "graph-canvas.component.html",
    styleUrls: ["graph-canvas.component.scss"],
    imports: [DatePipe, NgTemplateOutlet, MatTooltipModule, ResizableDirective, GraphControlsComponent, GraphSidePanelComponent, GraphContextMenuComponent],
})
export class GraphCanvasComponent implements OnChanges, DoCheck, AfterViewInit, AfterViewChecked, OnDestroy {
    @Input() visualiser: GraphVisualiser | null = null;
    @Input() status: GraphCanvasStatus = "ok";
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
    /** True for the schema visualiser surface (graphs schema type nodes, not
     *  data instances). Passed to the side panel so the type explorer hides
     *  instance-oriented UI (the "N in graph" count and connection chips). */
    @Input() schemaMode = false;
    @Input() snapshotMode = false;
    @Input() loadedSnap: GraphSnap | null = null;

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

    constructor(private styleService: GraphStyleService) {
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

    finderText = "";
    finderOpen = false;
    finderResults: GraphFinderEntry[] = [];
    private finderVisualiser: GraphVisualiser | null = null;
    private selectedEntries: GraphFinderEntry[] = [];
    private selectionRevision = -1;
    private selectionGraphOrder = -1;
    private finderGraphOrder = -1;

    get finderSelected(): GraphFinderEntry[] {
        const v = this.visualiser;
        if (!v) return [];
        if (this.selectionRevision !== v.elementSelection.revision || this.selectionGraphOrder !== v.graph.order) {
            const entries = v.finderEntries();
            const wholeTypes = entries.filter(entry => entry.id.startsWith("type:") && v.elementSelection.status(entry.nodes) === "all");
            const covered = new Set(wholeTypes.flatMap(entry => entry.nodes));
            this.selectedEntries = [...wholeTypes, ...entries.filter(entry => entry.id.startsWith("node:")
                && v.elementSelection.nodes.has(entry.nodes[0]) && !covered.has(entry.nodes[0]))];
            this.selectionRevision = v.elementSelection.revision;
            this.selectionGraphOrder = v.graph.order;
        }
        return this.selectedEntries;
    }

    finderStatus(entry: GraphFinderEntry): "none" | "partial" | "all" {
        return this.visualiser?.elementSelection.status(entry.nodes) ?? "none";
    }

    updateFinder(text: string): void {
        this.finderGraphOrder = this.visualiser?.graph.order ?? -1;
        this.selectionRevision = -1;
        this.finderText = text;
        this.finderOpen = true;
        this.finderResults = fuzzyGraphMatches(this.visualiser?.finderEntries() ?? [], text).slice(0, 60);
        this.applyFinder();
    }

    toggleFinder(entry: GraphFinderEntry): void {
        this.visualiser?.elementSelection.toggle(entry.nodes);
    }

    removeFinderSelection(entry: GraphFinderEntry): void {
        this.visualiser?.elementSelection.set(entry.nodes, false);
    }

    private applyFinder(): void {
        if (!this.visualiser) return;
        this.visualiser.finderMatches = !this.visualiser.elementSelection.active && this.finderText
            ? new Set(this.finderResults.flatMap(entry => entry.nodes)) : null;
        this.visualiser.sigma.refresh();
    }

    clearFinder(): void {
        this.finderText = ""; this.finderResults = []; this.finderOpen = false;
        if (this.visualiser) { this.visualiser.finderMatches = null; this.visualiser.elementSelection.clear(); }
    }

    focusFinder(): void {
        this.applyFinder();
        if (!this.visualiser?.elementSelection.active && this.visualiser?.finderMatches) {
            this.visualiser.elementSelection.replace([...this.visualiser.finderMatches]);
        }
        this.visualiser?.focusHighlightedNodes();
        this.finderOpen = false;
    }

    updateSearch(text: string): void {
        this.clearFinder();
        this.visualiser?.searchGraph(text.toLowerCase());
    }

    private libraryContextKey = "";
    private destroyed = false;
    ngDoCheck(): void {
        const key = JSON.stringify([this.snapshotDatabase, this.snapshotContext]);
        if (key !== this.libraryContextKey) {
            this.libraryContextKey = key;
            ++this.libraryRequest;
            this.snapLibrary = null;
            this.snapsBusy = false;
            setTimeout(() => this.refreshSnaps());
        }
        if (this.finderOpen && this.finderGraphOrder !== this.visualiser?.graph.order) this.updateFinder(this.finderText);
    }

    ngOnChanges() {
        if (this.finderVisualiser !== this.visualiser) {
            this.finderText = this.loadedSnap?.view.finderText ?? ""; this.finderResults = []; this.finderOpen = false;
            this.selectionRevision = -1; this.selectionGraphOrder = -1;
            this.finderVisualiser = this.visualiser;
        }
        if (this.selectionMode) this.visualiser?.interactionHandler.setSelectionMode(this.selectionMode);
    }

    ngAfterViewInit() {
        this.applyBackground();
    }

    ngAfterViewChecked() {
        const chip = this.snapChips?.nativeElement.querySelector<HTMLButtonElement>(".snap-chip.active");
        if (this.snapshotMode && this.snapshots.focusActiveChip && chip && !this.snapsBusy) {
            this.snapshots.focusActiveChip = false;
            setTimeout(() => { if (chip.isConnected) { chip.focus({ preventScroll: true }); chip.scrollIntoView({ block: "nearest" }); } });
        }
        const el = this.canvasElRef?.nativeElement ?? null;
        if (el && el !== this.attachedCanvasEl && this.attachedCanvasEl !== null) {
            // The host element was rebuilt (dock axis changed). Re-home the
            // renderer onto the new node.
            this.attachedCanvasEl = el;
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
        this.destroyed = true;
        ++this.libraryRequest;
        this.stylesSub.unsubscribe();
    }

    private applyBackground() {
        const el = this.canvasElRef?.nativeElement;
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
        return graphExportBaseName(this.run?.query || this.loadedSnap?.query || "", known, fallback);
    }

    snapsBusy = false;
    snapsError = "";
    projectPath = "";
    snapLibrary: GraphSnapLibrary | null = null;
    private libraryRequest = 0;

    get snapshotDatabase(): string {
        return this.run?.graph.database ?? this.loadedSnap?.database ?? this.driver.database$.value?.name ?? "";
    }

    private get snapshotContext(): GraphSnapshotContext | undefined {
        return this.run?.snapshotContext ?? this.loadedSnap?.project ?? this.snapshots.forDatabase(this.snapshotDatabase);
    }

    private useSnapshotContext(context: GraphSnapshotContext): void {
        this.snapshots.remember(context.database, context.projectTempDirectory);
        if (this.run) this.run.snapshotContext = context;
        if (this.loadedSnap) this.loadedSnap.project = context;
        this.libraryContextKey = JSON.stringify([this.snapshotDatabase, this.snapshotContext]);
    }

    @ViewChild("snapChips") snapChips?: ElementRef<HTMLElement>;

    get snapGroups(): { kind: string; label: string; files: SavedGraphSnap[] }[] {
        return [{ kind: "data", label: "Data" }, { kind: "schema", label: "Schema" }, { kind: "unknown", label: "Other" }]
            .map(group => ({ ...group, files: this.snapLibrary?.files.filter(file => (file.kind ?? "unknown") === group.kind) ?? [] }))
            .filter(group => group.files.length > 0);
    }

    snapName(filename: string): string { return filename.replace(/-\d+\.snap\.json$/, "").replace(/\.snap\.json$/, ""); }
    snapNumber(filename: string): string { return filename.match(/-(\d+)\.snap\.json$/)?.[1] ?? "·"; }

    isActiveSnap(filename: string): boolean {
        const active = this.snapshots.activeFile;
        return !!this.loadedSnap && active?.filename === filename && active.database === this.snapshotDatabase
            && active.projectTempDirectory === this.snapLibrary?.projectTempDirectory;
    }

    navigateSnaps(event: KeyboardEvent): void {
        if (!["h", "l"].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey
            || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.snapsBusy) return;
        const files = this.snapGroups.flatMap(group => group.files);
        if (!files.length) return;
        const current = files.findIndex(file => this.isActiveSnap(file.filename));
        const next = current < 0 ? (event.key === "l" ? 0 : files.length - 1)
            : (current + (event.key === "l" ? 1 : -1) + files.length) % files.length;
        void this.openSavedSnap(files[next].filename);
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

    async openSavedSnap(filename: string): Promise<void> {
        if (!this.snapLibrary || this.snapsBusy) return;
        const { database, projectTempDirectory } = this.snapLibrary;
        this.snapsBusy = true;
        try {
            await this.snapshots.openSaved({ database, projectTempDirectory }, filename);
            await this.router.navigate(["/snap"]);
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
            const snap = visualiser.captureSnap(this.run?.query || this.run?.graph.query || this.loadedSnap?.query || "", this.schemaMode,
                this.run?.expansionQueries ?? this.loadedSnap?.expansionQueries ?? []);
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
        try { await this.snapshots.open(file); await this.router.navigate(["/snap"]); }
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
