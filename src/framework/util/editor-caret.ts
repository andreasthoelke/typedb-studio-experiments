import { tokens, type Token } from "./graph-query";
import type { Schema } from "../../service/schema-state.service";

export interface EditorCaretRequest {
    id: string;
    source: string;
    /** Zero-based paragraph line and UTF-16 column. */
    line: number;
    column: number;
    schemaOnly: boolean;
    database?: string;
}
export interface EditorInstanceTarget {
    variable?: string;
    typeLabel?: string;
    iid?: string;
    attributes: { label: string; literal: string }[];
    players?: { role?: string; variable: string }[];
    attributeVariables?: { label: string; variable: string }[];
}
export interface EditorCaretTarget {
    schemaLabels: string[];
    identifier: string;
    instance?: EditorInstanceTarget;
    context?: { focus: string; bindings: Record<string, EditorInstanceTarget> };
    /** A schema relates/plays/owns clause: its read is exact, with no broader fallback. */
    clause?: "relates" | "plays" | "owns";
}
const labelOf = (t?: Token) => t?.kind === "word" ? t.text : t?.kind === "literal" && t.text.startsWith("`") ? t.text.slice(1, -1) : undefined;
const quotedLabel = (label: string) => /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(label) ? label : `\`${label.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;

/** Resolve a deliberately small, useful subset of TypeQL without executing the
 * source. Strings/comments cannot become names, variables remain paragraph-local,
 * and a relation's role players cannot accidentally inherit the relation's has. */
export function editorCaretTarget(request: Pick<EditorCaretRequest, "source" | "line" | "column">, schema: Schema): EditorCaretTarget | null {
    const { source, line, column } = request;
    const lines = source.split("\n");
    if (line < 0 || line >= lines.length || column < 0) return null;
    const start = lines.slice(0, line).reduce((n, text) => n + text.length + 1, 0), end = start + lines[line].length;
    const cursor = start + column;
    const all = tokens(source, true, true);
    const types = { ...schema.entities, ...schema.relations, ...schema.attributes };
    const roles = new Set(Object.values(schema.relations).flatMap(r => r.relatedRoles.map(role => role.label)));
    const known = (t?: Token) => { const name = labelOf(t); return name && Object.hasOwn(types, name) ? name : undefined; };
    const statements: Token[][] = []; let statement: Token[] = [];
    for (const token of all) {
        statement.push(token);
        if (token.text === ";" && token.depth === 0) { statements.push(statement); statement = []; }
    }
    if (statement.length) statements.push(statement);
    const bindings = new Map<string, EditorInstanceTarget>();
    const statementOwners = new Map<Token[], string>();
    for (const statement of statements) {
        const top = statement.filter(t => t.depth === 0);
        const ownerIndex = top.findIndex(t => t.kind === "variable");
        const head = top.findIndex(t => !["match", "insert", "put", "update"].includes(t.text));
        const anonymous = head >= 0 && !!known(top[head]) && Object.hasOwn(schema.relations, known(top[head])!) && top[head + 1]?.text === "(";
        if (!anonymous && ownerIndex < 0) continue;
        const owner = anonymous ? { text: `@relation${top[head].from}` } : top[ownerIndex];
        // Only a variable at the head of a statement owns its constraints.
        if (!anonymous && top.slice(0, ownerIndex).some(t => !["match", "insert", "put", "update"].includes(t.text))) continue;
        const binding: EditorInstanceTarget = bindings.get(owner.text) ?? { variable: owner.text, attributes: [] };
        if (anonymous) binding.typeLabel = known(top[head]);
        for (let i = anonymous ? head + 1 : ownerIndex + 1; i < top.length; i++) {
            const t = top[i];
            if (t.text === "isa") binding.typeLabel = known(top[i + (top[i + 1]?.text === "!" ? 2 : 1)]) ?? binding.typeLabel;
            if (t.text === "iid") binding.iid = /^\s*(0x[\da-fA-F]+)\b/.exec(source.slice(t.from + 3))?.[1];
            if (t.text === "has") {
                const name = known(top[i + 1]), value = top[i + 2];
                if (name && Object.hasOwn(schema.attributes, name) && value?.kind === "literal" && /^['"]/.test(value.text)) {
                    binding.attributes.push({ label: name, literal: value.text });
                }
                if (name && Object.hasOwn(schema.attributes, name) && value?.kind === "variable") {
                    (binding.attributeVariables ??= []).push({ label: name, variable: value.text });
                    bindings.set(value.text, { ...bindings.get(value.text), variable: value.text, typeLabel: name, attributes: [] });
                }
            }
        }
        if (binding.typeLabel && Object.hasOwn(schema.relations, binding.typeLabel)) {
            const open = top.find(t => t.text === "(" && (anonymous || ["links", binding.typeLabel!].includes(top[top.indexOf(t) - 1]?.text)));
            if (open) {
                const close = statement.find(t => t.from > open.from && t.text === ")" && t.depth === 0);
                const tuple = statement.filter(t => t.from > open.from && (!close || t.from < close.from) && t.depth === 1);
                binding.players = [];
                for (let i = 0; i < tuple.length; i++) if (tuple[i].kind === "variable") {
                    const role = tuple[i - 1]?.text === ":" ? labelOf(tuple[i - 2]) : undefined;
                    // Retain the role constraint, including inherited roles.
                    // TypeDB rejects an unknown role instead of broadening the read.
                    binding.players.push({ ...(role ? { role } : {}), variable: tuple[i].text });
                }
            }
        }
        bindings.set(owner.text, binding);
        statementOwners.set(statement, owner.text);
    }
    for (const binding of [...bindings.values()]) for (const player of binding.players ?? []) {
        if (!bindings.has(player.variable)) bindings.set(player.variable, { variable: player.variable, attributes: [] });
    }
    const onLine = all.filter(t => t.from >= start && t.from < end);
    const inStatement = statements.find(s => s.some(t => t.from <= cursor && t.from + t.text.length > cursor))
        ?? statements.find(s => s.some(t => t.from >= cursor && t.from < end));
    const relationName = inStatement?.map(t => known(t)).find(name => !!name && Object.hasOwn(schema.relations, name));
    const roleName = (t: Token) => {
        const label = labelOf(t); if (!label) return undefined;
        const index = all.indexOf(t);
        const scoped = all[index - 1]?.text === ":" ? `${labelOf(all[index - 2])}:${label}`
            : all[index + 1]?.text === ":" && labelOf(all[index + 2]) ? `${label}:${labelOf(all[index + 2])}`
            : relationName && (all[index - 1]?.text === "relates" ||
                (t.depth > 0 && all[index + 1]?.text === ":" && all[index + 2]?.kind === "variable"))
                ? `${relationName}:${label}` : undefined;
        return scoped && roles.has(scoped) ? scoped : undefined;
    };
    const target = onLine.find(t => t.from + t.text.length > cursor &&
        (t.kind === "variable" || !!known(t) || !!roleName(t)));
    // A string under the cursor refers to its preceding attribute name.
    const literal = onLine.find(t => t.kind === "literal" && /^['"]/.test(t.text) && t.from <= cursor && t.from + t.text.length > cursor);
    const attribute = literal ? known(all[all.indexOf(literal) - 1]) : undefined;
    if (!target && !attribute) return null;
    const schemaLabel = attribute ?? (target && (roleName(target) ?? known(target)));
    const owner = inStatement && statementOwners.get(inStatement);
    // A tuple role (and `links` immediately before it) points to its player in
    // Query and to the scoped role in Schema. The relation name keeps its owner.
    const targetIndex = target ? all.indexOf(target) : -1;
    const player = target && target.depth > 0 && roleName(target) && all[targetIndex + 1]?.text === ":"
        && all[targetIndex + 2]?.kind === "variable" ? all[targetIndex + 2].text : undefined;
    const variable = player ?? (target?.kind === "variable" ? target.text : owner);
    // In a schema declaration, a relates/plays/owns clause is illustrated by
    // the instances that actually use it: the players of that role, or the
    // declared type's owners of that attribute. Schema still carets the label.
    const clause = !variable && target && inStatement && schemaLabel ? declarationClause(inStatement, target, schemaLabel, known, schema) : null;
    if (clause) return { schemaLabels: [schemaLabel!], identifier: target!.text, instance: clause.context.bindings[clause.context.focus],
        context: clause.context, clause: clause.keyword };
    // A direct schema name also identifies visible instances of that type. A
    // scoped role identifies its relation; an unresolved variable stays unresolved.
    const instance = variable ? bindings.get(variable) : schemaLabel ? {
        typeLabel: roles.has(schemaLabel) ? schemaLabel.split(":")[0] : schemaLabel, attributes: [],
    } : undefined;
    const schemaLabels = schemaLabel ? [schemaLabel] : instance?.typeLabel ? [instance.typeLabel]
        : instance && variable ? inferredPlayerTypes(variable, instance, bindings, schema) : [];
    return { schemaLabels, identifier: attribute ?? target!.text, instance,
        ...(variable && instance ? { context: { focus: variable, bindings: Object.fromEntries(bindings) } } : {}) };
}

/** `relation R, relates r` → players of R:r; `entity T, plays R:r` → the T
 * instances playing it; `entity T, owns a` → T instances owning a. Only the
 * clause keyword immediately governing the cursor counts, so the declared
 * type name itself (and `sub` parents) keep their plain type illustration. */
function declarationClause(statement: Token[], target: Token, schemaLabel: string,
    known: (t?: Token) => string | undefined, schema: Schema): { keyword: "relates" | "plays" | "owns"; context: NonNullable<EditorCaretTarget["context"]> } | null {
    const top = statement.filter(t => t.depth === 0);
    if (top.some(t => t.kind === "variable")) return null;
    let head = 0;
    while (["define", "redefine", "undefine"].includes(top[head]?.text)) head++;
    const declared = ["entity", "relation", "attribute"].includes(top[head]?.text) ? known(top[head + 1])
        : top[head + 1]?.text === "sub" ? known(top[head]) : undefined;
    const index = top.indexOf(target);
    if (!declared || index < 0) return null;
    let keyword: string | undefined;
    for (let i = index - 1; i > head && top[i].text !== ","; i--) {
        if (["relates", "plays", "owns", "sub"].includes(top[i].text)) { keyword = top[i].text; break; }
    }
    const role = schemaLabel.includes(":") ? schemaLabel.split(":") : null;
    const focus = "$focus";
    if ((keyword === "relates" || keyword === "plays") && role) {
        const [relation, name] = role;
        return { keyword, context: { focus, bindings: {
            [focus]: { variable: focus, ...(keyword === "plays" ? { typeLabel: declared } : {}), attributes: [] },
            "$relation": { variable: "$relation", typeLabel: relation, attributes: [], players: [{ role: name, variable: focus }] },
        } } };
    }
    if (keyword === "owns" && Object.hasOwn(schema.attributes, schemaLabel) && !Object.hasOwn(schema.attributes, declared)) {
        return { keyword, context: { focus, bindings: {
            [focus]: { variable: focus, typeLabel: declared, attributes: [], attributeVariables: [{ label: schemaLabel, variable: "$value" }] },
            "$value": { variable: "$value", typeLabel: schemaLabel, attributes: [] },
        } } };
    }
    return null;
}

/** Infer a has-only player's possible types from its roles and ownership,
 * including inherited plays/owns. Never guess from the variable's spelling. */
function inferredPlayerTypes(variable: string, instance: EditorInstanceTarget,
    bindings: Map<string, EditorInstanceTarget>, schema: Schema): string[] {
    const requiredRoles = [...bindings.values()].flatMap(binding => (binding.players ?? [])
        .filter(p => p.variable === variable && p.role && binding.typeLabel)
        .map(p => {
            let relation = schema.relations[binding.typeLabel!];
            while (relation) {
                const role = relation.relatedRoles.find(r => r.label.split(":").at(-1) === p.role);
                if (role) return role.label;
                relation = relation.supertype!;
            }
            return `${binding.typeLabel}:${p.role}`;
        }));
    const attributes = [...instance.attributes, ...instance.attributeVariables ?? []].map(a => a.label);
    if (!requiredRoles.length && !attributes.length) return [];
    return Object.values({ ...schema.entities, ...schema.relations }).filter(type => {
        const owns = new Set<string>(), plays = new Set<string>(), seen = new Set<string>();
        for (let t: typeof type | undefined = type; t && !seen.has(t.label); t = t.supertype) {
            seen.add(t.label);
            t.ownedAttributes?.forEach(a => owns.add(a.label));
            t.playedRoles?.forEach(r => plays.add(r.label));
        }
        return attributes.every(a => owns.has(a)) && requiredRoles.every(r => plays.has(r));
    }).map(type => type.label);
}

/** Build a bounded illustrative read from supported constraints, never from a
 * source statement. Relation targets include all bound players so siblings such
 * as depiction-slot(host, slot) resolve to the intended relation instance.
 * `paragraph` also pulls in every connected binding, so a typed variable or
 * relation resolves to the instances this paragraph actually matches rather
 * than every instance of its type. */
export function editorIllustrationQuery(target: EditorCaretTarget, schema: Schema, limit = 20, paragraph = false): string | null {
    const instance = target.instance;
    if (!instance) return null;
    const context = target.context ?? { focus: "@focus", bindings: { "@focus": instance } };
    const included = new Set<string>([context.focus]);
    const include = (key: string) => { if (context.bindings[key]) included.add(key); };
    // Relations need their players; untyped variables need their connected
    // relation patterns for inference. Typed player jumps remain focused reads.
    const connected = paragraph || (!instance.typeLabel && !instance.iid) || !!(instance.typeLabel && schema.attributes[instance.typeLabel]);
    for (let changed = true; changed;) {
        const before = included.size;
        if (connected) for (const [key, binding] of Object.entries(context.bindings)) {
            if (binding.players?.some(p => included.has(p.variable))) include(key);
            if (binding.attributeVariables?.some(p => included.has(p.variable))) include(key);
        }
        for (const key of [...included]) {
            const binding = context.bindings[key];
            binding.players?.forEach(p => include(p.variable));
            binding.attributeVariables?.forEach(p => include(p.variable));
        }
        if (included.size > 32) return null;
        changed = before !== included.size;
    }
    const names = new Map([...included].map((key, index) => [key, key === context.focus ? "$focus" : `$v${index}`]));
    const constraints: string[] = [];
    let anchored = false;
    for (const key of included) {
        const binding = context.bindings[key], name = names.get(key)!;
        if (binding.typeLabel) {
            constraints.push(`${name} isa ${quotedLabel(binding.typeLabel)};`); anchored = true;
        }
        if (binding.iid) {
            if (!/^0x[\da-fA-F]+$/.test(binding.iid)) return null;
            constraints.push(`${name} iid ${binding.iid};`); anchored = true;
        }
        for (const attr of binding.attributes) {
            const lexed = tokens(attr.literal, false, true);
            if (lexed.length !== 1 || lexed[0].kind !== "literal" || !/^['"]/.test(attr.literal) || lexed[0].text !== attr.literal) return null;
            constraints.push(`${name} has ${quotedLabel(attr.label)} ${attr.literal};`);
        }
        for (const attr of binding.attributeVariables ?? []) constraints.push(`${name} has ${quotedLabel(attr.label)} ${names.get(attr.variable)};`);
        if (binding.players?.length) constraints.push(`${name} links (${binding.players.map(p => `${p.role ? `${quotedLabel(p.role)}: ` : ""}${names.get(p.variable)}`).join(", ")});`);
    }
    // A has-only paragraph needs an owner type anchor for TypeDB's inference.
    const roleAnchored = [...included].some(key => context.bindings[key].typeLabel && context.bindings[key].players?.some(p => p.variable === context.focus));
    if (!instance.typeLabel && !instance.iid && !roleAnchored && (instance.attributes.length || instance.attributeVariables?.length)) {
        const attrs = [...instance.attributes, ...instance.attributeVariables ?? []].map(a => a.label);
        const candidates = Object.values({ ...schema.entities, ...schema.relations }).filter(type => {
            const owned = new Set<string>(), seen = new Set<string>();
            for (let t: typeof type | undefined = type; t && !seen.has(t.label); t = t.supertype) {
                seen.add(t.label); t.ownedAttributes.forEach(a => owned.add(a.label));
            }
            return attrs.every(a => owned.has(a));
        });
        if (!candidates.length || candidates.length > 32) return null;
        constraints.unshift(`${candidates.map(t => `{ $focus isa ${quotedLabel(t.label)}; }`).join(" or ")};`);
        anchored = true;
    }
    if (!anchored || !constraints.length) return null;
    return `match ${constraints.join(" ")} select ${[...names.values()].join(", ")}; limit ${Math.max(1, Math.min(20, Math.trunc(limit)))};`;
}
