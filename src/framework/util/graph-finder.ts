export interface GraphFinderEntry {
    id: string;
    label: string;
    detail: string;
    nodes: string[];
    text: string;
}

/** Ordered subsequence matching; contiguous matches rank ahead of scattered letters. */
export function fuzzyGraphMatches(entries: GraphFinderEntry[], query: string): GraphFinderEntry[] {
    const normalise = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    const needle = normalise(query).replace(/\s/g, "");
    const score = (entry: GraphFinderEntry) => {
        const text = normalise(entry.text);
        const contiguous = text.indexOf(needle);
        if (contiguous >= 0) return contiguous;
        let previous = -1, gaps = 0;
        for (const letter of needle) {
            const index = text.indexOf(letter, previous + 1);
            if (index < 0) return Infinity;
            gaps += index - previous - 1;
            previous = index;
        }
        return 1000 + gaps;
    };
    return entries.map(entry => ({ entry, score: score(entry) })).filter(row => Number.isFinite(row.score))
        .sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label)).map(row => row.entry);
}
