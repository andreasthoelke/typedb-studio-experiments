/** Query preparation shared by editor integrations. It does not execute queries. */
export interface GraphQueryOptions {
    neighbours: boolean;
    seedVariable?: string;
    relationTypes?: string[];
}

export interface ContextType {
    kind: string;
    playedRoles?: { label: string }[];
    relatedRoles?: { label: string }[];
    subtypes?: ContextType[];
    supertype?: ContextType;
}

interface Token { text: string; from: number; depth: number; kind: "word" | "variable" | "symbol"; }

/** Lex only the boundaries we need; never rewrite comments, strings, or nested fetches. */
function tokens(text: string): Token[] {
    const result: Token[] = [];
    const brackets: string[] = [];
    for (let i = 0; i < text.length;) {
        const c = text[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
        if (c === '"' || c === "'" || c === "`") {
            const quote = c;
            i++;
            let closed = false;
            while (i < text.length) {
                if (text[i] === "\\") { i += 2; continue; }
                if (text[i++] === quote) { closed = true; break; }
            }
            if (!closed) throw new Error("Unclosed quote in the query.");
            continue;
        }
        const variable = c === "$" ? /^\$[\p{L}_][\p{L}\p{N}_-]*/u.exec(text.slice(i)) : null;
        const word = /^[\p{L}_][\p{L}\p{N}_-]*/u.exec(text.slice(i));
        const token = variable?.[0] ?? word?.[0] ?? c;
        if ("})]".includes(c)) {
            if (brackets.pop() !== ({ "}": "{", ")": "(", "]": "[" } as Record<string, string>)[c]) {
                throw new Error("Unbalanced brackets in the query.");
            }
        }
        result.push({ text: token, from: i, depth: brackets.length,
            kind: variable ? "variable" : word ? "word" : "symbol" });
        if ("{([".includes(c)) brackets.push(c);
        i += token.length;
    }
    if (brackets.length) throw new Error("Unclosed brackets in the query.");
    return result;
}

export interface GraphContextSeed { variable: string; type: ContextType; exact: boolean; }

/** Shared seed selection for query generation and the schema-aware relation chooser. */
export function findGraphContextSeed(source: string, seedVariable: string | undefined,
    typeByLabel: (label: string) => ContextType | undefined,
): GraphContextSeed | undefined {
    const top = tokens(source).filter(t => t.depth === 0);
    const fetchIndex = top.findIndex(t => t.kind === "word" && t.text === "fetch");
    const base = fetchIndex < 0 ? top : top.slice(0, fetchIndex);
    if (base[0]?.text !== "match" || base.some(t => t.kind === "word" && t.text === "reduce")) return undefined;
    const requestedSeed = seedVariable?.trim();
    if (requestedSeed && !/^\$[\p{L}_][\p{L}\p{N}_-]*$/u.test(requestedSeed)) {
        throw new Error("Use a seed variable such as $item, or leave it blank for automatic selection.");
    }
    const candidates: GraphContextSeed[] = [];
    for (let i = 0; i < base.length - 2; i++) {
        if (base[i].kind !== "variable" || base[i + 1].text !== "isa") continue;
        const label = base[i + 2].text === "!" ? base[i + 3] : base[i + 2];
        if (!label || label.kind !== "word") continue;
        const type = typeByLabel(label.text);
        if (type && (type.kind === "entityType" || type.kind === "relationType")) candidates.push({ variable: base[i].text, type, exact: base[i + 2].text === "!" });
    }
    // A preceding select can remove otherwise-bound variables from scope.
    const selectIndex = base.map(t => t.kind === "word" ? t.text : "").lastIndexOf("select");
    const selected = selectIndex < 0 ? null : base.slice(selectIndex + 1).slice(0,
        base.slice(selectIndex + 1).findIndex(t => t.text === ";")).filter(t => t.kind === "variable").map(t => t.text);
    return candidates.find(c => (!requestedSeed || c.variable === requestedSeed) && (!selected || selected.includes(c.variable)));
}

function roleLabels(type: ContextType, key: "playedRoles" | "relatedRoles", includeSubtypes: boolean): Set<string> {
    const labels = new Set<string>();
    const seen = new Set<ContextType>();
    const visit = (node: ContextType, descendants: boolean) => {
        if (seen.has(node)) return;
        seen.add(node);
        for (const role of node[key] ?? []) labels.add(role.label);
        if (descendants) for (const child of node.subtypes ?? []) visit(child, true);
        if (node.supertype) visit(node.supertype, false);
    };
    visit(type, includeSubtypes);
    return labels;
}

export function isGraphContextRelationCompatible(seed: GraphContextSeed, relation: ContextType): boolean {
    if (seed.type.kind !== "entityType" || relation.kind !== "relationType") return false;
    const played = roleLabels(seed.type, "playedRoles", !seed.exact);
    return [...roleLabels(relation, "relatedRoles", true)].some(label => played.has(label));
}

/** The schema inspector binds a concrete type for its text result. Return only
 *  the instance in the graph copy; otherwise that type becomes an extra node
 *  joined by an isa edge. Recognise the inspector's simple two-statement shape
 *  without changing explicit selections or interpreting arbitrary pipelines. */
function projectInspectorInstance(query: string): string {
    const t = tokens(query);
    if (t.length === 10 && t.every(token => token.depth === 0)
        && t[0].text === "match" && t[1].kind === "variable"
        && t[2].text === "isa" && t[3].kind === "word" && t[4].text === ";"
        && t[5].text === t[1].text && t[6].text === "isa" && t[7].text === "!"
        && t[8].kind === "variable" && t[8].text !== t[1].text && t[9].text === ";") {
        return `${query}\nselect ${t[1].text};`;
    }
    return query;
}

export function prepareGraphQuery(source: string, options: GraphQueryOptions,
    typeByLabel: (label: string) => ContextType | undefined = () => undefined,
): { query: string; note: string } {
    const all = tokens(source);
    const top = all.filter(t => t.depth === 0);
    if (top[0]?.text !== "match") {
        throw new Error("Automatic graph queries currently support one match pipeline. Schema, writes, and function preambles are not mirrored.");
    }
    if (top.some(t => t.kind === "word" && ["insert", "put", "update", "delete", "define", "undefine", "redefine", "end"].includes(t.text))) {
        throw new Error("Automatic graph queries must be a single read pipeline; mutations and query batches are not mirrored.");
    }
    const fetch = top.find(t => t.kind === "word" && t.text === "fetch");
    // Without a terminal fetch, TypeDB returns the pipeline's concept rows.
    // Existing select/limit/sort stages are preserved, including their ordering.
    let query = (fetch ? source.slice(0, fetch.from) : source).trimEnd();
    let note = fetch ? "Fetch removed; returning the pipeline's concept rows." : "Using the supplied concept-row query.";
    const projected = projectInspectorInstance(query);
    if (projected !== query) note += " The inspector's auxiliary type column is excluded from the graph.";
    query = projected;
    if (!options.neighbours) return { query, note };
    const base = tokens(query).filter(t => t.depth === 0);
    if (base.some(t => t.text === "reduce" && t.kind === "word")) {
        return { query, note: `${note} Aggregate results are not expanded automatically.` };
    }
    const seed = findGraphContextSeed(query, options.seedVariable, typeByLabel);
    if (!seed) return { query, note: `${note} No eligible entity/relation seed found; choose a directly typed variable to expand.` };
    let relationLabels = options.relationTypes ?? [];
    for (const label of relationLabels) {
        if (!/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(label) || typeByLabel(label)?.kind !== "relationType") {
            throw new Error(`Unknown relation type: ${label}`);
        }
    }
    const used = new Set(all.filter(t => t.kind === "variable").map(t => t.text));
    const fresh = (name: string) => {
        let variable = `$nvim_${name}`;
        while (used.has(variable)) variable += "_";
        used.add(variable);
        return variable;
    };
    const player = fresh("player");
    if (seed.type.kind === "relationType") {
        if (!roleLabels(seed.type, "relatedRoles", !seed.exact).size) return { query, note: `${note} The seed relation has no roles to expand.` };
        query += `\n\n# Graph context: role players of ${seed.variable}\nmatch\ntry {\n  ${seed.variable} links (${player});\n};`;
        note = `Showing role players of ${seed.variable}. Relation filters apply to entity neighbours.`;
    } else {
        if (!roleLabels(seed.type, "playedRoles", !seed.exact).size) return { query, note: `${note} The seed type plays no relation roles.` };
        const excluded = relationLabels.filter(label => !isGraphContextRelationCompatible(seed, typeByLabel(label)!));
        relationLabels = relationLabels.filter(label => !excluded.includes(label));
        if (excluded.length && !relationLabels.length) {
            return { query, note: `No selected relation types are compatible with ${seed.variable}: ${excluded.join(", ")}. Showing seed instances only. Clear the relation filter to include all compatible relations.` };
        }
        const relation = fresh("relation");
        const filter = relationLabels.length ? "\n  " + relationLabels.map(label => `{ ${relation} isa ${label}; }`).join(" or ") + ";" : "";
        query += `\n\n# Graph context: one relation hop from ${seed.variable}\nmatch\ntry {\n  ${relation} links (${seed.variable});${filter}\n  ${relation} links (${player});\n};`;
        note = `Showing one relation hop from ${seed.variable}${relationLabels.length ? ` through ${relationLabels.join(", ")}` : ""}.`;
        if (excluded.length) note += ` Skipped incompatible relation types: ${excluded.join(", ")}.`;
    }
    return { query, note };
}
