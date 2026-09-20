import { tokens, isGraphContextRelationCompatible } from "./graph-query";
import type { GraphQueryOptions } from "./graph-query";
import type { Schema, SchemaConcept } from "../../service/schema-state.service";

export interface EditorExecution {
    kind: "read" | "write" | "schema";
    status: "success" | "error" | "unknown";
    error?: string;
}
export interface OperationContext { query: string; note: string; schemaMode: boolean; }
interface Seed { variable?: string; type: SchemaConcept; filters: string[]; }

/** Extract only known types and literal ownership constraints. Never replay source stages. */
function seeds(source: string, schema: Schema): Seed[] {
    const all = tokens(source, true, true);
    const byLabel = (label: string) => schema.entities[label] ?? schema.relations[label] ?? schema.attributes[label];
    const found: Seed[] = [];
    const byVariable = new Map<string, Seed>();
    for (let i = 0; i < all.length; i++) {
        const t = all[i];
        if (t.kind === "variable" && all[i + 1]?.text === "isa") {
            const label = all[i + 2]?.text === "!" ? all[i + 3]?.text : all[i + 2]?.text;
            const type = byLabel(label);
            if (type) { const seed = { variable: t.text, type, filters: [] }; found.push(seed); byVariable.set(t.text, seed); }
        } else if (t.kind === "word" && all[i + 1]?.text === "(" && schema.relations[t.text]) {
            found.push({ type: schema.relations[t.text], filters: [] });
        }
    }
    let owner: Seed | undefined;
    for (let i = 0; i < all.length; i++) {
        const t = all[i];
        if (t.text === ";") owner = undefined;
        if (t.kind === "variable" && ["isa", "has"].includes(all[i + 1]?.text)) owner = byVariable.get(t.text);
        if (!owner || t.text !== "has" || owner.type.kind === "attributeType") continue;
        const attr = all[i + 1];
        const value = all[i + 2];
        if (!attr || !value || !owner.type.ownedAttributes.some(a => a.label === attr.text)) continue;
        const literal = value.kind === "literal" && value.text[0] !== "`" ? value.text
            : /^(?:true|false)$/.test(value.text) ? value.text
            : /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s*[,;])/.exec(source.slice(value.from))?.[0];
        if (literal) owner.filters.push(`has ${attr.text} ${literal}`);
    }
    // Failed parses/unbound mutations can still supply useful known type names.
    if (!found.length) {
        for (const t of all) if (t.kind === "word" && byLabel(t.text)) found.push({ type: byLabel(t.text), filters: [] });
    }
    return found;
}

export function operationTypes(source: string, schema: Schema): SchemaConcept[] {
    return [...new Map(seeds(source, schema).map(s => [s.type.label, s.type])).values()];
}

export function prepareSchemaContext(source: string, options: GraphQueryOptions, schema: Schema): OperationContext {
    const all = tokens(source, true);
    const types = { ...schema.entities, ...schema.relations, ...schema.attributes };
    const declarations = all.flatMap((t, i) => ["entity", "relation", "attribute"].includes(t.text)
        && types[all[i + 1]?.text] ? [types[all[i + 1].text]] : []);
    const selected = [...new Map((declarations.length ? declarations : all.flatMap(t =>
        t.kind === "word" && types[t.text] ? [types[t.text]] : [])).map(t => [t.label, t])).values()];
    if (!selected.length) throw new Error("No referenced types exist in the current schema. The previous graph is kept; see the Neovim result for the original error.");
    return schemaContextForTypes(selected, options, schema);
}

/** Shared by editor context and additive schema Explorer reads. */
export function schemaContextForTypes(selected: SchemaConcept[], options: GraphQueryOptions, schema: Schema): OperationContext {
    let query = `match\n${selected.map(t => `{ $type label ${t.label}; }`).join(" or\n")};`;
    if (options.neighbours) {
        const owners = selected.filter(t => t.kind !== "attributeType");
        const rels = selected.filter(t => t.kind === "relationType");
        const filter = options.relationTypes?.filter(label => !!schema.relations[label]) ?? [];
        const allowed = (variable: string) => filter.length ? ` ${filter.map(label => `{ ${variable} label ${label}; }`).join(" or ")};` : "";
        if (owners.some(t => t.ownedAttributes.length)) query += "\ntry { $type owns $attribute; };";
        if (owners.some(t => t.playedRoles.length)) query += `\ntry { $type plays $played; $relation relates $played;${allowed("$relation")} };`;
        if (rels.some(t => t.relatedRoles.length)) {
            query += "\ntry { $type relates $role; };";
            const played = [...Object.values(schema.entities), ...Object.values(schema.relations)].flatMap(t => t.playedRoles.map(r => r.label));
            if (rels.some(t => t.relatedRoles.some(r => played.includes(r.label)))) query += "\ntry { $type relates $player_role; $player plays $player_role; };";
        }
        if (selected.some(t => t.supertype)) query += "\ntry { $type sub! $supertype; };";
        if (selected.some(t => t.subtypes.length)) query += "\ntry { $subtype sub! $type; };";
        if (selected.some(t => t.kind === "attributeType" && [...Object.values(schema.entities), ...Object.values(schema.relations)].some(o => o.ownedAttributes.some(a => a.label === t.label)))) query += "\ntry { $owner owns $type; };";
    }
    return { query, schemaMode: true, note: `Schema context for ${selected.map(t => t.label).join(", ")}${options.neighbours ? " and connected types" : ""}.` };
}

export function prepareOperationContext(source: string, execution: EditorExecution, options: GraphQueryOptions, schema: Schema): OperationContext {
    if (execution.kind === "schema") return prepareSchemaContext(source, options, schema);
    let selected = seeds(source, schema);
    if (options.seedVariable?.trim()) {
        selected = selected.filter(s => s.variable === options.seedVariable!.trim());
        if (!selected.length) throw new Error("That seed variable has no known type in this statement. Clear it to show all referenced types.");
    }
    if (!selected.length) return prepareSchemaContext(source, options, schema);
    const branches = [...new Set(selected.map(s => {
        // Identifier-like literals make duplicate-key failures useful even when a title changed.
        const ids = s.filters.filter(f => /^has (?:id|identifier|uuid|[\w-]+[-_](?:id|identifier))\s/i.test(f));
        const filters = ids.length ? ids : s.filters;
        return `{ $item isa ${s.type.label}${filters.length ? ", " + filters.join(", ") : ""}; }`;
    }))];
    let query = `match\n${branches.join(" or\n")};`;
    if (options.neighbours) {
        const types = selected.map(s => s.type);
        if (types.some(t => t.kind === "relationType" && t.relatedRoles.length)) query += "\ntry { $item links ($nvim_own_role: $nvim_player); };";
        const eligible = types.filter(t => t.kind === "entityType" || t.kind === "relationType").filter(t => t.playedRoles.length);
        const requested = options.relationTypes ?? [];
        const compatible = requested.filter(label => schema.relations[label] && eligible.some(type =>
            isGraphContextRelationCompatible({ variable: "$item", type: { ...type, kind: "entityType" }, exact: false }, schema.relations[label])));
        if (eligible.length && (!requested.length || compatible.length)) {
            const filter = compatible.length ? " " + compatible.map(label => `{ $nvim_relation isa ${label}; }`).join(" or ") + ";" : "";
            query += `\ntry { $nvim_relation links ($nvim_role: $item);${filter} $nvim_relation links ($nvim_other_role: $nvim_other); };`;
        }
    }
    return { query, schemaMode: false, note: "Existing data matching referenced types and literal attributes; unnamed relations are selected by type. This is context, not a record of which instances were newly created." };
}
