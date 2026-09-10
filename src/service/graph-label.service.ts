import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { isApiErrorResponse } from "@typedb/driver-http";
import { DriverState } from "./driver-state.service";
import { SchemaState } from "./schema-state.service";
import type { GraphOutputState } from "./query-page-state.service";

/** Loads label values into the existing off-graph store, never into GraphBuilder. */
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
