export interface GraphSelectionSnapshot {
    active: boolean;
    nodes: string[];
    neighborhoods?: { base: string[]; groups: [string, string[]][] };
}

/** One result-local node selection, shared by finder, type chips, and Explorer. */
export class GraphElementSelection {
    active: boolean;
    readonly nodes: Set<string>;
    revision = 0;

    private neighborhoods: GraphSelectionSnapshot["neighborhoods"];

    private changed: (state: GraphSelectionSnapshot) => void;

    constructor(snapshot?: GraphSelectionSnapshot, changed: (state: GraphSelectionSnapshot) => void = () => {}) {
        this.changed = changed;
        this.active = snapshot?.active ?? false;
        this.nodes = new Set(snapshot?.nodes ?? []);
        const groups = snapshot?.neighborhoods;
        if (groups && Array.isArray(groups.base) && groups.base.every(key => typeof key === "string") &&
            Array.isArray(groups.groups) && groups.groups.every(entry => Array.isArray(entry) &&
                typeof entry[0] === "string" && Array.isArray(entry[1]) && entry[1].every(key => typeof key === "string"))) {
            this.neighborhoods = { base: [...groups.base], groups: groups.groups.map(([anchor, keys]) => [anchor, [...keys]]) };
        }
    }

    status(keys: string[]): "none" | "partial" | "all" {
        const count = keys.filter(key => this.nodes.has(key)).length;
        return count === 0 ? "none" : count === keys.length ? "all" : "partial";
    }

    toggle(keys: string[]): void { this.set(keys, this.status(keys) !== "all"); }

    set(keys: string[], selected: boolean): void {
        this.neighborhoods = undefined;
        this.active = true;
        for (const key of keys) selected ? this.nodes.add(key) : this.nodes.delete(key);
        this.publish();
    }

    replace(keys: string[]): void {
        this.nodes.clear();
        this.set(keys, true);
    }

    clear(): void {
        this.neighborhoods = undefined;
        this.active = false;
        this.nodes.clear();
        this.publish();
    }

    /** Preserve overlap and pre-existing explicit selection when toggling a group off.
     * A plain inspected node can seed the first group when no explicit selection exists.
     * Finder/type-chip edits deliberately establish a new base via set/replace/clear.
     */
    toggleNeighborhood(anchor: string, keys: string[], initial?: [string, string[]]): void {
        if (!this.neighborhoods) {
            this.neighborhoods = { base: this.active ? [...this.nodes] : [], groups: !this.active && initial ? [initial] : [] };
        }
        const groups = new Map(this.neighborhoods.groups);
        if (groups.has(anchor)) groups.delete(anchor);
        else groups.set(anchor, [...new Set([anchor, ...keys])]);
        this.neighborhoods.groups = [...groups];
        this.nodes.clear();
        for (const key of [...this.neighborhoods.base, ...[...groups.values()].flat()]) this.nodes.add(key);
        this.active = true;
        this.publish();
    }

    private publish(): void {
        this.revision++;
        const snapshot: GraphSelectionSnapshot = { active: this.active, nodes: [...this.nodes] };
        if (this.neighborhoods) snapshot.neighborhoods = {
            base: [...this.neighborhoods.base],
            groups: this.neighborhoods.groups.map(([anchor, keys]) => [anchor, [...keys]]),
        };
        this.changed(snapshot);
    }
}
