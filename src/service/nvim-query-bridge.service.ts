import { Injectable, NgZone } from "@angular/core";
import { combineLatest, Subscription } from "rxjs";
import { DriverState } from "./driver-state.service";
import { QueryPageState } from "./query-page-state.service";
import { QueryTabsState } from "./query-tabs-state.service";
import { SchemaState } from "./schema-state.service";
import { SnackbarService } from "./snackbar.service";
import { prepareOperationContext, prepareSchemaContext, EditorExecution, OperationContext } from "../framework/util/operation-context";
import { prepareGraphQuery } from "../framework/util/graph-query";

interface EditorRequest { id: string; query: string; database?: string; limit: number; execution?: EditorExecution; projectTempDirectory?: string; }
const OPTIONS_KEY = "typedb-studio-nvim-options";
const ENABLED_KEY = "typedb-studio-nvim-enabled";

@Injectable({ providedIn: "root" })
export class NvimQueryBridge {
    enabled = false;
    connected = false;
    message = "Waiting for a query from Neovim.";
    note = "";
    neighbours = true;
    seedVariable = "";
    relationTypes = "";
    lastRequest: EditorRequest | null = null;
    private pending = false;
    private refreshedRequest?: string;
    get operationContext(): boolean {
        return !!this.lastRequest?.execution && (this.lastRequest.execution.kind !== "read" || this.lastRequest.execution.status === "error");
    }
    get outcome(): string {
        const execution = this.lastRequest?.execution;
        return !execution ? "" : execution.status === "error" ? "Neovim statement failed. Showing context from existing data/schema."
            : execution.kind === "read" ? "" : "Neovim committed the statement. Showing current context.";
    }
    private events?: EventSource;
    private subscriptions?: Subscription;
    private scheduled = false;
    private databaseNames: string[] = [];
    private driverConnected = false;
    private busy = false;
    private reapplyTimer?: ReturnType<typeof setTimeout>;

    constructor(private driver: DriverState, private state: QueryPageState, private tabs: QueryTabsState,
        private schema: SchemaState, private zone: NgZone, private snackbar: SnackbarService) {
        try {
            this.enabled = sessionStorage.getItem(ENABLED_KEY) === "1";
            const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
            if (saved) {
                this.neighbours = saved.neighbours !== false;
                this.seedVariable = typeof saved.seedVariable === "string" ? saved.seedVariable : "";
                this.relationTypes = typeof saved.relationTypes === "string" ? saved.relationTypes : "";
            }
        } catch { /* Storage is optional. */ }
    }

    attach(parameter: string | null): void {
        this.detach();
        this.enabled = ["localhost", "127.0.0.1"].includes(location.hostname)
            && (parameter === "1" || (parameter !== "0" && this.enabled));
        try { sessionStorage.setItem(ENABLED_KEY, this.enabled ? "1" : "0"); } catch { /* Optional. */ }
        if (!this.enabled) return;
        this.subscriptions = combineLatest([
            this.driver.status$, this.driver.databaseList$, this.driver.database$,
            this.driver.transaction$, this.schema.value$, this.state.queryRunning$,
        ]).subscribe(([status, databases, , , , busy]) => {
            this.driverConnected = status === "connected";
            this.databaseNames = databases?.map(db => db.name) ?? [];
            this.busy = busy;
            this.schedule();
        });
        this.events = new EventSource("/api/viewer/events");
        this.events.onopen = () => this.zone.run(() => { this.connected = true; });
        this.events.onerror = () => this.zone.run(() => { this.connected = false; });
        this.events.addEventListener("query", event => this.zone.run(() => {
            const request = JSON.parse((event as MessageEvent<string>).data) as EditorRequest;
            if (request.id === this.lastRequest?.id) return;
            this.lastRequest = request;
            this.pending = true;
            this.schedule();
        }));
    }

    private saveOptions(): void {
        try {
            localStorage.setItem(OPTIONS_KEY, JSON.stringify({ neighbours: this.neighbours,
                seedVariable: this.seedVariable, relationTypes: this.relationTypes }));
        } catch { /* Optional. */ }
    }

    scheduleReapply(): void {
        this.saveOptions();
        clearTimeout(this.reapplyTimer);
        // Combine a quick sequence of checkbox/seed edits into one graph query.
        this.reapplyTimer = setTimeout(() => {
            this.reapplyTimer = undefined;
            this.reapply();
        }, 250);
    }

    reapply(): void {
        clearTimeout(this.reapplyTimer);
        this.reapplyTimer = undefined;
        this.saveOptions();
        this.pending = !!this.lastRequest;
        this.schedule();
    }

    detach(): void {
        clearTimeout(this.reapplyTimer);
        this.reapplyTimer = undefined;
        this.events?.close();
        this.events = undefined;
        this.connected = false;
        this.subscriptions?.unsubscribe();
    }

    private schedule(): void {
        if (this.scheduled) return;
        this.scheduled = true;
        // Let tab changes, connection setup, and schema refresh finish this view check.
        queueMicrotask(() => this.zone.run(() => {
            this.scheduled = false;
            if (this.events) this.drain();
        }));
    }

    private drain(): void {
        const request = this.lastRequest;
        if (!this.pending || !request) return;
        if (!this.driverConnected) { this.message = "Query received. Connect to TypeDB to run it."; return; }
        if (this.busy) { this.message = "Latest Neovim query queued until the current run finishes."; return; }
        const database = request.database ?? this.driver.database$.value?.name;
        if (!database) { this.message = "Query received. Choose a database."; return; }
        if (!this.databaseNames.includes(database)) {
            this.pending = false;
            this.message = `Database '${database}' is not available on this connection.`;
            this.snackbar.errorPersistent(this.message);
            return;
        }
        if (database !== this.driver.database$.value?.name) {
            if (this.driver.transactionOpen) {
                this.message = `Close the current Studio transaction before switching to '${database}'.`;
                return;
            }
            this.driver.selectDatabase({ name: database });
            this.schedule();
            return;
        }
        if (this.operationContext && this.driver.transactionOpen) {
            this.message = "Close the Studio transaction to load current context for the completed Neovim statement.";
            return;
        }
        if (this.operationContext && this.refreshedRequest !== request.id) {
            if (this.schema.isRefreshing) { setTimeout(() => this.schedule(), 100); return; }
            this.refreshedRequest = request.id;
            this.schema.refresh();
        }
        if ((this.neighbours || this.operationContext) && this.schema.isRefreshing) {
            this.message = "Loading the schema for graph context…";
            setTimeout(() => this.schedule(), 100);
            return;
        }
        this.pending = false;
        try {
            const schema = this.schema.value$.value;
            const options = {
                neighbours: this.neighbours, seedVariable: this.seedVariable,
                relationTypes: this.relationTypes.split(",").map(label => label.trim()).filter(Boolean),
            };
            if (this.operationContext && !schema) throw new Error("Could not load the current schema for operation context.");
            const prepared = this.operationContext
                ? prepareOperationContext(request.query, request.execution!, options, schema!)
                : { ...prepareGraphQuery(request.query, options,
                    label => schema?.entities[label] ?? schema?.relations[label] ?? schema?.attributes[label]), schemaMode: false };
            this.note = prepared.note;
            // Reuse the latest unpinned tab; pinned queries are kept as saved references.
            const tabs = this.tabs.openTabs$.value;
            let index = tabs.length - 1;
            while (index >= 0 && tabs[index].pinned) index--;
            if (index < 0) this.tabs.newTab();
            else this.tabs.selectTab(index);
            const show = (context: OperationContext, fallback = false) => {
                this.tabs.getTabControl(this.tabs.currentTab!).setValue(context.query);
                this.state.outputTypeControl.setValue("graph");
                this.note = context.note;
                this.message = `Running Neovim context in ${database}…`;
                this.state.runQuery(context.query, { limit: request.limit, schemaMode: context.schemaMode, projectTempDirectory: request.projectTempDirectory }).subscribe(result => {
                    if (this.lastRequest !== request) return;
                    const empty = ["noQueryAnswers", "noInstancesFound"].includes(this.state.graphOutput.status);
                    if (this.operationContext && !context.schemaMode && !fallback && (!result.success || empty) && !this.pending) {
                        try {
                            const schemaContext = prepareSchemaContext(request.query, options, schema!);
                            queueMicrotask(() => {
                                if (this.lastRequest === request && !this.pending) show({ ...schemaContext,
                                    note: `No matching data context was available. ${schemaContext.note}` }, true);
                            });
                            return;
                        } catch { /* No surviving type: keep the empty/error result and explanation. */ }
                    }
                    this.message = result.success ? `Updated ${database} from Neovim. ${this.outcome}`.trim()
                        : `Context query failed; see Studio's log. ${this.outcome}`.trim();
                });
            };
            show(prepared);

        } catch (error) {
            this.message = error instanceof Error ? error.message : String(error);
            this.snackbar.warnPersistent(this.message);
        }
    }
}
