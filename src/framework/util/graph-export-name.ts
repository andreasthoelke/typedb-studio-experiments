import { tokens } from "./graph-query";

export interface ExportType { label: string; kind: string; }

/** Use the executed query, ignoring literals, comments, and variable names. */
export function graphExportBaseName(query: string, knownTypes: ExportType[], fallbackTypes: ExportType[] = []): string {
    const primary = (type: ExportType) => ["entity", "relation", "entityType", "relationType"].includes(type.kind);
    const known = new Map(knownTypes.map(type => [type.label, type]));
    const referenced = tokens(query, true).flatMap(token => {
        const type = token.kind === "word" ? known.get(token.text) : undefined;
        return type ? [type] : [];
    });
    // Prefer entities/relations; attribute-only queries still get a useful name.
    const source = referenced.some(primary) ? referenced.filter(primary) : referenced.length ? referenced
        : fallbackTypes.some(primary) ? fallbackTypes.filter(primary) : fallbackTypes;
    const labels = [...new Set(source.map(type => type.label))];
    const safe = labels.join("-").normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
    // Leave room for a counter and extension within common filesystem limits.
    let base = "";
    for (const char of safe) {
        if (new TextEncoder().encode(base + char).length > 160) break;
        base += char;
    }
    return base.replace(/-+$/g, "") || "graph";
}
