import { cleanSourceTitle } from "./graph-title.mjs";

/** Source is provenance only. Restoring it never executes a query. */
export interface GraphSource {
    path: string;
    line: number;
    anchor: string;
    title: string;
    comment: string;
    query: string;
    server?: string;
}
export function sourceHeading(query: string): { title: string; comment: string } {
    const lines = query.split('\n'), index = lines.findIndex(line => /^\s*# ─ /.test(line));
    if (index < 0) return { title: '', comment: '' };
    const comments: string[] = [];
    for (let i = index + 1; i < lines.length && /^\s*#/.test(lines[i]); i++) comments.push(lines[i].replace(/^\s*#\s?/, ''));
    return { title: cleanSourceTitle(lines[index].replace(/^\s*# ─ /, '')), comment: comments.join('\n') };
}
