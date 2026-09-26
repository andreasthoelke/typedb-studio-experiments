/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Component, DestroyRef, ElementRef, inject, Input, OnChanges, SimpleChanges } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { CommonModule } from "@angular/common";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatButtonModule } from "@angular/material/button";
import { MatTooltip, MatTooltipModule } from "@angular/material/tooltip";
import { Clipboard } from "@angular/cdk/clipboard";
import { GraphViewState } from "../../../service/graph-view-state.service";
import { RunOutputState } from "../../../service/query-page-state.service";
import { SchemaConcept, SchemaRelation, SchemaRole } from "../../../service/schema-state.service";
import { AttributeData, InstanceDetailState, LinkData, RelationInstanceData } from "../../../service/instance-detail-state.service";
import { GraphVisualiser } from "../engine";
import { GraphNodeActionsComponent } from "./graph-node-actions.component";
import { AttributeEditService } from "../../../service/attribute-edit.service";

/** Sticky-state key for "this instance's link to a specific relation instance
 *  has been loaded". Namespaced with a `rel:` prefix so a relation IID can
 *  never be confused with a relation/role *type* label stored in the same
 *  per-instance set (those track whole-type loads). */
function relationInstanceKey(relationIID: string): string {
    return `rel:${relationIID}`;
}

/** Sticky-state key for "a specific role-player link (relation IID + player
 *  IID) has been loaded". Adding a relation pulls in all its player links, so
 *  each is marked with this key; a single role-player add marks just one. */
function linkInstanceKey(relationIID: string, playerIID: string): string {
    return `link:${relationIID}:${playerIID}`;
}

@Component({
    selector: "ts-graph-instance-explorer",
    templateUrl: "./graph-instance-explorer.component.html",
    styleUrls: [
        // Reuse the data-side inspector's section/card/attribute styling so we
        // don't duplicate ~600 lines of SCSS. Angular's view encapsulation
        // keeps them scoped to this component. Listed first so the
        // explorer's own SCSS (below) wins on the :host overrides.
        "../../../module/data/instance-detail/instance-detail.component.scss",
        "./graph-instance-explorer.component.scss",
    ],
    providers: [InstanceDetailState],
    imports: [
        CommonModule,
        MatProgressSpinnerModule,
        MatButtonModule,
        MatTooltipModule,
        GraphNodeActionsComponent,
    ],
})
export class GraphInstanceExplorerComponent implements OnChanges {
    @Input() type: SchemaConcept | null = null;
    @Input() instanceIID: string | null = null;
    @Input() run: RunOutputState | null = null;
    @Input() visualiser: GraphVisualiser | null = null;

    state = inject(InstanceDetailState);
    // null when no selection — only valid to access state.* fields when this is true
    get hasSelection(): boolean { return !!(this.type && this.instanceIID); }

    selectedRelationType: string | null = null;
    linksCollapsed = false;
    attributesCollapsed = false;
    relationsCollapsed = false;
    ownersCollapsed = false;

    private graphViewState = inject(GraphViewState);
    private clipboard = inject(Clipboard);
    private host = inject<ElementRef<HTMLElement>>(ElementRef);
    readonly edits = inject(AttributeEditService);

    // Inline attribute editing: one value (or a new one) at a time.
    private editing: { attr: string; index: number | "new"; value?: string } | null = null;
    editText = "";
    editError = "";
    editMessage = "";
    removePending: string | null = null;
    private removeTimer?: ReturnType<typeof setTimeout>;

    constructor() {
        // Another surface (Data tab, this panel) changed this instance: re-read it.
        this.edits.edited$.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe(iid => {
            if (iid === this.instanceIID && this.hasSelection) this.state.refresh();
        });
    }

    /** Edits need a live, connected run of a database graph (not an offline preview). */
    get canEdit(): boolean {
        return !!this.run?.graph.database && !this.run.graph.schemaMode && this.type?.kind !== "attributeType" && !!this.instanceIID?.startsWith("0x");
    }

    /** Loaded values, plus (when editable) owned attribute types without a value
     *  yet, so a value can be added. Includes inherited owns. */
    get attributeRows(): (AttributeData & { empty?: boolean })[] {
        const rows: (AttributeData & { empty?: boolean })[] = [...this.state.attributes];
        if (!this.canEdit || !this.type) return rows;
        const present = new Set(rows.map(row => row.type));
        const seen = new Set<string>();
        for (let t: any = this.type; t && !seen.has(t.label); t = t.supertype) {
            seen.add(t.label);
            for (const owned of (t.ownedAttributes ?? []) as { label: string; valueType?: string }[]) {
                if (present.has(owned.label)) continue;
                present.add(owned.label);
                rows.push({ type: owned.label, valueType: owned.valueType ?? "", values: [], empty: true });
            }
        }
        return rows;
    }

    isEditing(attr: AttributeData, index: number | "new"): boolean {
        return this.editing?.attr === attr.type && this.editing.index === index;
    }

    startEdit(attr: AttributeData, index: number | "new", value: string): void {
        this.editing = { attr: attr.type, index, value: index === "new" ? undefined : value };
        this.editText = value; this.editError = ""; this.editMessage = "";
        setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>("input.value-editor")?.focus());
    }

    cancelEdit(): void { this.editing = null; this.editError = ""; }

    async commitEdit(attr: AttributeData): Promise<void> {
        const editing = this.editing;
        if (!editing || !this.type || !this.instanceIID) return;
        if (editing.value !== undefined && editing.value === this.editText) { this.cancelEdit(); return; }
        const invalid = this.edits.validate(attr.type, this.editText);
        if (invalid) { this.editError = invalid; return; }
        const result = await this.edits.edit(this.run?.graph.database, this.visualiser, {
            ownerIid: this.instanceIID, ownerType: this.type.label, attribute: attr.type, oldValue: editing.value, newValue: this.editText });
        if (result.ok) { this.editing = null; this.editMessage = result.message; }
        else this.editError = result.message;
    }

    /** Two clicks: the first arms (3 s), the second deletes the value from the database. */
    async removeValue(attr: AttributeData, value: string): Promise<void> {
        const key = `${attr.type}|${value}`;
        if (this.removePending !== key) {
            this.removePending = key; clearTimeout(this.removeTimer);
            this.removeTimer = setTimeout(() => this.removePending = null, 3000);
            return;
        }
        this.removePending = null; clearTimeout(this.removeTimer);
        if (!this.type || !this.instanceIID) return;
        const result = await this.edits.edit(this.run?.graph.database, this.visualiser, {
            ownerIid: this.instanceIID, ownerType: this.type.label, attribute: attr.type, oldValue: value });
        this.editMessage = result.message;
    }

    ngOnChanges(changes: SimpleChanges) {
        if ((changes["type"] || changes["instanceIID"]) && this.type && this.instanceIID) {
            this.selectedRelationType = null;
            this.editing = null; this.editMessage = ""; this.removePending = null;
            this.state.initialize(this.type, this.instanceIID);
        }
    }

    get filteredRelations(): RelationInstanceData[] {
        if (this.selectedRelationType === null) return this.state.allRelations;
        return this.state.allRelations.filter(r => r.relationTypeLabel === this.selectedRelationType);
    }

    selectRelationType(type: string | null) {
        this.selectedRelationType = type;
    }

    copyValue(value: string, tooltip: MatTooltip) {
        this.clipboard.copy(value);
        tooltip.show(0);
        setTimeout(() => tooltip.hide(0), 1000);
    }

    addAllAttributes() {
        if (!this.run || !this.type || !this.instanceIID) return;
        if (!this.graphViewState.guardExploration()) return;
        this.visualiser?.freezeViewport();
        this.graphViewState
            .fetchAttributesOf(this.run, this.type, [this.instanceIID])
            .then(() => {
                this.visualiser?.reheat({ soft: true, preserveCamera: true });
                // Newly-added attributes are neighbors of the current selection
                // but weren't around when collectHighlightedNeighbors last ran,
                // so re-evaluate to bring them into the highlight set.
                this.visualiser?.interactionHandler.recomputeHighlightSet();
                // Mark every owned attribute type loaded for THIS instance, so
                // the context menu's "here" attribute chips show as loaded.
                this.ownedAttributeLabels().forEach(label => this.markInstanceLoaded(label));
            });
    }

    /** Add only the attributes of a specific type (one row in the Attributes table). */
    addAttribute(attr: AttributeData) {
        if (!this.run || !this.type || !this.instanceIID) return;
        if (!this.graphViewState.guardExploration()) return;
        this.visualiser?.freezeViewport();
        this.graphViewState
            .fetchAttributesOfTypeFor(this.run, this.type, [this.instanceIID], attr.type)
            .then(() => {
                this.visualiser?.reheat({ soft: true, preserveCamera: true });
                this.visualiser?.interactionHandler.recomputeHighlightSet();
                this.markInstanceLoaded(attr.type);
            });
    }

    /** True once this attribute type has been loaded into the graph for the
     *  currently inspected instance. */
    isAttributeAdded(attr: AttributeData): boolean {
        if (!this.run || !this.instanceIID) return false;
        return this.graphViewState.isInstanceConnectionLoaded(this.run, this.instanceIID, attr.type);
    }

    /** This instance's attribute nodes of one type (one per loaded value). */
    attributeKeys(attr: AttributeData): string[] {
        if (!this.type || !this.instanceIID || this.type.kind === "attributeType") return [];
        const ownerKind = this.type.kind === "relationType" ? "relation" : "entity";
        return this.visualiser?.attributeNodeKeysOf(ownerKind, this.type.label, this.instanceIID, attr.type) ?? [];
    }

    playerKey(link: LinkData): string | null { return this.visualiser?.nodeKeyByIid(link.playerIID) ?? null; }
    relationKey(rel: RelationInstanceData): string | null { return this.visualiser?.nodeKeyByIid(rel.relationIID) ?? null; }
    ownerKey(iid: string): string | null { return this.visualiser?.nodeKeyByIid(iid) ?? null; }

    addAllRelations() {
        if (!this.run || !this.type || !this.instanceIID) return;
        if (!this.graphViewState.guardExploration()) return;
        this.visualiser?.freezeViewport();
        this.graphViewState
            .fetchLinksOf(this.run, this.type, [this.instanceIID])
            .then(() => {
                this.visualiser?.reheat({ soft: true, preserveCamera: true });
                this.visualiser?.interactionHandler.recomputeHighlightSet();
                // `fetchLinksOf` pulls in every relation the instance plays a
                // role in (and, for a relation, every role player), so mark all
                // the matching connection labels loaded for this instance.
                this.connectionLabelsForLinks().forEach(label => this.markInstanceLoaded(label));
            });
    }

    /** Record `connLabel` as loaded for the currently-inspected instance so the
     *  context menu's "here" chips reflect what the Explorer has loaded. */
    private markInstanceLoaded(connLabel: string): void {
        if (!this.run || !this.instanceIID) return;
        this.graphViewState.markInstanceConnectionLoaded(this.run, this.instanceIID, connLabel);
    }

    /** Attribute type labels the inspected type owns — matches the context
     *  menu's attribute rows. */
    private ownedAttributeLabels(): string[] {
        const owned = (this.type && "ownedAttributes" in this.type ? this.type.ownedAttributes : []) ?? [];
        return owned.map(a => a.label);
    }

    /** Connection labels loaded by `fetchLinksOf` — relation-type labels for an
     *  entity (the relations it plays a role in), scoped role labels for a
     *  relation (the roles it relates). Mirrors the context menu's row keys. */
    private connectionLabelsForLinks(): string[] {
        if (!this.type) return [];
        if (this.type.kind === "relationType") {
            return ((this.type as SchemaRelation).relatedRoles ?? []).map((r: SchemaRole) => r.label);
        }
        const playedRoles = ("playedRoles" in this.type ? this.type.playedRoles : []) as SchemaRole[];
        const seen = new Set<string>();
        for (const role of playedRoles ?? []) {
            seen.add(role.label.split(":")[0]);
        }
        return Array.from(seen);
    }

    /** Add a relation instance (with all its role players) to the graph,
     *  keeping the current instance selected rather than navigating to it. */
    addRelation(rel: RelationInstanceData) {
        if (!this.run || this.isRelationAdded(rel)) return;
        if (!this.graphViewState.guardExploration()) return;
        this.visualiser?.freezeViewport();
        this.graphViewState
            .fetchRelation(this.run, rel.relationIID)
            .then(() => {
                this.visualiser?.reheat({ soft: true, preserveCamera: true });
                this.visualiser?.interactionHandler.recomputeHighlightSet();
                // Track this specific relation as loaded for the current
                // instance: the key is the (instance IID, relation IID) pair.
                // This is stricter than "is the relation node present" — it
                // records that *this instance's link to this relation* was
                // retrieved, which is what `fetchRelation` actually pulls in.
                this.markInstanceLoaded(relationInstanceKey(rel.relationIID));
                // `fetchRelation` also pulls in every role player + role edge,
                // so mark each of the relation's links loaded too.
                rel.links.forEach(link =>
                    this.markInstanceLoaded(linkInstanceKey(rel.relationIID, link.playerIID)));
                // If this completes every relation of its type for this
                // instance, mark the relation *type* loaded too — that's the
                // key the context menu's relation chip reads, so loading the
                // last (or only) relation of a type ticks + disables that chip.
                this.maybeMarkRelationTypeLoaded(rel.relationTypeLabel);
            });
    }

    /** Add every relation of `relationTypeLabel` the current instance plays a
     *  role in, in one fetch — the per-card "Add all to graph" affordance. */
    addAllRelationsOfType(relationTypeLabel: string) {
        if (!this.run || !this.type || !this.instanceIID) return;
        if (!this.graphViewState.guardExploration()) return;
        const ofType = this.state.allRelations.filter(r => r.relationTypeLabel === relationTypeLabel);
        this.visualiser?.freezeViewport();
        this.graphViewState
            .fetchRelationsOfTypeForPlayers(this.run, this.type, [this.instanceIID], relationTypeLabel)
            .then(() => {
                this.visualiser?.reheat({ soft: true, preserveCamera: true });
                this.visualiser?.interactionHandler.recomputeHighlightSet();
                // Mark each relation (and its links) of this type loaded for the
                // instance, then the relation type itself.
                ofType.forEach(rel => {
                    this.markInstanceLoaded(relationInstanceKey(rel.relationIID));
                    rel.links.forEach(link =>
                        this.markInstanceLoaded(linkInstanceKey(rel.relationIID, link.playerIID)));
                });
                this.maybeMarkRelationTypeLoaded(relationTypeLabel);
            });
    }

    /** True once every relation of `relationTypeLabel` for the current instance
     *  has been added — hides the per-card "Add all to graph" button. */
    allRelationsOfTypeAdded(relationTypeLabel: string): boolean {
        const ofType = this.state.allRelations.filter(r => r.relationTypeLabel === relationTypeLabel);
        return ofType.length > 0 && ofType.every(r => this.isRelationAdded(r));
    }

    /** Mark a relation TYPE loaded for the current instance once all of its
     *  relation instances have been individually added — keeping the context
     *  menu's per-type relation chip in sync with individual Explorer adds. */
    private maybeMarkRelationTypeLoaded(relationTypeLabel: string): void {
        const ofType = this.state.allRelations.filter(r => r.relationTypeLabel === relationTypeLabel);
        if (ofType.length > 0 && ofType.every(r => this.isRelationAdded(r))) {
            this.markInstanceLoaded(relationTypeLabel);
        }
    }

    /** True once this relation has been added to the graph for the currently
     *  inspected instance (its source→relation link was loaded). */
    isRelationAdded(rel: RelationInstanceData): boolean {
        return !!this.visualiser?.nodeKeyByIid(rel.relationIID);
    }


    get selfNodeKey(): string | null {
        if (!this.type || !this.instanceIID) return null;
        const kind = this.type.kind === "relationType" ? "relation"
            : this.type.kind === "attributeType" ? "attribute" : "entity";
        return this.visualiser?.instanceNodeKey(kind, this.type.label, this.instanceIID) ?? null;
    }


    addLink(_link: LinkData) {
        // No parent relation in scope for a single link row inside a relation
        // card, so fall back to refetching all of the current instance's
        // relations — graph dedupes the rest.
        this.addAllRelations();
    }

    /** Add a role-player (and its containing relation) to the graph, keeping
     *  the current instance selected. */
    addPlayer(parentRel: RelationInstanceData, link: LinkData) {
        this.addLinkInRelation(parentRel.relationIID, link);
    }

    /** Add a role-player of the relation the Explorer is currently showing.
     *  The inspected instance itself is the parent relation. */
    addOwnLink(link: LinkData) {
        if (!this.instanceIID) return;
        this.addLinkInRelation(this.instanceIID, link);
    }

    private addLinkInRelation(relationIID: string, link: LinkData): void {
        if (!this.run) return;
        this.visualiser?.freezeViewport();
        // Pass the currently-inspected instance as `originalIID` so the query
        // pulls in the role edge back to it — keeps the new player connected to
        // whatever the user is viewing (no-op when viewing the relation itself).
        this.graphViewState
            .fetchPlayerInRelation(this.run, relationIID, link.playerIID, this.instanceIID ?? undefined)
            .then(() => {
                this.visualiser?.reheat({ soft: true, preserveCamera: true });
                this.visualiser?.interactionHandler.recomputeHighlightSet();
                this.markInstanceLoaded(linkInstanceKey(relationIID, link.playerIID));
            });
    }

    /** True once this role-player link has been loaded for the current instance
     *  — either directly, or implicitly by adding its parent relation. */
    isLinkAdded(relationIID: string, link: LinkData): boolean {
        const v = this.visualiser, relation = v?.nodeKeyByIid(relationIID), player = v?.nodeKeyByIid(link.playerIID);
        return !!v && !!relation && !!player && v.graph.edges(relation, player).length > 0;
    }


}
