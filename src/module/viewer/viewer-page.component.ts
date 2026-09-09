import { AfterViewInit, Component, NgZone, OnDestroy, OnInit, ViewChild } from "@angular/core";
import { AsyncPipe } from "@angular/common";
import { RouterLink } from "@angular/router";
import { Subscription } from "rxjs";
import { isApiErrorResponse } from "@typedb/driver-http";
import { GraphCanvasComponent } from "../../framework/graph-visualiser/canvas/graph-canvas.component";
import { DriverState } from "../../service/driver-state.service";
import { GraphStyleService } from "../../service/graph-style.service";
import { GraphOutputState } from "../../service/query-page-state.service";

interface ViewerRequest {
    id: string;
    query: string;
    database?: string;
    limit: number;
}

@Component({
    selector: "ts-viewer-page",
    templateUrl: "./viewer-page.component.html",
    styleUrls: ["./viewer-page.component.scss"],
    imports: [GraphCanvasComponent, AsyncPipe, RouterLink],
})
export class ViewerPageComponent implements OnInit, AfterViewInit, OnDestroy {
    @ViewChild(GraphCanvasComponent) canvas!: GraphCanvasComponent;
    graph: GraphOutputState;
    message = "Send a query from Neovim to show its graph.";
    error = "";
    running = false;
    bridgeConnected = false;
    connected = false;
    lastRequest: ViewerRequest | null = null;
    private events?: EventSource;
    private connectionSub?: Subscription;
    private querySub?: Subscription;
    private pending = false;
    private generation = 0;

    constructor(public driver: DriverState, private styles: GraphStyleService, private zone: NgZone) {
        this.graph = new GraphOutputState(styles);
    }

    ngOnInit(): void {
        this.connectionSub = this.driver.status$.subscribe(status => {
            this.connected = status === "connected";
            this.tryRun();
        });
    }

    ngAfterViewInit(): void {
        this.graph.attach(this.canvas.canvasEl!);
        this.events = new EventSource("/api/viewer/events");
        this.events.onopen = () => this.zone.run(() => { this.bridgeConnected = true; });
        this.events.onerror = () => this.zone.run(() => { this.bridgeConnected = false; });
        this.events.addEventListener("query", event => this.zone.run(() => {
            const request = JSON.parse((event as MessageEvent<string>).data) as ViewerRequest;
            // The bridge replays its latest request on every subscription/reconnection.
            if (request.id === this.lastRequest?.id) return;
            this.generation++;
            this.querySub?.unsubscribe();
            this.running = false;
            this.error = "";
            this.lastRequest = request;
            this.pending = true;
            this.tryRun();
        }));
    }

    selectDatabase(name: string): void {
        if (name) this.driver.selectDatabase({ name });
        this.tryRun();
    }

    retry(): void {
        this.pending = !!this.lastRequest;
        this.tryRun();
    }

    private tryRun(): void {
        const request = this.lastRequest;
        if (!request || !this.pending || this.running) return;
        if (!this.connected) {
            this.message = "Query received. Connect to TypeDB to run it.";
            return;
        }
        const database = request.database || this.driver.database$.value?.name;
        if (!database) {
            this.message = "Query received. Choose a database to run it.";
            return;
        }
        this.pending = false;
        this.running = true;
        this.error = "";
        this.message = `Running query in ${database}…`;
        const generation = ++this.generation;
        this.querySub?.unsubscribe();
        this.querySub = this.driver.queryReadOnly(request.query, database, { answerCountLimit: request.limit }).subscribe({
            next: response => {
                if (generation !== this.generation) return;
                this.running = false;
                if (isApiErrorResponse(response)) {
                    this.showError(response.err.message);
                    return;
                }
                if (response.ok.answerType !== "conceptRows" || !response.ok.query) {
                    this.showError("This result cannot be graphed. Use a match query returning concept rows, without fetch.");
                    return;
                }
                // Keep the old graph throughout query execution. Replace it only when
                // a graphable result arrives; the page and event connection stay mounted.
                this.graph.destroy();
                this.graph = new GraphOutputState(this.styles);
                this.graph.query = request.query;
                this.graph.database = database;
                this.graph.attach(this.canvas.canvasEl!);
                try {
                    this.graph.push(response);
                    const count = response.ok.answers.length;
                    this.message = `${database} · ${count} rows${count >= request.limit ? ` (limit ${request.limit})` : ""}`;
                } catch (error) {
                    this.showError(error instanceof Error ? error.message : String(error));
                }
            },
            error: error => {
                if (generation !== this.generation) return;
                this.running = false;
                this.showError(isApiErrorResponse(error) ? error.err.message : error?.message ?? String(error));
            },
        });
    }

    private showError(message: string): void {
        this.error = message;
        this.message = "Query failed. Send another query or retry.";
    }

    reattach(element: HTMLElement): void {
        this.graph.detach();
        this.graph.attach(element);
    }

    ngOnDestroy(): void {
        this.generation++;
        this.events?.close();
        this.connectionSub?.unsubscribe();
        this.querySub?.unsubscribe();
        this.graph.destroy();
    }
}
