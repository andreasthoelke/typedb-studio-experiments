/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AsyncPipe } from "@angular/common";
import { AfterViewInit, ChangeDetectorRef, Component, DestroyRef, ElementRef, OnDestroy, OnInit, QueryList, ViewChild, ViewChildren } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormsModule, ReactiveFormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatButtonToggleModule } from "@angular/material/button-toggle";
import { MatDialog } from "@angular/material/dialog";
import { MatDividerModule } from "@angular/material/divider";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatSortModule } from "@angular/material/sort";
import { MatTooltipModule } from "@angular/material/tooltip";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { ResizableDirective } from "@hhangular/resizable";
import { distinctUntilChanged, filter, map, Observable, startWith } from "rxjs";
import { AppData } from "../../service/app-data.service";
import { DriverState } from "../../service/driver-state.service";
import { SchemaState } from "../../service/schema-state.service";
import { DatabaseCreateDialogComponent } from "../database/create-dialog/database-create-dialog.component";
import { DatabaseSelectDialogComponent } from "../database/select-dialog/database-select-dialog.component";
import { PageScaffoldComponent } from "../scaffold/page/page-scaffold.component";
import { SchemaToolWindowComponent } from "./tool-window/schema-tool-window.component";
import { NvimQueryBridge, EditorRequest } from "../../service/nvim-query-bridge.service";
import { GraphSnap } from "../../framework/util/graph-snap";
import { GraphSnapshotService } from "../../service/graph-snapshot.service";
import { Schema } from "../../service/schema-state.service";
import { GraphVisualiser } from "../../framework/graph-visualiser/engine";
import { schemaFocus } from "../../framework/util/schema-focus";
import { GraphCanvasComponent } from "../../framework/graph-visualiser/canvas/graph-canvas.component";
import { PaneDirective } from "../../framework/pane-focus/pane.directive";

@Component({
    selector: "ts-schema-page",
    templateUrl: "schema-page.component.html",
    styleUrls: ["schema-page.component.scss"],
    imports: [
        RouterLink, AsyncPipe, PageScaffoldComponent, MatDividerModule, MatFormFieldModule,
        MatInputModule, FormsModule, ReactiveFormsModule, MatButtonToggleModule,
        MatSortModule, MatTooltipModule, MatButtonModule, ResizableDirective, SchemaToolWindowComponent,
        GraphCanvasComponent, PaneDirective,
    ]
})
export class SchemaPageComponent implements OnInit, AfterViewInit, OnDestroy {

    @ViewChild("articleRef") articleRef!: ElementRef<HTMLElement>;
    @ViewChildren(GraphCanvasComponent) graphCanvasComponents!: QueryList<GraphCanvasComponent>;
    @ViewChildren(ResizableDirective) resizables!: QueryList<ResizableDirective>;
    private canvasEl$!: Observable<HTMLElement>;

    private static readonly DEFAULT_PANEL_SIZES = [20, 80, 75, 25];
    panelSizes = [...SchemaPageComponent.DEFAULT_PANEL_SIZES];
    graphMaximised = false;
    contextQuery = "";
    restoredSnap: GraphSnap | null = null;
    restoreSavedView = (snap: GraphSnap): void => {
        if (this.state.isRefreshing || !this.state.value$.value) throw new Error("Wait for the database schema to load before exploring a snap.");
        if (snap.database !== this.driver.database$.value?.name) throw new Error(`Select database '${snap.database}' to explore this snap.`);
        if (this.driver.transactionOpen) throw new Error("Close the current transaction before exploring a snap.");
        cancelAnimationFrame(this.focusFrame);
        this.state.visualiser.restoreSnapshot(snap);
        this.restoredSnap = snap;
        this.contextQuery = snap.query;
        this.cdr.detectChanges();
    };
    private focusFrame = 0;
    readonly localViewer = ["localhost", "127.0.0.1"].includes(location.hostname);

    toggleNvim(): void {
        void this.router.navigate([], { relativeTo: this.route, queryParams: { nvim: this.bridge.enabled ? "0" : "1" }, queryParamsHandling: "merge" });
    }

    private focusEditorSchema = (request: EditorRequest, schema: Schema): boolean => {
        if (this.restoredSnap) {
            this.restoredSnap = null;
            this.state.refresh();
            return false;
        }
        const visualiser = this.state.visualiser.visualiser;
        const canvas = this.graphCanvasComponents?.first;
        if (!visualiser || !canvas) return false;
        const focus = schemaFocus(request.query, schema);
        if (!focus.seeds.length) {
            this.bridge.message = "No explicit type names from this statement exist in the current schema; the previous view is kept.";
            return true;
        }
        // A new source returns to the stable full schema after a local working subset.
        visualiser.restoreContext();
        const keys = visualiser.graph.nodes().filter(key => {
            const concept = visualiser.graph.getNodeAttribute(key, "metadata").concept;
            return "label" in concept && focus.labels.has(concept.label);
        });
        if (!keys.length) return false;
        if (request.projectTempDirectory) this.snapshots.remember(this.state.visualiser.database!, request.projectTempDirectory);
        this.contextQuery = request.query;
        canvas.closeInlineSnap();
        visualiser.interactionHandler.clearSelection();
        visualiser.elementSelection.replace(keys);
        this.frameSchemaFocus(visualiser, canvas);
        this.bridge.message = `Schema context for ${focus.seeds.join(", ")} in ${this.state.visualiser.database}.`;
        this.cdr.detectChanges();
        return true;
    };

    private frameSchemaFocus(visualiser: GraphVisualiser, canvas: GraphCanvasComponent): void {
        cancelAnimationFrame(this.focusFrame);
        const revision = visualiser.elementSelection.revision;
        let frames = 0;
        const focus = () => {
            this.focusFrame = 0;
            if (!this.bridge.enabled || visualiser !== this.state.visualiser.visualiser || canvas.inlineSnap ||
                visualiser.elementSelection.revision !== revision || visualiser.interactionHandler.state.selectedNode != null) return;
            // A newly loaded schema starts at random positions. Give its existing
            // layout visible frames before freezing/framing it. Background tabs
            // naturally defer rAF until they can render, rather than freezing unseen.
            if (visualiser.layout.isRunning && ++frames < 60) {
                this.focusFrame = requestAnimationFrame(focus);
                return;
            }
            visualiser.focusHighlightedNodes();
        };
        this.focusFrame = requestAnimationFrame(focus);
    }

    constructor(
        protected state: SchemaState, public driver: DriverState, private appData: AppData,
        private destroyRef: DestroyRef, private dialog: MatDialog, private cdr: ChangeDetectorRef,
        private router: Router, private route: ActivatedRoute, public bridge: NvimQueryBridge, private snapshots: GraphSnapshotService) {
    }

    onGraphCanvasRebuilt(el: HTMLElement): void {
        this.state.visualiser.destroy();
        this.state.visualiser.canvasEl$.next(el);
    }

    onGraphStatusAction(action: string) {
        if (action === "viewLog") this.router.navigate(["/history"]);
    }

    openSelectDatabaseDialog() {
        this.dialog.open(DatabaseSelectDialogComponent);
    }

    openCreateDatabaseDialog() {
        this.dialog.open(DatabaseCreateDialogComponent);
    }

    ngOnInit() {
        this.appData.viewState.setLastUsedTool("schema");
        this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
            this.bridge.attach(params.get("nvim"), this.focusEditorSchema, () => {
                const canvas = this.graphCanvasComponents?.first;
                return canvas?.snapshotDatabase === this.driver.database$.value?.name ? canvas?.visualiser : null;
            }, command => this.graphCanvasComponents?.first?.runViewerCommand(command) ?? Promise.resolve(false));
        });
        this.driver.database$.pipe(map(db => db?.name), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
            .subscribe(() => { this.contextQuery = ""; this.restoredSnap = null; });
        const saved = this.appData.panelLayout.get("schema");
        if (saved && saved.length === SchemaPageComponent.DEFAULT_PANEL_SIZES.length) {
            this.panelSizes = saved;
        }
    }

    onPanelResize(index: number, percent: number) {
        this.panelSizes[index] = percent;
        this.appData.panelLayout.set("schema", [...this.panelSizes]);
    }

    ngAfterViewInit() {
        if (!this.appData.panelLayout.get("schema") && this.resizables.length) {
            const articleWidth = this.articleRef.nativeElement.clientWidth;
            this.resizables.first.percent = (articleWidth * 0.15 + 100) / articleWidth * 100;
        }

        this.canvasEl$ = this.graphCanvasComponents.changes.pipe(
            map(x => x as QueryList<GraphCanvasComponent>),
            startWith(this.graphCanvasComponents),
            filter(queryList => queryList.length > 0 && !!queryList.first.canvasEl),
            map(x => x.first.canvasEl!),
        );
        this.canvasEl$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(canvasEl => {
            this.state.visualiser.canvasEl$.next(canvasEl);
            if (this.state.visualiser.visualiser?.graph.nodes().length) {
                this.state.visualiser.visualiser.sigma.scheduleRender();
            }
        });
        this.state.queryResponses$.pipe(
            takeUntilDestroyed(this.destroyRef),
            filter(x => !!x),
            map(x => x!)
        ).subscribe((queryResponses) => {
            this.restoredSnap = null;
            if (!this.state.visualiser.visualiser) {
                queryResponses.forEach(x => this.state.visualiser.push(x));
            }
            this.cdr.detectChanges();
        });
    }

    ngOnDestroy() {
        cancelAnimationFrame(this.focusFrame);
        this.bridge.detach();
        this.state.visualiser.destroy();
    }

    readonly JSON = JSON;
}
