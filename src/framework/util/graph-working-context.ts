import type { Graph } from "../graph-visualiser/engine/graph";
import type { GraphSnap } from "./graph-snap";

/** One reversible working subset. No nested graph attributes or layout simulation. */
export interface GraphWorkingContext {
    nodes: GraphSnap["graph"]["nodes"];
    edges: GraphSnap["graph"]["edges"];
    camera: GraphSnap["view"]["camera"];
    bbox: GraphSnap["view"]["bbox"];
}

export function rememberWorkingContext(graph: Graph, view: Pick<GraphWorkingContext, "camera" | "bbox">): void {
    if (graph.getAttribute("workingContext")) return;
    const { nodes, edges } = graph.export();
    graph.setAttribute("workingContext", structuredClone({ nodes, edges, ...view }));
}

/** Restore original topology/positions while retaining newly explored nodes and current styling. */
export function restoreWorkingContext(graph: Graph): GraphWorkingContext | undefined {
    const context = graph.getAttribute("workingContext");
    if (!context) return;
    const saved = structuredClone(context);
    graph.import({ nodes: saved.nodes.filter(node => !graph.hasNode(node.key)),
        edges: saved.edges.filter(edge => !graph.hasEdge(edge.key!)) });
    for (const node of saved.nodes) {
        graph.mergeNodeAttributes(node.key, { x: node.attributes!.x, y: node.attributes!.y });
    }
    graph.removeAttribute("workingContext");
    return saved;
}
