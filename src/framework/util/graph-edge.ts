import type { Graph } from "../graph-visualiser/engine/graph";
import type { ConceptRow, RoleType } from "@typedb/driver-http";

/** Semantic edge identity is independent of the text currently rendered by Sigma. */
export interface SemanticEdge {
    label?: string;
    metadata?: { defaultLabel?: string; dataEdge?: {
        tag?: string;
        role?: { kind?: string; label?: string };
        relation?: { kind?: string; type?: { label?: string } };
    } };
}

/** Named roles in query analysis can be unscoped; answer role types are scoped. */
export function edgeRoleLabel(edge: SemanticEdge): string | null {
    const constraint = edge.metadata?.dataEdge;
    const role = constraint?.tag === "links" && constraint.role?.kind === "roleType" ? constraint.role.label : null;
    if (!role) return null;
    if (role.includes(":")) return role;
    const relation = constraint?.relation?.type?.label;
    return relation ? `${relation}:${role}` : null;
}

export function edgeStyleKey(edge: SemanticEdge): string {
    return edgeRoleLabel(edge) ?? edge.metadata?.dataEdge?.tag ?? edge.label ?? "";
}

export function edgeDisplayLabel(edge: SemanticEdge): string {
    const constraint = edge.metadata?.dataEdge;
    if (constraint?.tag === "links") {
        return edgeRoleLabel(edge)?.split(":").at(-1)
            ?? (constraint.role?.kind === "roleType" ? constraint.role.label : undefined) ?? "links";
    }
    return edge.metadata?.defaultLabel ?? edge.label ?? constraint?.tag ?? "";
}

/** Per-role overrides inherit each property independently from links, then all edges. */
export function inheritedEdgeStyle<T>(overrides: Record<string, T>, key: string | undefined, fallback: T): T {
    return (key ? overrides[key] ?? (key.includes(":") ? overrides["links"] : undefined) : undefined) ?? fallback;
}

/** Symmetric lanes; invert for reversed endpoints so opposite directions cannot overlap. */
export function parallelEdgeGeometry(index: number, count: number, source: string, target: string, curved: boolean): { type: string; curvature: number } {
    if (count <= 1) return { type: curved ? "curved" : "line", curvature: 0.25 };
    const curvature = (index - (count - 1) / 2) * 0.5 * (source < target ? 1 : -1);
    return { type: curvature === 0 ? "line" : "curved", curvature };
}

/** Only resolve role identity for links already drawn; never expand the node set. */
export function unresolvedRolePairs(graph: Graph): { relation: string; player: string }[] {
    const pairs = new Map<string, { relation: string; player: string }>();
    graph.forEachEdge((_key, attrs, source, target) => {
        const constraint = attrs.metadata?.dataEdge;
        if (constraint?.tag !== "links" || (constraint.role?.kind === "roleType" && constraint.role.label.includes(":"))) return;
        const relation = graph.getNodeAttribute(source, "metadata")?.concept;
        const player = graph.getNodeAttribute(target, "metadata")?.concept;
        if (relation?.kind !== "relation" || (player?.kind !== "entity" && player?.kind !== "relation")) return;
        if (!/^0x[\da-f]+$/i.test(relation.iid) || !/^0x[\da-f]+$/i.test(player.iid)) return;
        pairs.set(`${relation.iid}/${player.iid}`, { relation: relation.iid, player: player.iid });
    });
    return [...pairs.values()];
}

export function resolveRoleEdges(graph: Graph, rows: ConceptRow[]): boolean {
    const roles = new Map<string, Map<string, RoleType>>();
    for (const row of rows) {
        const r = row["r"], p = row["p"], role = row["role"];
        if (r?.kind !== "relation" || (p?.kind !== "entity" && p?.kind !== "relation") || role?.kind !== "roleType") continue;
        const key = `${r.iid}/${p.iid}`, set = roles.get(key) ?? new Map();
        set.set(role.label, role); roles.set(key, set);
    }
    let changed = false;
    // Snapshot keys because one unresolved link can become several role edges.
    for (const edge of graph.edges()) {
        const attrs = graph.getEdgeAttributes(edge), constraint = attrs.metadata?.dataEdge;
        if (constraint?.tag !== "links" || (constraint.role?.kind === "roleType" && constraint.role.label.includes(":"))) continue;
        const source = graph.source(edge), target = graph.target(edge);
        const relation = graph.getNodeAttribute(source, "metadata")?.concept;
        const player = graph.getNodeAttribute(target, "metadata")?.concept;
        if (relation?.kind !== "relation" || (player?.kind !== "entity" && player?.kind !== "relation")) continue;
        const found = roles.get(`${relation.iid}/${player.iid}`);
        if (!found?.size) continue;
        const matches = [...found].filter(([label]) => constraint.role?.kind !== "roleType"
            || label.split(":").at(-1) === constraint.role.label);
        if (!matches.length) continue;
        let keptOriginal = false;
        for (const [label, role] of matches) {
            const metadata = { ...attrs.metadata, dataEdge: { ...constraint, role } };
            const next = { ...attrs, metadata };
            next.label = metadata.defaultLabel = edgeDisplayLabel(next);
            const exists = graph.directedEdges(source, target).some(key => {
                const other = graph.getEdgeAttributes(key).metadata?.dataEdge;
                return key !== edge && other?.tag === "links" && other.role?.kind === "roleType" && other.role.label === label;
            });
            if (!exists) {
                const key = `${source}:${target}:${label}`;
                if (key === edge) { graph.replaceEdgeAttributes(edge, next); keptOriginal = true; }
                else graph.addDirectedEdgeWithKey(key, source, target, next);
            }
        }
        if (!keptOriginal) graph.dropEdge(edge);
        changed = true;
    }
    return changed;
}
