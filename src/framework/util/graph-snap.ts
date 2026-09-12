import type { Graph } from "../graph-visualiser/engine/graph";
import type { CustomPreset } from "../../service/graph-style.service";
import type { GraphSnapshotContext } from "../../service/graph-snapshot.service";
import { parseGraphPresets } from "./graph-presets";

export interface GraphSnap {
    format: "typedb-studio-graph-snap";
    version: 1;
    createdAt: string;
    query: string;
    expansionQueries: string[];
    database?: string;
    project?: GraphSnapshotContext;
    schemaMode: boolean;
    graph: ReturnType<Graph["export"]>;
    style: CustomPreset;
    view: {
        camera: { x: number; y: number; ratio: number; angle: number };
        bbox: { x: [number, number]; y: [number, number] };
        viewport: { width: number; height: number };
        finderText?: string;
        typeFilter?: string;
        layoutDensity?: "spacious" | "default" | "compact";
        searchTerm: string;
        finderMatches: string[] | null;
        selectedNode: string | null;
        selectedNeighbors: string[];
        highlightedEdges: string[];
        highlightedTypes: string[];
        highlightedKinds: string[];
    };
    labels: { attributes: [string, [string, unknown[]][]][]; overrides: [string, string][] };
}

/** Validate before allocating a renderer or changing any current graph. */
export function parseGraphSnap(text: string): GraphSnap {
    if (text.length > 64 * 1024 * 1024) throw new Error("Snap exceeds 64 MiB.");
    const snap = JSON.parse(text, (key, value) => {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid snap key.");
        return value;
    }) as GraphSnap;
    const fail = () => { throw new Error("Invalid or unsupported graph snap."); };
    const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
    const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every(s => typeof s === "string");
    if (!snap || snap.format !== "typedb-studio-graph-snap" || snap.version !== 1 || typeof snap.query !== "string"
        || typeof snap.createdAt !== "string" || typeof snap.schemaMode !== "boolean" || !strings(snap.expansionQueries)
        || !Array.isArray(snap.graph?.nodes) || !snap.graph.nodes.length || snap.graph.nodes.length > 100000
        || !Array.isArray(snap.graph.edges) || snap.graph.edges.length > 500000) fail();
    const color = (v: unknown) => typeof v === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v);
    const keys = new Set<string>();
    for (const node of snap.graph.nodes) {
        const a = node.attributes;
        if (typeof node.key !== "string" || keys.has(node.key) || !a || !finite(a.x) || !finite(a.y)
            || ![a.size, a.width, a.height].every(n => finite(n) && n > 0) || !color(a.color) || !color(a.borderColor) || typeof a.label !== "string"
            || !a.metadata?.concept || typeof a.metadata.concept.kind !== "string"
            || !["rounded-rect", "diamond", "hexagon", "ellipse"].includes(a.type)) fail();
        keys.add(node.key);
    }
    const edgeKeys = new Set<string>();
    for (const edge of snap.graph.edges) {
        if (typeof edge.key !== "string" || edgeKeys.has(edge.key) || !keys.has(edge.source) || !keys.has(edge.target)
            || !edge.attributes || !color(edge.attributes.color) || !finite(edge.attributes.size) || edge.attributes.size < 0 || !["line", "curved"].includes(edge.attributes.type)) fail();
        edgeKeys.add(edge.key!);
    }
    const v = snap.view;
    if (!v || !v.camera || ![v.camera.x, v.camera.y, v.camera.angle, v.camera.ratio].every(finite) || v.camera.ratio <= 0
        || !v.bbox || ![v.bbox.x, v.bbox.y].every(a => Array.isArray(a) && a.length === 2 && a.every(finite) && a[0] <= a[1])
        || !v.viewport || ![v.viewport.width, v.viewport.height].every(n => finite(n) && n > 0)
        || typeof v.searchTerm !== "string" || (v.finderMatches !== null && !strings(v.finderMatches))
        || (v.selectedNode !== null && !keys.has(v.selectedNode)) || !strings(v.selectedNeighbors)
        || !strings(v.highlightedEdges) || !strings(v.highlightedKinds) || !strings(v.highlightedTypes)) fail();
    if ((v.finderText !== undefined && typeof v.finderText !== "string") || (v.typeFilter !== undefined && typeof v.typeFilter !== "string")) fail();
    if (v.layoutDensity !== undefined && !["spacious", "default", "compact"].includes(v.layoutDensity)) fail();
    if (v.finderMatches?.some(k => !keys.has(k)) || v.selectedNeighbors.some(k => !keys.has(k))) fail();
    const selection = snap.graph.attributes?.elementSelection;
    if (selection && (typeof selection.active !== "boolean" || !strings(selection.nodes) || selection.nodes.some(k => !keys.has(k)))) fail();
    if (!snap.labels || !Array.isArray(snap.labels.attributes) || !Array.isArray(snap.labels.overrides)) fail();
    if (!snap.labels.attributes.every(entry => Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])
        && entry[1].every(attr => Array.isArray(attr) && typeof attr[0] === "string" && Array.isArray(attr[1])))
        || !snap.labels.overrides.every(entry => Array.isArray(entry) && entry.length === 2 && strings(entry))) fail();
    if (snap.database !== undefined && typeof snap.database !== "string") fail();
    if (snap.project && (typeof snap.project.database !== "string" || typeof snap.project.projectTempDirectory !== "string")) fail();
    snap.style = parseGraphPresets(JSON.stringify(snap.style))[0];
    return snap;
}
