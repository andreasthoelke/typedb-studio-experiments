import { cleanSourceTitle, splitPlainHeading } from "./graph-title.mjs";

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
    if (index < 0) return plainHeading(lines);
    const comments: string[] = [];
    for (let i = index + 1; i < lines.length && /^\s*#/.test(lines[i]); i++) comments.push(lines[i].replace(/^\s*#\s?/, ''));
    return { title: cleanSourceTitle(lines[index].replace(/^\s*# ─ /, '')), comment: comments.join('\n') };
}

/** Without a `# ─` header, the comment block touching the first code line is
 * the heading (see `splitPlainHeading`). Decoration-only lines are skipped. */
function plainHeading(lines: string[]): { title: string; comment: string } {
    const isComment = (line: string) => /^\s*#/.test(line);
    const code = lines.findIndex(line => !isComment(line) && !/^\s*((re|un)?define)?\s*$/.test(line));
    let top = code < 0 ? lines.length : code;
    while (top > 0 && isComment(lines[top - 1])) top--;
    const block = lines.slice(top, code < 0 ? lines.length : code).map(line => line.replace(/^\s*#+\s?/, ''));
    while (block.length && !cleanSourceTitle(block[0].replace(/[═]/gu, ''))) block.shift();
    if (!block.length) return { title: '', comment: '' };
    const { title, comment } = splitPlainHeading(block[0]);
    return { title, comment: [comment, ...block.slice(1)].filter(Boolean).join('\n') };
}
