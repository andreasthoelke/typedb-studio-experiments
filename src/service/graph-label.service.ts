import { unresolvedRolePairs, resolveRoleEdges } from "../framework/util/graph-edge";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { isApiErrorResponse } from "@typedb/driver-http";
import { DriverState } from "./driver-state.service";
import { SchemaState } from "./schema-state.service";
import type { GraphOutputState } from "./query-page-state.service";

/** Loads display attributes and resolves role names for existing links, without adding nodes. */
@Injectable({ providedIn: "root" })
export class GraphLabelService {
    private driver = inject(DriverState);
    private schema = inject(SchemaState);
    private loaded = new WeakMap<GraphOutputState, Set<string>>();
    private pending = new WeakMap<GraphOutputState, Promise<boolean>>();

    async load(output: GraphOutputState, typeLabel?: string): Promise<boolean> {
        while (this.pending.has(output)) await this.pending.get(output);
        if (output.destroyed || !output.visualiser || !output.database
            || output.database !== this.driver.database$.value?.name) return false;
        const connection = this.driver.connection$.value;
        if (!connection) return false;
        let loaded = this.loaded.get(output);
        if (!loaded) { loaded = new Set(); this.loaded.set(output, loaded); }
        const groups = new Map<string, string[]>();
        const schema = this.schema.value$.value;
        output.visualiser.graph.forEachNode((_, attrs) => {
            const concept = attrs.metadata?.concept;
            if (!concept || (concept.kind !== "entity" && concept.kind !== "relation")) return;
            const label = concept.type.label;
            if (typeLabel && label !== typeLabel) return;
            if (loaded!.has(concept.iid)) return;
            const type = schema?.entities[label] ?? schema?.relations[label];
            if (type && !type.ownedAttributes.length) return;
            const group = groups.get(label) ?? [];
            group.push(concept.iid);
            groups.set(label, group);
        });
        const fetch = async () => {
            try {
                const visualiser = output.visualiser!;
                const pairs = unresolvedRolePairs(visualiser.graph);
                for (let from = 0; from < pairs.length; from += 50) {
                    if (output.destroyed || output.visualiser !== visualiser || this.driver.connection$.value !== connection
                        || output.database !== this.driver.database$.value?.name) return false;
                    const branches = pairs.slice(from, from + 50).map(pair => `{ $r iid ${pair.relation}; $p iid ${pair.player}; }`).join(" or ");
                    const query = `match ${branches}; $r links ($role: $p);`;
                    const res = await firstValueFrom(output.independentRead
                        ? this.driver.queryReadOnly(query, output.database!, { answerCountLimit: 100000 })
                        : this.driver.runBackgroundReadQueries([query], { answerCountLimit: 100000 }));
                    if (isApiErrorResponse(res)) throw res.err;
                    if (output.destroyed || output.visualiser !== visualiser || this.driver.connection$.value !== connection
                        || output.database !== this.driver.database$.value?.name) return false;
                    if (res.ok.answerType === "conceptRows" && resolveRoleEdges(visualiser.graph, res.ok.answers.map(answer => answer.data))) {
                        visualiser.applyEdgeCurvature();
                        visualiser.applyEdgeStyleUpdate();
                    }
                }
                for (const [label, iids] of groups) {
                    for (let from = 0; from < iids.length; from += 50) {
                        if (output.destroyed || this.driver.connection$.value !== connection
                            || output.database !== this.driver.database$.value?.name) return false;
                        const batch = iids.slice(from, from + 50);
                        const branches = batch.map(iid => `{ $owner iid ${iid}; }`).join(" or ");
                        const query = `match $owner isa ${label}; ${branches}; $owner has $a;`;
                        // Editor runs use independent reads. Normal Studio runs can see
                        // their open transaction's uncommitted values through background reads.
                        const res = await firstValueFrom(output.independentRead
                            ? this.driver.queryReadOnly(query, output.database!, { answerCountLimit: 100000 })
                            : this.driver.runBackgroundReadQueries([query], { answerCountLimit: 100000 }));
                        if (isApiErrorResponse(res)) throw res.err;
                        if (output.destroyed || this.driver.connection$.value !== connection) return false;
                        output.recordDisplayAttributes(res, "owner");
                        batch.forEach(iid => loaded!.add(iid));
                    }
                }
                return true;
            } catch (error) {
                console.warn("Could not load graph display labels", error);
                return false;
            }
        };
        const request = fetch();
        this.pending.set(output, request);
        try { return await request; }
        finally { if (this.pending.get(output) === request) this.pending.delete(output); }
    }
}
