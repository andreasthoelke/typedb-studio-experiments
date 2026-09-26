/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Graph } from "./graph";
import { labelAttributes } from "../../util/schema-meta";

/** Schema-derived inputs to label selection. */
export interface InstanceLabelOptions {
    /** `@meta("graph-label", …)` for a type, inherited. */
    schemaLabel?: (typeLabel: string) => string | undefined;
    /** Attributes owned with @key/@unique: good identifiers when nothing is name-like. */
    identifying?: (typeLabel: string) => Set<string>;
    /** Longest value fragment; 0 = unlimited. */
    maxLength?: number;
}

/** External store of attribute values per instance IID, populated by
 *  label-only fetches that don't push to the graph. Used as a second source
 *  for the label heuristic alongside in-graph attribute neighbors. Values are
 *  stored as arrays so multi-valued attributes (an owner with several values
 *  of the same attribute type) render every value, not just the last one
 *  recorded. */
export type DisplayAttributeStore = Map<string, Map<string, unknown[]>>;

/**
 * Re-derive labels for every entity / relation instance in the graph.
 *
 * Two-phase, so each *type* picks one display attribute that every instance
 * of that type uses:
 *  1. Walk every entity/relation node. Group their available attribute type
 *     labels (union over in-graph `has` neighbors *and* the off-graph
 *     display-attribute store) by the instance's type label.
 *  2. Score each candidate attribute type label per group and pick the
 *     highest-scoring one as that instance type's display attribute. Then
 *     apply it: each instance's label becomes `<typeLabel>: <value>` if it
 *     has a value for the chosen attribute, otherwise just `<typeLabel>`.
 *
 * Picking one attribute per *type* is what keeps labels consistent across
 * siblings — without it, two `person` nodes could end up labelled with
 * different attributes (one `name`, one `id`) just because their loaded
 * attribute sets differ.
 */
export function refreshInstanceLabels(
    graph: Graph,
    store?: DisplayAttributeStore,
    overridesByType?: Map<string, string>,
    options: InstanceLabelOptions = {},
): Map<string, string[]> {
    // Phase 1: collect candidate attribute type labels per instance type,
    // with their loaded value lengths for the long-value penalty.
    const candidatesByType = new Map<string, Set<string>>();
    const lengths = new Map<string, { total: number; count: number }>();
    const measure = (typeLabel: string, attrLabel: string, values: unknown[]) => {
        const key = `${typeLabel}\u0000${attrLabel}`, entry = lengths.get(key) ?? { total: 0, count: 0 };
        for (const value of values) if (value != null) { entry.total += String(value).length; entry.count++; }
        lengths.set(key, entry);
    };
    graph.forEachNode((nodeKey, attrs) => {
        const concept = attrs.metadata?.concept as any;
        if (!concept) return;
        if (concept.kind !== "entity" && concept.kind !== "relation") return;
        const typeLabel: string | undefined = concept.type?.label;
        if (!typeLabel) return;
        let set = candidatesByType.get(typeLabel);
        if (!set) { set = new Set(); candidatesByType.set(typeLabel, set); }
        graph.forEachOutNeighbor(nodeKey, (neighborKey: string) => {
            const n = graph.getNodeAttributes(neighborKey);
            const nc = n?.metadata?.concept as any;
            const tl = nc?.kind === "attribute" ? nc.type?.label : null;
            if (tl) { set!.add(tl); measure(typeLabel, tl, [nc.value]); }
        });
        if (store && concept.iid) {
            const perOwner = store.get(concept.iid);
            if (perOwner) for (const [tl, values] of perOwner) { set.add(tl); measure(typeLabel, tl, values); }
        }
    });

    // Phase 2: pick the chosen attribute type per instance type. User
    // overrides (set via the type-detail inspector) always win and bypass
    // the heuristic; otherwise we pick the highest-scoring candidate.
    // Precedence: the user's choice, then the schema's @meta("graph-label"),
    // then the name heuristic informed by @key/@unique and value length.
    const chosenByType = new Map<string, string[]>();
    for (const [typeLabel, candidates] of candidatesByType.entries()) {
        const override = overridesByType?.get(typeLabel) ?? options.schemaLabel?.(typeLabel);
        if (override) {
            chosenByType.set(typeLabel, labelAttributes(override));
            continue;
        }
        const identifying = options.identifying?.(typeLabel);
        let best: { typeLabel: string; score: number } | null = null;
        for (const candTypeLabel of candidates) {
            const stats = lengths.get(`${typeLabel}\u0000${candTypeLabel}`);
            const score = scoreAttributeTypeName(candTypeLabel) + (identifying?.has(candTypeLabel) ? 120 : 0)
                - (stats?.count && stats.total / stats.count > 80 ? 120 : 0);
            if (score <= 0) continue;
            if (!best || score > best.score) best = { typeLabel: candTypeLabel, score };
        }
        chosenByType.set(typeLabel, best ? [best.typeLabel] : []);
    }

    // Phase 3: apply.
    graph.forEachNode((nodeKey, attrs) => {
        const concept = attrs.metadata?.concept as any;
        if (!concept) return;
        if (concept.kind !== "entity" && concept.kind !== "relation") return;
        const typeLabel: string = concept.type?.label ?? "";
        const parts: string[] = [];
        for (const chosen of chosenByType.get(typeLabel) ?? []) {
            const collected = collectAttributeValues(graph, nodeKey, concept.iid, chosen, store);
            const formatted = formatValues(collected.values, options.maxLength ?? 0);
            // A bare `true`/`false` is meaningless on its own, so name the attribute.
            if (formatted) parts.push(collected.isBoolean ? `${chosen}=${formatted}` : formatted);
        }
        const newLabel = parts.length ? `${typeLabel}: ${parts.join(" · ")}` : typeLabel;
        if (attrs.label !== newLabel) {
            graph.setNodeAttribute(nodeKey, "label", newLabel);
        }
    });
    return chosenByType;
}

function collectAttributeValues(
    graph: Graph,
    ownerKey: string,
    ownerIid: string | undefined,
    chosenTypeLabel: string,
    store?: DisplayAttributeStore,
): { values: unknown[]; isBoolean: boolean } {
    // Union over both sources so a multi-valued attribute renders every
    // value, regardless of whether some came from explicit in-graph loads
    // and others from the off-graph label-only fetch.
    const out: unknown[] = [];
    let isBoolean = false;
    graph.forEachOutNeighbor(ownerKey, (neighborKey: string) => {
        const n = graph.getNodeAttributes(neighborKey);
        const nc = n?.metadata?.concept as any;
        if (nc?.kind === "attribute" && nc.type?.label === chosenTypeLabel) {
            out.push(nc.value);
            if (nc.valueType === "boolean" || nc.type?.valueType === "boolean" || typeof nc.value === "boolean") {
                isBoolean = true;
            }
        }
    });
    if (store && ownerIid) {
        const fromStore = store.get(ownerIid)?.get(chosenTypeLabel);
        if (fromStore) {
            out.push(...fromStore);
            // Store values are untyped; fall back to the JS type of the value.
            if (fromStore.some(v => typeof v === "boolean")) isBoolean = true;
        }
    }
    return { values: out, isBoolean };
}

const NAME_TIER_A = new Set([
    "name", "title", "label",
    "fullname", "displayname", "givenname", "firstname", "lastname",
    "username", "handle", "alias",
    "nickname", "screenname",
]);

// Tier between A and B: "text" is content-y but not a canonical "name". We
// want it to win against id/email/code yet still lose to name/title/label.
const NAME_TIER_A2 = new Set([
    "text",
]);

const NAME_TIER_B = new Set([
    "email", "emailaddress",
    "identifier", "id", "uid", "uuid",
    "code", "slug", "key", "ref", "reference",
]);

/**
 * Score an attribute type name purely on how name-like it is. Higher is
 * better; 0 means "don't use this attribute". Tiers:
 *  - A   (~300): canonical name fields
 *  - A2  (~250): `text`
 *  - B   (~200): identifier-ish (email, id, code, ...)
 *  - C   (~100): anything containing "name", "title" or "text"
 *  - D   (~50):  fallback for any unknown attribute name
 * Within a tier, shorter type labels win (so `name` beats `display_name`).
 */
function scoreAttributeTypeName(typeLabel: string): number {
    if (!typeLabel) return 0;
    const norm = typeLabel.toLowerCase().replace(/[-_\s]/g, "");
    const lengthPenalty = Math.min(typeLabel.length, 40);
    if (NAME_TIER_A.has(norm)) return 300 - lengthPenalty;
    if (NAME_TIER_A2.has(norm)) return 250 - lengthPenalty;
    if (NAME_TIER_B.has(norm)) return 200 - lengthPenalty;
    if (norm.includes("name") || norm.includes("title") || norm.includes("text")) {
        return 100 - lengthPenalty;
    }
    return 50 - lengthPenalty;
}

/** Render a collected value-set as one label fragment. Deduplicates by the
 *  rendered string (so identical values across the in-graph + store sources
 *  show once), sorts ascending using a numeric-aware comparator (`"2"`
 *  before `"10"`), and joins with commas. Empty strings and null values are
 *  dropped — a `name` with no value at all reduces back to just the type
 *  label rather than `<type>: , `. */
function formatValues(values: unknown[], maxLength = 0): string {
    if (values.length === 0) return "";
    const seen = new Set<string>();
    const strs: string[] = [];
    for (const v of values) {
        if (v == null) continue;
        const s = typeof v === "string" ? v : String(v);
        if (s.length === 0) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        strs.push(s);
    }
    if (strs.length === 0) return "";
    strs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    // Long values are shortened with an ellipsis; the Explorer shows them in full.
    const clip = (text: string) => maxLength > 1 && text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
    const shown = strs.slice(0, 3).map(clip);
    return shown.join(", ") + (strs.length > 3 ? ` +${strs.length - 3}` : "");
}
