/** Query preparation shared by editor integrations. It does not execute queries. */
export interface GraphQueryOptions {
    neighbours: boolean;
    seedVariable?: string;
    relationTypes?: string[];
}

export interface ContextType {
    kind: string;
    playedRoles?: unknown[];
    relatedRoles?: unknown[];
    subtypes?: ContextType[];
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

function hasRoles(type: ContextType, key: "playedRoles" | "relatedRoles"): boolean {
    return !!type[key]?.length || !!type.subtypes?.some(child => hasRoles(child, key));
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
    if (!options.neighbours) return { query, note };
    const base = tokens(query).filter(t => t.depth === 0);
    if (base.some(t => t.text === "reduce" && t.kind === "word")) {
        return { query, note: `${note} Aggregate results are not expanded automatically.` };
    }
    const requestedSeed = options.seedVariable?.trim();
    if (requestedSeed && !/^\$[\p{L}_][\p{L}\p{N}_-]*$/u.test(requestedSeed)) {
        throw new Error("Use a seed variable such as $item, or leave it blank for automatic selection.");
    }
    const candidates: { variable: string; type: ContextType }[] = [];
    for (let i = 0; i < base.length - 2; i++) {
        if (base[i].kind !== "variable" || base[i + 1].text !== "isa") continue;
        const label = base[i + 2].text === "!" ? base[i + 3] : base[i + 2];
        if (!label || label.kind !== "word") continue;
        const type = typeByLabel(label.text);
        if (type && (type.kind === "entityType" || type.kind === "relationType")) candidates.push({ variable: base[i].text, type });
    }
    // A preceding select can remove otherwise-bound variables from scope.
    const selectIndex = base.map(t => t.kind === "word" ? t.text : "").lastIndexOf("select");
    const selected = selectIndex < 0 ? null : base.slice(selectIndex + 1).slice(0,
        base.slice(selectIndex + 1).findIndex(t => t.text === ";")).filter(t => t.kind === "variable").map(t => t.text);
    const seed = candidates.find(c => (!requestedSeed || c.variable === requestedSeed) && (!selected || selected.includes(c.variable)));
    if (!seed) return { query, note: `${note} No eligible entity/relation seed found; choose a directly typed variable to expand.` };
    const relationLabels = options.relationTypes ?? [];
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
        if (!hasRoles(seed.type, "relatedRoles")) return { query, note: `${note} The seed relation has no roles to expand.` };
        query += `\n\n# Graph context: role players of ${seed.variable}\nmatch\ntry {\n  ${seed.variable} links (${player});\n};`;
        note = `Showing role players of ${seed.variable}. Relation filters apply to entity neighbours.`;
    } else {
        if (!hasRoles(seed.type, "playedRoles")) return { query, note: `${note} The seed type plays no relation roles.` };
        const relation = fresh("relation");
        const filter = relationLabels.length ? "\n  " + relationLabels.map(label => `{ ${relation} isa ${label}; }`).join(" or ") + ";" : "";
        query += `\n\n# Graph context: one relation hop from ${seed.variable}\nmatch\ntry {\n  ${relation} links (${seed.variable});${filter}\n  ${relation} links (${player});\n};`;
        note = `Showing one relation hop from ${seed.variable}${relationLabels.length ? ` through ${relationLabels.join(", ")}` : ""}.`;
    }
    return { query, note };
}
