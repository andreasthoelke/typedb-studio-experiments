import { tokens } from "./typeql-tokens.mjs";

/** Annotations read from the database's schema dump. `@meta("key", "value")`
 * carries the schema author's visual decisions; `@key`/`@unique` on owns
 * clauses are identifying attributes. Nothing here queries the database. */
export interface SchemaMeta {
    /** Type label → meta entries. */
    types: Record<string, Record<string, string>>;
    /** Scoped role label (relation:role) from `relates` clauses → meta entries. */
    roles: Record<string, Record<string, string>>;
    /** Owner type label → attribute labels owned with @key or @unique. */
    identifying: Record<string, string[]>;
}

export type RoleArrowDirection = "none" | "relation" | "player";
export const ROLE_ARROW_META = "graph-arrow";
export const LABEL_META = "graph-label";

interface HierarchyType { label: string; supertype?: HierarchyType }
export interface MetaHierarchy {
    entities: Record<string, HierarchyType>;
    relations: Record<string, HierarchyType>;
    attributes: Record<string, HierarchyType>;
}

type Tok = { text: string; depth: number; kind: string };
const unquote = (literal: string) => literal.slice(1, -1).replace(/\\(.)/g, "$1");
const labelText = (t?: Tok) => t?.kind === "word" ? t.text : t?.kind === "literal" && t.text.startsWith("`") ? unquote(t.text) : undefined;

/** Annotations in a clause segment, each with its name, literal arguments and
 * the index of its `@`. */
function annotations(segment: Tok[]): { name: string; args: string[]; at: number }[] {
    const found: { name: string; args: string[]; at: number }[] = [];
    for (let i = 0; i < segment.length; i++) {
        if (segment[i].text !== "@" || segment[i + 1]?.kind !== "word") continue;
        const name = segment[i + 1].text, args: string[] = [];
        if (segment[i + 2]?.text === "(") {
            const depth = segment[i + 2].depth;
            for (let j = i + 3; j < segment.length && !(segment[j].text === ")" && segment[j].depth === depth); j++) {
                if (segment[j].kind === "literal" && /^["']/.test(segment[j].text)) args.push(unquote(segment[j].text));
            }
        }
        found.push({ name, args, at: i });
    }
    return found;
}

const metaOf = (list: { name: string; args: string[] }[]): Record<string, string> | null => {
    const entries = list.filter(a => a.name === "meta" && a.args.length >= 2).map(a => [a.args[0], a.args[1]] as const);
    return entries.length ? Object.fromEntries(entries) : null;
};

export function parseSchemaMeta(text: string): SchemaMeta {
    const meta: SchemaMeta = { types: {}, roles: {}, identifying: {} };
    let all: Tok[];
    try { all = tokens(text, true, true); } catch { return meta; }
    const statements: Tok[][] = [];
    let current: Tok[] = [];
    for (const token of all) {
        if (token.text === ";" && token.depth === 0) { statements.push(current); current = []; }
        else current.push(token);
    }
    if (current.length) statements.push(current);
    for (let statement of statements) {
        while (["define", "redefine"].includes(statement[0]?.text)) statement = statement.slice(1);
        if (!statement.length || statement[0].text === "fun" || statement[0].text === "struct") continue;
        const kinded = ["entity", "relation", "attribute"].includes(statement[0].text);
        const label = labelText(statement[kinded ? 1 : 0]);
        if (!label || (!kinded && statement[1]?.text !== "sub")) continue;
        const segments: Tok[][] = [[]];
        for (const token of statement.slice(kinded ? 2 : 1)) {
            if (token.text === "," && token.depth === 0) segments.push([]);
            else segments.at(-1)!.push(token);
        }
        const [head, ...clauses] = segments;
        // Annotations after `sub X` or `value T` belong to that edge, not the type.
        const edge = head.findIndex(t => t.depth === 0 && (t.text === "sub" || t.text === "value"));
        const typeMeta = metaOf(annotations(edge < 0 ? head : head.slice(0, edge)));
        if (typeMeta) meta.types[label] = { ...meta.types[label], ...typeMeta };
        for (const clause of clauses) {
            const keyword = clause[0]?.text, list = annotations(clause);
            if (keyword === "relates") {
                const role = labelText(clause[1]);
                const clauseMeta = metaOf(list);
                if (role && clauseMeta) meta.roles[`${label}:${role}`] = { ...meta.roles[`${label}:${role}`], ...clauseMeta };
            } else if (keyword === "owns") {
                const attribute = labelText(clause[1]);
                if (attribute && list.some(a => a.name === "key" || a.name === "unique")) (meta.identifying[label] ??= []).push(attribute);
            }
        }
    }
    return meta;
}

/** Resolves schema defaults through the type hierarchy. */
export class SchemaDefaults {
    readonly meta: SchemaMeta;
    private readonly schema: MetaHierarchy | null;
    constructor(meta: SchemaMeta, schema: MetaHierarchy | null) { this.meta = meta; this.schema = schema; }

    private lineage(label: string): string[] {
        const labels: string[] = [];
        let type: HierarchyType | null | undefined = this.schema && (this.schema.entities[label] ?? this.schema.relations[label] ?? this.schema.attributes[label]);
        if (!type) return [label];
        const seen = new Set<string>();
        for (; type && !seen.has(type.label); type = type.supertype) { seen.add(type.label); labels.push(type.label); }
        return labels;
    }

    /** Role `@meta("graph-arrow", …)` first, then the relation and its supertypes. */
    arrow(roleKey: string): RoleArrowDirection | undefined {
        const valid = (value?: string) => value === "none" || value === "relation" || value === "player" ? value : undefined;
        const role = valid(this.meta.roles[roleKey]?.[ROLE_ARROW_META]);
        if (role || !roleKey.includes(":")) return role;
        for (const relation of this.lineage(roleKey.split(":")[0])) {
            const value = valid(this.meta.types[relation]?.[ROLE_ARROW_META]);
            if (value) return value;
        }
        return undefined;
    }

    /** `@meta("graph-label", "title")`, `"title, scene-id"` or `"none"`, inherited. */
    label(typeLabel: string): string | undefined {
        for (const label of this.lineage(typeLabel)) {
            const value = this.meta.types[label]?.[LABEL_META]?.trim();
            if (value) return value;
        }
        return undefined;
    }

    identifying(typeLabel: string): Set<string> {
        return new Set(this.lineage(typeLabel).flatMap(label => this.meta.identifying[label] ?? []));
    }
}

/** A label choice is a comma-separated list of attribute types; `none` (or
 * `-`) shows only the type label. */
export function labelAttributes(choice: string): string[] {
    const value = choice.trim();
    if (value === "none" || value === "-") return [];
    return value.split(",").map(part => part.trim()).filter(Boolean);
}
