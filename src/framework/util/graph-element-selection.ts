export interface GraphSelectionSnapshot { active: boolean; nodes: string[]; }

/** One result-local node selection, shared by finder, type chips, and Explorer. */
export class GraphElementSelection {
    active: boolean;
    readonly nodes: Set<string>;
    revision = 0;

    private changed: (state: GraphSelectionSnapshot) => void;

    constructor(snapshot?: GraphSelectionSnapshot, changed: (state: GraphSelectionSnapshot) => void = () => {}) {
        this.changed = changed;
        this.active = snapshot?.active ?? false;
        this.nodes = new Set(snapshot?.nodes ?? []);
    }

    status(keys: string[]): "none" | "partial" | "all" {
        const count = keys.filter(key => this.nodes.has(key)).length;
        return count === 0 ? "none" : count === keys.length ? "all" : "partial";
    }

    toggle(keys: string[]): void { this.set(keys, this.status(keys) !== "all"); }

    set(keys: string[], selected: boolean): void {
        this.active = true;
        for (const key of keys) selected ? this.nodes.add(key) : this.nodes.delete(key);
        this.publish();
    }

    replace(keys: string[]): void {
        this.nodes.clear();
        this.set(keys, true);
    }

    clear(): void {
        this.active = false;
        this.nodes.clear();
        this.publish();
    }

    private publish(): void {
        this.revision++;
        this.changed({ active: this.active, nodes: [...this.nodes] });
    }
}
