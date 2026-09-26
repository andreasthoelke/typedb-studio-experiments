import type { GraphSource } from "../framework/util/graph-source";
import { Injectable, NgZone } from "@angular/core";
import { combineLatest, firstValueFrom, Subscription } from "rxjs";
import { ApiResponse, QueryResponse, isApiErrorResponse } from "@typedb/driver-http";
import type { GraphVisualiser } from "../framework/graph-visualiser/engine";
import { editorCaretTarget, editorIllustrationQuery, type EditorCaretRequest } from "../framework/util/editor-caret";
import type { GraphViewCommand } from "../framework/util/graph-shortcuts";
import type { RunOutputState } from "./query-page-state.service";
import { GraphSnapshotService } from "./graph-snapshot.service";
import { DriverState } from "./driver-state.service";
import { QueryPageState } from "./query-page-state.service";
import { QueryTabsState } from "./query-tabs-state.service";
import { Schema, SchemaState } from "./schema-state.service";
import { SnackbarService } from "./snackbar.service";
import { prepareOperationContext, prepareSchemaContext, EditorExecution, OperationContext } from "../framework/util/operation-context";
import { prepareGraphQuery } from "../framework/util/graph-query";

export interface EditorRequest { id: string; query: string; database?: string; limit: number; execution?: EditorExecution; projectTempDirectory?: string;
    sourceLocation?: GraphSource; connectionOrigin?: string; response?: ApiResponse<QueryResponse>;
    graph?: { query: string; response: ApiResponse<QueryResponse>; schemaMode: boolean; source: "result" | "context"; note: string };
}
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
    private reapplying = false;
    private schemaFocus?: (request: EditorRequest, schema: Schema) => boolean;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private refreshedRequest?: string;
    get operationContext(): boolean {
        return !!this.lastRequest?.execution && (this.lastRequest.execution.kind !== "read" || this.lastRequest.execution.status === "error");
    }
    get outcome(): string {
        const execution = this.lastRequest?.execution;
        return !execution ? "" : execution.status === "unknown" ? "Statement outcome unknown; check current data before rerunning."
            : execution.status === "error" ? "Statement failed. Any displayed context is existing data/schema."
            : execution.kind === "read" ? "" : "Statement committed. Context reads, when present, show current state.";
    }
    private events?: EventSource;
    private subscriptions?: Subscription;
    private scheduled = false;
    private databaseNames: string[] = [];
    private driverConnected = false;
    private busy = false;
    private reapplyTimer?: ReturnType<typeof setTimeout>;
    private caretView?: () => GraphVisualiser | null | undefined;
    private caretRun?: () => RunOutputState | null;
    private viewerCommand?: (command: GraphViewCommand) => Promise<boolean>;
    private controls: { id: string; command: GraphViewCommand; database?: string; projectTempDirectory?: string }[] = [];
    private controlBusy = false;
    lastControlId?: string;
    private caretRequest: EditorCaretRequest | null = null;
    private caretGeneration = 0;
    private caretBusy = false;
    lastCaretRequest: EditorCaretRequest | null = null;
    caretMessage = "";

    constructor(private driver: DriverState, private state: QueryPageState, private tabs: QueryTabsState,
        private schema: SchemaState, private snapshots: GraphSnapshotService, private zone: NgZone, private snackbar: SnackbarService) {
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

    attach(parameter: string | null, schemaFocus?: (request: EditorRequest, schema: Schema) => boolean,
        caretView?: () => GraphVisualiser | null | undefined,
        viewerCommand?: (command: GraphViewCommand) => Promise<boolean>, caretRun?: () => RunOutputState | null): void {
        this.detach();
        this.schemaFocus = schemaFocus;
        this.caretView = caretView;
        this.viewerCommand = viewerCommand; this.caretRun = caretRun;
        // The SSE replay must reach the newly mounted route, even if another route
        // handled this request earlier in the same browser tab.
        this.lastRequest = null;
        this.pending = false;
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
        if (schemaFocus) this.subscriptions.add(this.snapshots.schemaContext$.subscribe(request => this.zone.run(() => {
            this.lastRequest = request;
            this.reapplying = false;
            this.pending = true;
            this.schedule();
        })));
        this.events = new EventSource("/api/viewer/events");
        this.events.onopen = () => this.zone.run(() => { this.connected = true; });
        this.events.onerror = () => this.zone.run(() => { this.connected = false; });
        this.events.addEventListener("query", event => this.zone.run(() => {
            const request = JSON.parse((event as MessageEvent<string>).data) as EditorRequest;
            if (request.id === this.lastRequest?.id) return;
            this.caretRequest = null; this.caretGeneration++;
            this.controls = [];
            this.lastRequest = request;
            this.reapplying = false;
            this.pending = true;
            this.schedule();
        }));
        this.events.addEventListener("caret", event => this.zone.run(() => {
            const request = JSON.parse((event as MessageEvent<string>).data) as EditorCaretRequest;
            if (request.id === this.lastCaretRequest?.id || (request.schemaOnly && !this.schemaFocus)) return;
            this.caretRequest = request;
            this.lastCaretRequest = request;
            this.caretGeneration++;
            this.schedule();
        }));
        this.events.addEventListener("control", event => this.zone.run(() => {
            const request = JSON.parse((event as MessageEvent<string>).data);
            if (request.id === this.lastControlId || this.controls.some(c => c.id === request.id)) return;
            this.controls.push(request); this.schedule();
        }));
    }

    /** Keep Query controls in sync with a restored result without scheduling execution. */
    useRestoredSource(query: string, database: string, projectTempDirectory?: string): void {
        clearTimeout(this.reapplyTimer);
        this.pending = false;
        this.lastRequest = { id: crypto.randomUUID(), query, database, projectTempDirectory, limit: 1000 };
        this.note = "Restored saved graph; Explorer additions read current database data.";
        this.message = `Exploring a restored snap in ${database}.`;
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
        if (!this.schemaFocus) this.saveOptions();
        this.reapplying = true;
        this.pending = !!this.lastRequest;
        this.schedule();
    }

    detach(): void {
        this.caretRequest = null; this.caretGeneration++;
        this.lastCaretRequest = null;
        this.controls = []; this.lastControlId = undefined;
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
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
            if (this.events) { this.drain(); void this.drainCaret(); void this.drainControls(); }
        }));
    }

    private retry(): void {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.schedule(), 100);
    }

    private async drainControls(): Promise<void> {
        if (this.controlBusy || !this.controls.length) return;
        if (this.pending || this.busy || this.caretBusy || this.caretRequest || this.schema.isRefreshing) { this.retry(); return; }
        const request = this.controls.shift()!;
        this.controlBusy = true;
        try {
            if (!this.driverConnected || !this.caretView?.() || (request.database && request.database !== this.driver.database$.value?.name)) {
                this.message = "Viewer command ignored: no graph on the matching database."; return;
            }
            if (request.projectTempDirectory) this.snapshots.remember(this.driver.database$.value!.name, request.projectTempDirectory);
            const done = await this.viewerCommand?.(request.command);
            this.message = done ? `Viewer: ${request.command}.` : `Viewer: ${request.command} needs an available graph/caret.`;
        } catch (error) {
            this.message = `Viewer command failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.lastControlId = request.id; this.controlBusy = false;
            if (this.controls.length) this.schedule();
        }
    }

    private async drainCaret(): Promise<void> {
        const request = this.caretRequest;
        if (!request || this.caretBusy) return;
        const report = (text: string, notice = false) => {
            this.caretMessage = text; this.message = text;
            if (notice && !request.schemaOnly) this.snackbar.info(text);
        };
        if (!this.driverConnected || (request.database && request.database !== this.driver.database$.value?.name)) {
            this.caretRequest = null;
            report("Caret jump ignored: this tab is not connected to the requested database."); return;
        }
        if (this.pending || this.busy || this.controlBusy || this.schema.isRefreshing) { this.retry(); return; }
        const schema = this.schema.value$.value, visualiser = this.caretView?.();
        if (!schema || !visualiser) {
            this.caretRequest = null; report("No graph is available for this caret jump.", true); return;
        }
        this.caretRequest = null;
        const target = editorCaretTarget(request, schema);
        if (!target) { report("No schema identifier at or to the right of the cursor on this line."); return; }
        const generation = this.caretGeneration, connection = this.driver.connection$.value, database = this.driver.database$.value!.name;
        const currentCaret = visualiser.navigation.caret;
        const stillCurrent = () => generation === this.caretGeneration && this.enabled && visualiser === this.caretView?.()
            && connection === this.driver.connection$.value && database === this.driver.database$.value?.name
            && currentCaret === visualiser.navigation.caret;
        let candidates = visualiser.graph.nodes().filter(key => !visualiser.graph.getNodeAttribute(key, "viewHidden"));
        try {
            if (this.schemaFocus) {
                candidates = candidates.filter(key => {
                    const concept = visualiser.graph.getNodeAttribute(key, "metadata").concept;
                    return "label" in concept && target.schemaLabels.includes(concept.label);
                });
            } else {
                if (!target.instance) { report("No instance binding could be resolved in this paragraph; the Query caret is unchanged."); return; }
                const run = this.caretRun?.();
                const schemaNodes = candidates.filter(key => {
                    const c = visualiser.graph.getNodeAttribute(key, "metadata").concept;
                    return "label" in c && target.schemaLabels.includes(c.label);
                });
                if (run?.graph.schemaMode) candidates = schemaNodes;
                else {
                    // Prefer the instances this paragraph matches; fall back to the
                    // focused type read when the whole pattern finds nothing (for
                    // example an insert paragraph that has not been committed).
                    // A schema clause (relates/plays/owns) is exact: no broader type fallback.
                    const queries = [...new Set([editorIllustrationQuery(target, schema, 20, true), target.clause ? null : editorIllustrationQuery(target, schema)]
                        .filter((q): q is string => !!q))];
                    if (!queries.length) { report("No supported, typed pattern could be resolved here; the graph is unchanged.", true); return; }
                    if (!run || run.graph.visualiser !== visualiser || run.graph.database !== database) {
                        report("Open an editable Query graph on this database to illustrate this pattern.", true); return;
                    }
                    this.caretBusy = true;
                    report(`Finding ${target.identifier}…`);
                    let query = queries[0];
                    let response: ApiResponse<QueryResponse> | null = null;
                    for (const [index, candidate] of queries.entries()) {
                        query = candidate;
                        response = await firstValueFrom(this.driver.queryReadOnly(candidate, database, { answerCountLimit: 20, includeQueryStructure: true }));
                        if (!stillCurrent() || this.caretRun?.() !== run || run.graph.destroyed) return;
                        const last = index === queries.length - 1;
                        if (isApiErrorResponse(response)) { if (last) throw new Error(response.err.message); continue; }
                        if (response.ok.answerType !== "conceptRows" || response.ok.answers.length || last) break;
                    }
                    if (!response || isApiErrorResponse(response) || response.ok.answerType !== "conceptRows") return;
                    const nodeKey = (concept: any) => concept && ["entity", "relation", "attribute"].includes(concept.kind)
                        ? visualiser.instanceNodeKey(concept.kind, concept.type.label, concept.kind === "attribute" ? String(concept.value) : concept.iid) : null;
                    // Respect deliberate hiding. Missing concepts may be added, but
                    // an explicitly hidden target does not bring its neighbourhood back.
                    const rows = response.ok.answers.filter(row => {
                        const key = nodeKey(row.data["focus"]);
                        return !key || !visualiser.graph.getNodeAttribute(key, "viewHidden");
                    });
                    if (rows.length) {
                        const previous = new Set(visualiser.graph.nodes());
                        const previousEdges = visualiser.graph.size;
                        visualiser.stopLayout(); visualiser.freezeViewport();
                        run.graph.pushIllustration({ ok: { ...response.ok, answers: rows } });
                        visualiser.placeIllustrationNodes(previous);
                        if ((visualiser.graph.order > previous.size || visualiser.graph.size > previousEdges) && !run.expansionQueries?.includes(query)) (run.expansionQueries ??= []).push(query);
                    }
                    candidates = [...new Set(rows.map(row => nodeKey(row.data["focus"])).filter((key): key is string => key != null))];
                }
            }
            if (!stillCurrent()) return;
            candidates = candidates.filter(key => visualiser.graph.hasNode(key) && !visualiser.graph.getNodeAttribute(key, "viewHidden"));
            if (!candidates.length) { report(`No visible match for ${target.identifier} in this ${this.schemaFocus ? "Schema" : "Query"} graph.`, true); return; }
            const { width, height } = visualiser.sigma.getDimensions();
            const distance = (key: string) => { const p = visualiser.sigma.graphToViewport(visualiser.graph.getNodeAttributes(key)); return Math.hypot(p.x - width / 2, p.y - height / 2); };
            candidates.sort((a, b) => Number(b === currentCaret) - Number(a === currentCaret) || distance(a) - distance(b) || a.localeCompare(b));
            // Every match is marked; the nearest/current one takes the primary caret.
            visualiser.pointCarets(candidates, candidates[0]);
            report(`Caret: ${target.identifier}${candidates.length > 1 ? ` (${candidates.length} matches; the others are marked)` : ""}.`);
        } catch (error) {
            if (stillCurrent()) report(`Could not resolve ${target.identifier}: ${error instanceof Error ? error.message : String(error)}`, true);
        } finally {
            this.caretBusy = false;
            if (this.caretRequest) this.schedule();
        }
    }

    private drain(): void {
        const request = this.lastRequest;
        if (!this.pending || !request) return;
        if (!this.driverConnected) { this.message = request.response
            ? "Completed result received. Connect to its TypeDB server to display it."
            : "Query received. Connect to TypeDB to run it."; return; }
        if (request.connectionOrigin) {
            const params = this.driver.connection$.value?.params;
            const addresses = params && ("addresses" in params ? params.addresses : params.translatedAddresses.map(a => a.external));
            const normalise = (address: string) => {
                try { const url = new URL(address); if (url.hostname === "127.0.0.1") url.hostname = "localhost"; return url.origin; }
                catch { return address; }
            };
            if (!addresses?.some(address => normalise(address) === normalise(request.connectionOrigin!))) {
                this.message = `Connect Studio to ${request.connectionOrigin} to view this completed result.`;
                return;
            }
        }
        if (this.busy && !this.schemaFocus) { this.message = "Latest Neovim query queued until the current run finishes."; return; }
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
        if ((this.operationContext || this.schemaFocus) && this.driver.transactionOpen) {
            this.message = "Close the Studio transaction to load current context from Neovim.";
            return;
        }
        if ((this.schemaFocus ? request.execution?.kind === "schema" : this.operationContext) && this.refreshedRequest !== request.id) {
            if (this.schema.isRefreshing) { this.retry(); return; }
            this.refreshedRequest = request.id;
            this.schema.refresh();
        }
        if ((this.schemaFocus || this.neighbours || this.operationContext) && this.schema.isRefreshing) {
            this.message = "Loading the schema for graph context…";
            this.retry();
            return;
        }
        if (this.schemaFocus) {
            if (this.schema.visualiser.database !== database) {
                this.schema.refresh();
                this.retry();
                return;
            }
            const schema = this.schema.value$.value;
            if (!schema || this.schema.visualiser.status === "error") {
                this.pending = false;
                this.message = "Could not load schema context. Refresh the schema and run gep again.";
                return;
            }
            try {
                if (!this.schemaFocus(request, schema)) { this.retry(); return; }
            } catch (error) {
                this.message = error instanceof Error ? error.message : String(error);
                this.snackbar.warnPersistent(this.message);
            }
            this.pending = false;
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
            const supplied = request.response && !this.reapplying;
            if (supplied && !request.graph) {
                this.message = this.outcome || "The executed statement returned no graph. See the Neovim result.";
                this.note = "Previous graph retained; it does not represent this failed statement.";
                return;
            }
            const prepared = supplied ? request.graph! : this.operationContext
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
                this.state.runQuery(context.query, { limit: request.limit, schemaMode: context.schemaMode, sourceLocation: request.sourceLocation, editorQuery: request.query, projectTempDirectory: request.projectTempDirectory,
                    response: supplied ? request.graph!.response : undefined }).subscribe(result => {
                    if (this.lastRequest !== request) return;
                    const empty = ["noQueryAnswers", "noInstancesFound"].includes(this.state.graphOutput.status);
                    if (!supplied && this.operationContext && !context.schemaMode && !fallback && (!result.success || empty) && !this.pending) {
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
