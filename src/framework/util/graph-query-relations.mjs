import { tokens } from './typeql-tokens.mjs';

/** Give top-level anonymous relation patterns an answer column in the graph copy.
 * Never lift a variable out of negation/optional/disjunction scope, or undo an
 * explicit projection/aggregation. Comments, strings and original text survive. */
export function nameGraphRelations(source) {
    const all = tokens(source, false, true);
    const top = all.filter(t => t.depth === 0);
    if (top[0]?.text !== 'match' || top.some(t => t.kind === 'word'
        && ['select', 'reduce', 'insert', 'put', 'update', 'delete', 'fetch', 'with'].includes(t.text))) return source;
    const used = new Set(all.filter(t => t.kind === 'variable').map(t => t.text));
    const edits = [];
    let count = 0;
    for (let i = 1; i < top.length; i++) {
        const t = top[i], prev = top[i - 1];
        if (!['match', ';'].includes(prev.text)) continue;
        const tuple = t.text === '(';
        const typed = (t.kind === 'word' || t.kind === 'variable') && top[i + 1]?.text === '(';
        if (!tuple && !typed) continue;
        let variable;
        do { variable = `$graph_relation_${++count}`; } while (used.has(variable));
        used.add(variable);
        edits.push({ from: t.from, text: `${variable} ${tuple ? 'links' : 'isa'} ` });
    }
    for (const edit of edits.reverse()) source = source.slice(0, edit.from) + edit.text + source.slice(edit.from);
    return source;
}

/** A successful, plain match/insert can be illustrated with exactly its patterns
 * in a separate read. This never executes a mutation, and isn't used for failed,
 * deleted, updated, put, projected or aggregate pipelines. */
export function insertedGraphContext(source) {
    const top = tokens(source, false, true).filter(t => t.depth === 0);
    if (!['match', 'insert'].includes(top[0]?.text)) return null;
    if (top.some(t => t.kind === 'word' && ['put', 'update', 'delete', 'reduce', 'select', 'fetch', 'with', 'end', 'limit', 'offset', 'sort'].includes(t.text))) return null;
    const inserts = top.filter(t => t.kind === 'word' && t.text === 'insert');
    if (inserts.length !== 1) return null;
    const insert = inserts[0];
    return nameGraphRelations(source.slice(0, insert.from) + 'match' + source.slice(insert.from + 'insert'.length));
}
