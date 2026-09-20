/** Plain-text presentation of the authoritative HTTP result. Raw data is retained. */
const scalar = value => value === undefined ? '—' : JSON.stringify(value);
const cell = concept => {
    if (concept == null) return '—';
    if ('value' in concept) return scalar(concept.value);
    if (concept.iid) return `${concept.type?.label ?? concept.kind} #${concept.iid.replace(/^0x/, '').slice(-12)}`;
    return concept.label ?? scalar(concept);
};
const width = text => [...text].reduce((n, c) => n + (/\p{Mark}/u.test(c) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]|\p{Extended_Pictographic}/u.test(c) ? 2 : 1), 0);
function table(columns, rows) {
    // Keep every value in raw JSON, with visible elision in the compact view.
    const shorten = value => {
        if (width(value) <= 72) return value;
        let prefix = '';
        for (const c of value) { if (width(prefix + c) > 71) break; prefix += c; }
        return prefix + '…';
    };
    const values = [columns, ...rows].map(row => row.map(value => shorten(String(value))));
    const widths = columns.map((_, i) => Math.max(...values.map(row => width(row[i]))));
    const line = row => row.map((v, i) => v + ' '.repeat(widths[i] - width(v))).join(' │ ').trimEnd();
    return [line(values[0]), widths.map(w => '─'.repeat(w)).join('─┼─'), ...values.slice(1).map(line)];
}

export function formatAnswer(response) {
    if (response.err) {
        const lines = response.err.message.split('\n');
        const first = lines[0].startsWith(`[${response.err.code}]`) ? lines[0] : `[${response.err.code}] ${lines[0]}`;
        const near = lines.findIndex(line => /^Near\s/.test(line));
        return [first, ...(near >= 0 ? lines.slice(near, near + 12) : []),
            ...(lines.length > 1 ? ['Full error details: gr (raw JSON).'] : [])];
    }
    const answer = response.ok;
    if (answer.answerType === 'ok') return ['OK'];
    const rows = answer.answers ?? [];
    if (!rows.length) return ['0 rows'];
    if (answer.answerType === 'conceptRows') {
        const keys = [...new Set(rows.flatMap(row => Object.keys(row.data)))];
        const projected = (answer.query?.outputs ?? []).map(id => answer.query?.variables?.[id]?.name).filter(name => keys.includes(name));
        const columns = [...new Set([...projected, ...keys])];
        if (!columns.length) return [`${rows.length} rows (no columns)`];
        return [...table(columns.map(c => '$' + c), rows.map(row => columns.map(c => cell(row.data[c])))), `${rows.length} rows`];
    }
    // Only flat, consistent documents become a table. Nested data retains its shape.
    const flat = row => row && !Array.isArray(row) && typeof row === 'object'
        && Object.values(row).every(v => v === null || typeof v !== 'object');
    const columns = flat(rows[0]) ? Object.keys(rows[0]) : [];
    if (columns.length && rows.every(row => flat(row) && Object.keys(row).length === columns.length && columns.every(c => Object.hasOwn(row, c)))) {
        return [...table(columns, rows.map(row => columns.map(c => scalar(row[c])))), `${rows.length} documents`];
    }
    return [JSON.stringify(rows, null, 2), `${rows.length} documents (nested JSON)`];
}

export function formatRun(run) {
    const status = run.execution.status;
    const title = `${run.database} · ${run.execution.kind} · ${status === 'success' ? (run.execution.kind === 'read' ? 'success' : 'committed') : status} · ${run.elapsedMs} ms`;
    const lines = [title, '', ...formatAnswer(run.response)];
    if (run.response.ok?.warning || run.response.ok?.comment) lines.push('', String(run.response.ok.warning || run.response.ok.comment));
    if (run.response.ok?.answers?.length >= run.limit) lines.push(`Result display limit: ${run.limit}; more answers may exist.`);
    if (run.graph?.source === 'context') lines.push('', run.graph.note, ...formatAnswer(run.graph.response));
    if (run.contextError) lines.push('', `Context unavailable: ${run.contextError}`);
    lines.push('', 'gr: raw JSON   gt: table/result   gq: executed/context queries');
    return lines.flatMap(line => line.split('\n'));
}
