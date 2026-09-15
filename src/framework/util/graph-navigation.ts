export type GraphNavigationMode = "normal" | "caret";
export type GraphCardinalDirection = "left" | "right" | "up" | "down";
export type GraphDirection = GraphCardinalDirection | "downLeft" | "upRight" | "upLeft" | "downRight";
export interface GraphNavigationPoint { key: string; x: number; y: number; halfWidth?: number; halfHeight?: number }

export const graphDirectionVectors: Record<GraphDirection, [number, number]> = {
    left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
    downLeft: [-Math.SQRT1_2, Math.SQRT1_2], upRight: [Math.SQRT1_2, -Math.SQRT1_2],
    upLeft: [-Math.SQRT1_2, -Math.SQRT1_2], downRight: [Math.SQRT1_2, Math.SQRT1_2],
};

/** Cardinal motions follow the next body in the visible column/row, then rank
 * a forward cone/half-plane with a threefold connection preference. Diagonal
 * motions prefer direct neighbours in the requested quadrant, then layout nodes;
 * they provide a way around intervening rows/columns without consulting history. */
export function directionalGraphNode(points: GraphNavigationPoint[], from: string, direction: GraphDirection, connected: ReadonlySet<string> = new Set()): string | null {
    const origin = points.find(point => point.key === from);
    if (!origin) return null;
    const [dx, dy] = graphDirectionVectors[direction];
    const diagonal = dx !== 0 && dy !== 0;
    const candidates = points.filter(point => point.key !== from && Number.isFinite(point.x) && Number.isFinite(point.y))
        .filter(point => !diagonal || ((point.x - origin.x) * dx > 1e-7 && (point.y - origin.y) * dy > 1e-7))
        .map(point => {
            const x = point.x - origin.x, y = point.y - origin.y;
            const forward = x * dx + y * dy, side = Math.abs(x * dy - y * dx);
            const originHalf = dx ? origin.halfHeight : origin.halfWidth;
            const targetHalf = dx ? point.halfHeight : point.halfWidth;
            const overlaps = !diagonal && !!originHalf && !!targetHalf && side < originHalf + targetHalf;
            return { key: point.key, forward, side, overlaps,
                score: Math.hypot(x, y) * (1 + 2 * (side / forward) ** 2) / (connected.has(point.key) ? 3 : 1) };
        }).filter(point => point.forward > 1e-7);
    const aligned = candidates.filter(point => point.overlaps);
    if (aligned.length) {
        // Advance one visible row/column at a time; centring on a farther node
        // must not skip an intermediate node whose body occupies this column.
        aligned.sort((a, b) => a.forward - b.forward || a.score - b.score || a.key.localeCompare(b.key));
        return aligned[0].key;
    }
    const neighbours = diagonal ? candidates.filter(point => connected.has(point.key)) : [];
    const cone = candidates.filter(point => point.side <= point.forward);
    const ranked = neighbours.length ? neighbours : cone.length ? cone : candidates;
    ranked.sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return ranked[0]?.key ?? null;
}

/** Spatial motions never consult history. The back command retraces prior visits;
 * neither operation owns or rewrites the shared highlight set. */
export class GraphNavigation {
    mode: GraphNavigationMode = "normal";
    caret: string | null = null;
    private history: string[] = [];

    enter(caret: string): void {
        this.reset();
        this.visit(caret);
    }

    /** Record motions and explicit pointer/search/hint jumps without duplicates. */
    visit(caret: string): void {
        if (this.caret === caret) return;
        if (this.caret) this.history.push(this.caret);
        if (this.history.length > 256) this.history.shift();
        this.mode = "caret";
        this.caret = caret;
    }

    reset(): void {
        this.mode = "normal";
        this.caret = null;
        this.history = [];
    }

    move(direction: GraphDirection, points: GraphNavigationPoint[], connected: ReadonlySet<string> = new Set()): boolean {
        if (!this.caret) return false;
        if (!points.some(point => point.key === this.caret)) { this.reset(); return false; }
        const next = directionalGraphNode(points, this.caret, direction, connected);
        if (!next) return false;
        this.visit(next);
        return true;
    }

    back(points: GraphNavigationPoint[]): boolean {
        if (!this.caret) return false;
        const available = new Set(points.map(point => point.key));
        if (!available.has(this.caret)) { this.reset(); return false; }
        while (this.history.length) {
            const previous = this.history.pop()!;
            if (previous === this.caret || !available.has(previous)) continue;
            this.caret = previous;
            return true;
        }
        return false;
    }
}

export type GraphSelectionEdit = "none" | "add" | "remove";
export function graphSelectionEdit(event: { shiftKey: boolean; altKey: boolean }): GraphSelectionEdit {
    return event.altKey ? "remove" : event.shiftKey ? "add" : "none";
}

// Avoid f so Vimium can retain its UI hints. All labels have the same length;
// two keys cover 49 on-screen nodes, with longer codes for denser graphs.
export const GRAPH_HINT_ALPHABET = "asdhjkl";
export interface GraphNodeHint extends GraphNavigationPoint { label: string }
export function graphNodeHints(points: GraphNavigationPoint[]): GraphNodeHint[] {
    const ordered = [...points].sort((a, b) => a.y - b.y || a.x - b.x || a.key.localeCompare(b.key));
    let length = 2;
    while (GRAPH_HINT_ALPHABET.length ** length < ordered.length) length++;
    return ordered.map((point, index) => {
        let label = "";
        for (let n = 0; n < length; n++) {
            label = GRAPH_HINT_ALPHABET[index % GRAPH_HINT_ALPHABET.length] + label;
            index = Math.floor(index / GRAPH_HINT_ALPHABET.length);
        }
        return { ...point, label };
    });
}
