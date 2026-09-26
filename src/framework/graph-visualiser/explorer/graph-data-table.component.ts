import { Component, DoCheck, ElementRef, inject, Input } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { MatTooltipModule } from "@angular/material/tooltip";
import { isApiErrorResponse } from "@typedb/driver-http";
import { GraphVisualiser } from "../engine";
import { GraphNodeActionsComponent } from "./graph-node-actions.component";
import { RunOutputState } from "../../../service/query-page-state.service";
import { Schema, SchemaState } from "../../../service/schema-state.service";
import { DriverState } from "../../../service/driver-state.service";
import { GraphViewState } from "../../../service/graph-view-state.service";
import { GraphStyleService } from "../../../service/graph-style.service";
import { AttributeEditService } from "../../../service/attribute-edit.service";
import { isaRelatives } from "../../util/graph-correspondence";

export type DataSource = "loaded" | "selection" | "database";
interface DataRow { iid: string; type: string; key: string | null; values: Map<string, unknown[]> }
interface ConceptLike { kind?: string; iid?: string; type?: { label?: string } }

const DATABASE_ROW_LIMIT = 200;

/** "every x" as a table: instances as rows, owned attributes as columns.
 *  Rows come from the loaded graph (default: instant, no query), the explicit
 *  selection, or a bounded database read. Several types share columns, so
 *  common fields line up for comparison. Cells edit the database directly. */
@Component({
    selector: "ts-graph-data-table",
    templateUrl: "./graph-data-table.component.html",
    styleUrls: ["./graph-data-table.component.scss"],
    imports: [MatTooltipModule, GraphNodeActionsComponent],
})
export class GraphDataTableComponent implements DoCheck {
    @Input() visualiser: GraphVisualiser | null = null;
    @Input() run: RunOutputState | null = null;
    /** The caret's type: the default when no instances are selected. */
    @Input() focusType: string | null = null;

    private schemaState = inject(SchemaState);
    private driver = inject(DriverState);
    private graphViewState = inject(GraphViewState);
    private styleService = inject(GraphStyleService);
    private host = inject<ElementRef<HTMLElement>>(ElementRef);
    readonly edits = inject(AttributeEditService);

    source: DataSource = "loaded";
    private sourceChosen = false;
    /** Types toggled off by the user. */
    excludedTypes = new Set<string>();
    filter = "";
    sortColumn: string | null = null;
    sortDescending = false;

    types: string[] = [];
    columns: string[] = [];
    rows: DataRow[] = [];
    message = "";
    loading = false;
    private databaseRows: DataRow[] = [];
    private databaseSignature = "";
    private signature = "";

    editing: { iid: string; column: string } | null = null;
    editText = "";
    editError = "";

    private get schema(): Schema | null { return this.schemaState.value$.value; }

    private concept(key: string): ConceptLike | undefined { return this.visualiser?.graph.getNodeAttribute(key, "metadata")?.concept as ConceptLike | undefined; }
    private isInstance(key: string): boolean { const kind = this.concept(key)?.kind; return kind === "entity" || kind === "relation"; }

    get selectedInstances(): string[] {
        const v = this.visualiser;
        return v?.elementSelection.active ? [...v.elementSelection.nodes].filter(key => v.graph.hasNode(key) && this.isInstance(key)) : [];
    }

    /** Types in view: the selection's instance types, else the caret's type. */
    private candidateTypes(): string[] {
        const selected = this.selectedInstances.map(key => this.concept(key)?.type?.label).filter((t): t is string => !!t);
        return selected.length ? [...new Set(selected)].sort() : this.focusType ? [this.focusType] : [];
    }

    ngDoCheck(): void {
        const v = this.visualiser;
        if (!v) return;
        if (!this.sourceChosen) this.source = this.selectedInstances.length ? "selection" : "loaded";
        const types = this.candidateTypes();
        const signature = JSON.stringify([v.graph.order, v.graph.size, v.labelsVersion, this.source, types, [...this.excludedTypes],
            this.filter, this.sortColumn, this.sortDescending, this.selectedInstances.length, this.databaseSignature]);
        if (signature === this.signature) return;
        this.signature = signature;
        this.types = types;
        this.rebuild();
    }

    private activeTypes(): string[] { return this.types.filter(type => !this.excludedTypes.has(type)); }

    private rebuild(): void {
        const v = this.visualiser!, active = this.activeTypes();
        let rows: DataRow[];
        if (this.source === "database") rows = this.databaseRows.filter(row => active.includes(row.type) || active.some(t => isaRelatives(t, this.schema, "down").includes(row.type)));
        else {
            const family = new Set(active.flatMap(type => isaRelatives(type, this.schema, "down")));
            const keys = this.source === "selection" ? this.selectedInstances
                : v.graph.filterNodes((key, attrs) => !attrs["viewHidden"] && this.isInstance(key));
            rows = keys.filter(key => family.has(this.concept(key)?.type?.label ?? "")).map(key => {
                const concept = this.concept(key)!;
                return { iid: concept.iid ?? key, type: concept.type!.label!, key, values: v.nodeAttributeValues(key) };
            });
        }
        this.columns = this.columnsFor(active, rows);
        const needle = this.filter.trim().toLowerCase();
        if (needle) rows = rows.filter(row => row.type.toLowerCase().includes(needle)
            || [...row.values.values()].some(values => values.some(value => String(value).toLowerCase().includes(needle))));
        if (this.sortColumn) {
            const column = this.sortColumn, direction = this.sortDescending ? -1 : 1;
            const text = (row: DataRow) => column === "@type" ? row.type : (row.values.get(column) ?? []).map(String).sort().join(", ");
            rows = [...rows].sort((a, b) => direction * (text(a) === "" ? 1 : text(b) === "" ? -1 : 0)
                || direction * text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: "base" }));
        }
        this.rows = rows;
    }

    /** Identifying attributes first, then label attributes, then those shared by
     *  more types, then the rest alphabetically. Includes inherited owns. */
    private columnsFor(types: string[], rows: DataRow[]): string[] {
        const schema = this.schema, defaults = this.styleService.schemaDefaults;
        const counts = new Map<string, number>(), rank = new Map<string, number>();
        for (const type of types) {
            const owned = new Set<string>();
            let t: any = schema?.entities[type] ?? schema?.relations[type];
            for (const seen = new Set<string>(); t && !seen.has(t.label); t = t.supertype) { seen.add(t.label); t.ownedAttributes?.forEach((a: { label: string }) => owned.add(a.label)); }
            owned.forEach(label => counts.set(label, (counts.get(label) ?? 0) + 1));
            defaults?.identifying(type).forEach(label => rank.set(label, 0));
            this.visualiser?.chosenLabelAttributes.get(type)?.forEach(label => { if (!rank.has(label)) rank.set(label, 1); });
        }
        // Values present on rows (e.g. subtype attributes) also get a column.
        rows.forEach(row => row.values.forEach((_, label) => { if (!counts.has(label)) counts.set(label, 0); }));
        return [...counts.keys()].sort((a, b) => (rank.get(a) ?? 2) - (rank.get(b) ?? 2)
            || (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
    }

    setSource(source: DataSource): void {
        this.source = source; this.sourceChosen = true; this.message = "";
        if (source === "database") void this.loadDatabase();
    }

    toggleType(type: string): void {
        if (this.excludedTypes.has(type)) this.excludedTypes.delete(type);
        else if (this.activeTypes().length > 1) this.excludedTypes.add(type);
    }

    sortBy(column: string): void {
        if (this.sortColumn === column) this.sortDescending = !this.sortDescending;
        else { this.sortColumn = column; this.sortDescending = false; }
    }

    /** A bounded read of every attribute of the types' instances. */
    async loadDatabase(): Promise<void> {
        const database = this.run?.graph.database;
        if (!database || database !== this.driver.database$.value?.name) { this.message = "Connect to this graph's database to read it."; return; }
        const types = this.activeTypes();
        if (!types.length) return;
        this.loading = true; this.message = "";
        try {
            const rows = new Map<string, DataRow>();
            for (const type of types) {
                const query = `match $x isa ${type}; $x has $a;`;
                const res = await firstValueFrom(this.driver.queryReadOnly(query, database, { answerCountLimit: 20000 }));
                if (isApiErrorResponse(res)) throw new Error(res.err.message);
                if (res.ok.answerType !== "conceptRows") continue;
                for (const answer of res.ok.answers) {
                    const x = answer.data["x"] as ConceptLike | undefined, a = answer.data["a"] as { type?: { label?: string }; value?: unknown } | undefined;
                    if (!x?.iid || !a?.type?.label) continue;
                    if (!rows.has(x.iid) && rows.size >= DATABASE_ROW_LIMIT * types.length) continue;
                    const row = rows.get(x.iid) ?? { iid: x.iid, type: x.type?.label ?? type, key: null, values: new Map() };
                    const list: unknown[] = row.values.get(a.type.label) ?? [];
                    if (!list.some(value => String(value) === String(a.value))) list.push(a.value);
                    row.values.set(a.type.label, list);
                    rows.set(x.iid, row);
                }
            }
            this.databaseRows = [...rows.values()].slice(0, DATABASE_ROW_LIMIT);
            if (rows.size > DATABASE_ROW_LIMIT) this.message = `Showing the first ${DATABASE_ROW_LIMIT} instances.`;
        } catch (error) {
            this.message = `Could not read the database: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.loading = false;
            this.databaseSignature = `${Date.now()}`;
        }
    }

    rowKey(row: DataRow): string | null {
        return row.key && this.visualiser?.graph.hasNode(row.key) ? row.key : this.visualiser?.nodeKeyByIid(row.iid) ?? null;
    }

    async addRow(row: DataRow): Promise<void> {
        const type = this.schema?.entities[row.type] ?? this.schema?.relations[row.type];
        if (!this.run || !type || !this.graphViewState.guardExploration()) return;
        this.visualiser?.freezeViewport();
        await this.graphViewState.fetchInstances(this.run, type, [row.iid]);
        this.visualiser?.reheat({ soft: true, preserveCamera: true });
    }

    cellText(row: DataRow, column: string): string {
        return (row.values.get(column) ?? []).map(String).join(", ");
    }

    goTo(row: DataRow): void {
        const key = this.rowKey(row);
        if (key) this.visualiser?.goToNodes([key]);
    }

    // -- Editing: a cell with no or one value edits in place.

    get canEdit(): boolean { return !!this.run?.graph.database && !this.run.graph.schemaMode; }

    isEditing(row: DataRow, column: string): boolean { return this.editing?.iid === row.iid && this.editing.column === column; }

    startEdit(row: DataRow, column: string): void {
        if (!this.canEdit || !row.iid.startsWith("0x")) return;
        const values = row.values.get(column) ?? [];
        if (values.length > 1) { this.message = `${column} has several values here; edit them in the Explorer.`; return; }
        this.editing = { iid: row.iid, column };
        this.editText = values.length ? String(values[0]) : "";
        this.editError = "";
        setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>("input.cell-editor")?.focus());
    }

    cancelEdit(): void { this.editing = null; this.editError = ""; }

    async commitEdit(row: DataRow): Promise<void> {
        const editing = this.editing;
        if (!editing) return;
        const old = row.values.get(editing.column)?.[0];
        if (old !== undefined && String(old) === this.editText) { this.cancelEdit(); return; }
        if (old === undefined && this.editText === "") { this.cancelEdit(); return; }
        const remove = this.editText === "" && old !== undefined;
        if (!remove) {
            const invalid = this.edits.validate(editing.column, this.editText);
            if (invalid) { this.editError = invalid; return; }
        }
        const result = await this.edits.edit(this.run?.graph.database, this.visualiser, {
            ownerIid: row.iid, ownerType: row.type, attribute: editing.column,
            oldValue: old === undefined ? undefined : String(old), newValue: remove ? undefined : this.editText });
        if (!result.ok) { this.editError = result.message; return; }
        this.editing = null; this.message = result.message;
        // Database rows are not in the value store; update them in place.
        if (this.source === "database") {
            const current: unknown[] = row.values.get(editing.column) ?? [];
            const list = current.filter(value => old === undefined || String(value) !== String(old));
            if (!remove) list.push(this.editText);
            row.values.set(editing.column, list);
            this.databaseSignature = `${Date.now()}`;
        }
    }
}
