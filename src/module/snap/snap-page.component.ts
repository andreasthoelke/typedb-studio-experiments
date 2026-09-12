import { AfterViewInit, ChangeDetectorRef, Component, inject, OnDestroy, ViewChild } from "@angular/core";
import { Router } from "@angular/router";
import { firstValueFrom, Subscription } from "rxjs";
import { GraphCanvasComponent } from "../../framework/graph-visualiser/canvas/graph-canvas.component";
import { GraphVisualiser } from "../../framework/graph-visualiser/engine";
import { newGraph } from "../../framework/graph-visualiser/engine/graph";
import { Layouts } from "../../framework/graph-visualiser/engine/layout";
import { createSigmaRenderer, defaultSigmaSettings } from "../../framework/graph-visualiser/engine/sigma-settings";
import { GraphSnap } from "../../framework/util/graph-snap";
import { GraphSnapshotService } from "../../service/graph-snapshot.service";
import { GraphStyleService } from "../../service/graph-style.service";
import { DriverState } from "../../service/driver-state.service";
import { SnackbarService } from "../../service/snackbar.service";
import { QueryTabsState } from "../../service/query-tabs-state.service";

@Component({
    selector: "ts-snap-page",
    imports: [GraphCanvasComponent],
    providers: [GraphStyleService],
    template: `
      <div class="snap-header">
        <span>{{ snap ? 'Saved view · ' + (snap.database || 'graph') + ' · ' + snap.createdAt : 'Open a graph snap using the folder button' }}</span>
        @if (snap) {
          <button (click)="showQuery = !showQuery">{{ showQuery ? 'Hide query' : 'Query and expansions' }}</button>
          <button (click)="openQuery()" [disabled]="!snap.query">Open query in Studio</button>
        }
      </div>
      @if (snap && showQuery) {
        <div class="snap-query">
          <p>Captured query. Explorer expansions are already included in the saved graph.</p>
          <pre>{{ snap.query || 'Full schema view (no explicit query).' }}</pre>
          @for (query of snap.expansionQueries; track $index) { <pre>{{ query }}</pre> }
        </div>
      }
      <ts-graph-canvas #canvas [visualiser]="visualiser" [status]="visualiser ? 'ok' : 'emptySnap'"
        [snapshotMode]="true" [loadedSnap]="snap" [schemaMode]="snap?.schemaMode ?? false"
        [parentManagesCanvas]="true" (canvasElRebuilt)="rehome($event)"/>
    `,
    styleUrls: ["snap-page.component.scss"],
})
export class SnapPageComponent implements AfterViewInit, OnDestroy {
    @ViewChild("canvas") canvas!: GraphCanvasComponent;
    private snapshots = inject(GraphSnapshotService);
    private styles = inject(GraphStyleService);
    private tabs = inject(QueryTabsState);
    private router = inject(Router);
    private driver = inject(DriverState);
    private snackbar = inject(SnackbarService);
    private cdr = inject(ChangeDetectorRef);
    private ready = false;
    private destroyed = false;
    snap: GraphSnap | null = null;
    visualiser: GraphVisualiser | null = null;
    showQuery = false;
    private subscription: Subscription = this.snapshots.opened$.subscribe(snap => {
        this.snap = snap;
        if (snap && this.ready) this.restore(snap);
    });

    ngAfterViewInit(): void {
        this.ready = true;
        setTimeout(() => { if (!this.destroyed && this.snap) this.restore(this.snap); });
    }

    private restore(snap: GraphSnap, container = this.canvas.canvasElRef?.nativeElement): void {
        if (!container) return;
        this.visualiser?.destroy();
        this.styles.applyCapturedPreset(snap.style);
        const graph = newGraph();
        graph.import(snap.graph);
        const sigma = createSigmaRenderer(container, defaultSigmaSettings as any, graph);
        this.visualiser = new GraphVisualiser(graph, sigma, Layouts.createD3ForceSupervisor(graph), this.styles);
        // Preserve captured labels and resolved colours, including off-graph values.
        for (const node of snap.graph.nodes) graph.replaceNodeAttributes(node.key, structuredClone(node.attributes!));
        for (const edge of snap.graph.edges) graph.replaceEdgeAttributes(edge.key!, structuredClone(edge.attributes!));
        this.visualiser.restoreSnapView(snap);
        this.cdr.detectChanges();
    }

    rehome(container: HTMLElement): void {
        if (!this.visualiser || !this.snap) return;
        const current = this.visualiser.captureSnap(this.snap.query, this.snap.schemaMode, this.snap.expansionQueries);
        this.restore(current, container);
    }

    async openQuery(): Promise<void> {
        if (!this.snap?.query) return;
        const database = this.snap.database;
        if (database && this.driver.database$.value?.name !== database) {
            if (this.driver.transactionOpen) {
                this.snackbar.warn("Close the current transaction before opening a query for another database.");
                return;
            }
            if ((await firstValueFrom(this.driver.databaseList$))?.some(db => db.name === database)) this.driver.selectDatabase({ name: database });
            else this.snackbar.info(`Choose database '${database}' before running this saved query.`);
        }
        const tab = this.tabs.newTab();
        tab.name = `Snap · ${this.snap.database || 'graph'}`;
        tab.pinned = true;
        this.tabs.getTabControl(tab).setValue(this.snap.query);
        await this.router.navigate(["/query"], { queryParams: { nvim: 0 } });
    }

    ngOnDestroy(): void {
        this.destroyed = true;
        this.subscription.unsubscribe();
        this.visualiser?.destroy();
    }
}
