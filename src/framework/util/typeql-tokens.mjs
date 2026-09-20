/** Lex only the boundaries we need; never rewrite comments, strings, or nested fetches. */
export function tokens(text, tolerant = false, literals = false) {
    const result = [];
    const brackets = [];
    for (let i = 0; i < text.length;) {
        const c = text[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
        if (c === '"' || c === "'" || c === "`") {
            const from = i;
            const quote = c;
            i++;
            let closed = false;
            while (i < text.length) {
                if (text[i] === "\\") { i += 2; continue; }
                if (text[i++] === quote) { closed = true; break; }
            }
            if (!closed && !tolerant) throw new Error("Unclosed quote in the query.");
            if (closed && literals) result.push({ text: text.slice(from, i), from, depth: brackets.length, kind: "literal" });
            continue;
        }
        const variable = c === "$" ? /^\$[\p{L}_][\p{L}\p{N}_-]*/u.exec(text.slice(i)) : null;
        const word = /^[\p{L}_][\p{L}\p{N}_-]*/u.exec(text.slice(i));
        const token = variable?.[0] ?? word?.[0] ?? c;
        if ("})]".includes(c)) {
            if (brackets.pop() !== ({ "}": "{", ")": "(", "]": "[" })[c]) {
                if (!tolerant) throw new Error("Unbalanced brackets in the query.");
            }
        }
        result.push({ text: token, from: i, depth: brackets.length,
            kind: variable ? "variable" : word ? "word" : "symbol" });
        if ("{([".includes(c)) brackets.push(c);
        i += token.length;
    }
    if (brackets.length && !tolerant) throw new Error("Unclosed brackets in the query.");
    return result;
}

