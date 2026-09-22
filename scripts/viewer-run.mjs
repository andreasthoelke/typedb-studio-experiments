import { tokens } from '../src/framework/util/typeql-tokens.mjs';
import { nameGraphRelations, insertedGraphContext } from '../src/framework/util/graph-query-relations.mjs';
import { formatRun } from './viewer-result.mjs';

/** Paragraphs may omit define, as in the existing Neovim schema workflow. */
export function prepareRun(source, schemaMode = 'define') {
    const all = tokens(source, false, true);
    const top = all.filter(t => t.depth === 0);
    if (!top.length) throw new Error('The paragraph contains no statement.');
    const first = top[0].text;
    let kind;
    if (['define', 'redefine', 'undefine', 'fun', 'entity', 'relation', 'attribute', 'struct'].includes(first)) kind = 'schema';
    else if (['match', 'insert', 'put', 'update', 'delete', 'reduce', 'with', 'fetch'].includes(first)) {
        kind = top.some(t => t.kind === 'word' && ['insert', 'put', 'update', 'delete'].includes(t.text)) ? 'write' : 'read';
    } else throw new Error('Expected one TypeQL pipeline or a schema declaration.');
    if (!['define', 'redefine', 'undefine'].includes(schemaMode)) throw new Error('Invalid schema mode.');
    let query = source;
    if (kind === 'schema' && !['define', 'redefine', 'undefine'].includes(first)) query = `${schemaMode}\n${query}`;
    if (all.at(-1).text !== ';') query += '\n;';
    return { query, kind };
}

/** Conservative context: known syntax only, always executed in a read transaction.
 * It is deliberately labelled as current data, never as proof that a write succeeded. */
export function contextQuery(query, kind, successful = false) {
    const all = tokens(query, true, true);
    const top = all.filter(t => t.depth === 0);
    if (kind === 'read') {
        const fetch = top.find(t => t.kind === 'word' && t.text === 'fetch');
        if (top[0]?.text !== 'match') return null;
        const base = fetch ? query.slice(0, fetch.from).trimEnd() : query;
        const graphQuery = nameGraphRelations(base);
        if (!fetch && graphQuery === query) return null;
        return { query: graphQuery, schemaMode: false,
            note: 'Graph context: separate read of the source patterns, including named anonymous relations; the original result is unchanged.' };
    }
    if (kind === 'schema') {
        const labels = [...new Set(all.flatMap((t, i) => ['entity', 'relation', 'attribute'].includes(t.text)
            && all[i + 1]?.kind === 'word' ? [all[i + 1].text] : []))];
        if (!labels.length) return null;
        return { query: `match\n${labels.map(label => `{ $type label ${label}; }`).join(' or\n')};\ntry { $type owns $attribute; };\ntry { $type relates $role; };\ntry { $type plays $played; };`,
            schemaMode: true, note: 'Current schema context: separate read of the declared types and their attributes/roles.' };
    }
    const inserted = successful && insertedGraphContext(query);
    if (inserted) return { query: inserted, schemaMode: false,
        note: 'Current data context: separate read of the successful insert patterns, including their relation nodes; the write is never replayed.' };
    const branches = [];
    for (let i = 0; i < all.length; i++) {
        if (all[i].kind !== 'variable' || all[i + 1]?.text !== 'isa') continue;
        const typeIndex = all[i + 2]?.text === '!' ? i + 3 : i + 2;
        const type = all[typeIndex];
        if (type?.kind !== 'word') continue;
        const filters = [];
        for (let j = typeIndex + 1; j < all.length && all[j].text !== ';'; j++) {
            if (all[j].text !== 'has' || all[j + 1]?.kind !== 'word') continue;
            const value = all[j + 2];
            if (!value) continue;
            const literal = value.kind === 'literal' && value.text[0] !== '`' ? value.text
                : /^(true|false)$/.test(value.text) ? value.text
                : /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s*[,;])/.exec(query.slice(value.from))?.[0];
            if (literal) filters.push(`has ${all[j + 1].text} ${literal}`);
        }
        const ids = filters.filter(f => /^has (?:id|identifier|uuid|[\w-]+[-_](?:id|identifier))\s/i.test(f));
        const constraints = ids.length ? ids : filters;
        branches.push(`{ $item isa ${type.text}${constraints.length ? ', ' + constraints.join(', ') : ''}; }`);
    }
    if (!branches.length) return null;
    return { query: `match\n${[...new Set(branches)].join(' or\n')};\ntry { $item has $attribute; };`, schemaMode: false,
        note: 'Current data context: separate read of referenced types/literal attributes; not proof that the intended write already exists.' };
}

/** No query retry: after dispatch a transport failure has an unknown commit outcome. */
export function createRunExecutor({ address = process.env.TYPEDB_ADDRESS || 'http://localhost:8000',
    username = process.env.TYPEDB_USERNAME || 'admin', password = process.env.TYPEDB_PASSWORD || 'password',
    timeout = 30000, fetchImpl = fetch } = {}) {
    const endpoint = new URL(address);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/') {
        throw new Error('TYPEDB_ADDRESS must be an HTTP(S) origin without credentials or a path.');
    }
    address = endpoint.origin;
    let token;
    async function post(path, body, authenticated = true) {
        const response = await fetchImpl(address + path, { method: 'POST', redirect: 'error',
            headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
        const text = await response.text();
        // Malformed/truncated success responses must never become a definitive failure.
        const data = JSON.parse(text);
        if (response.status === 401) token = undefined;
        if (!response.ok) {
            if (response.status >= 500 || typeof data.code !== 'string' || typeof data.message !== 'string') throw new Error(`TypeDB HTTP ${response.status}`);
            return { err: { code: data.code, message: data.message }, status: response.status };
        }
        return { ok: data };
    }
    async function execute(query, database, kind, limit) {
        const response = await post('/v1/query', { query, databaseName: database, transactionType: kind, commit: kind !== 'read',
            queryOptions: { answerCountLimit: limit, includeQueryStructure: true } });
        if (response.ok && (!['ok', 'conceptRows', 'conceptDocuments'].includes(response.ok.answerType)
            || (response.ok.answerType !== 'ok' && !Array.isArray(response.ok.answers)))) throw new Error('Invalid TypeDB query response');
        return response;
    }
    return async function run(request) {
        const start = Date.now();
        const { query, kind } = prepareRun(request.query, request.schemaMode);
        const result = { id: request.runId, query, database: request.database, limit: request.limit ?? 1000,
            sourceLocation: request.sourceLocation, connectionOrigin: address, projectTempDirectory: request.projectTempDirectory,
            execution: { kind, status: 'error' } };
        let dispatched = false;
        try {
            if (!token) {
                const signin = await post('/v1/signin', { username, password }, false);
                if (signin.err) { result.response = signin; throw new Error('Sign-in rejected'); }
                token = signin.ok.token;
                if (typeof token !== 'string' || !token) throw new Error('Invalid sign-in response');
            }
            dispatched = true;
            result.response = await execute(query, request.database, kind, result.limit);
            result.execution.status = result.response.err ? 'error' : 'success';
        } catch (error) {
            result.execution.status = dispatched ? 'unknown' : 'error';
            result.response ??= { err: { code: dispatched ? 'OUTCOME_UNKNOWN' : 'CONNECTION', message: dispatched
                ? 'The TypeDB response was lost or unreadable. The statement may have committed. Check current data before explicitly running it again.'
                : `Could not connect/sign in to TypeDB: ${error.message}` }, status: 0 };
        }
        if (result.response.err) result.execution.error = result.response.err.message.slice(0, 8000);
        if (result.response.ok?.answerType === 'conceptRows' && result.response.ok.answers.length) {
            result.graph = { query, response: result.response, schemaMode: false, source: 'result',
                note: 'Graph and Neovim table use the same executed answer. Apply graph context controls to request a separate read.' };
        }
        if (result.execution.status !== 'unknown' && dispatched) {
            const context = contextQuery(query, kind, result.execution.status === 'success');
            if (context) {
                try {
                    const response = await execute(context.query, request.database, 'read', result.limit);
                    if (response.err) result.contextError = response.err.message;
                    else result.graph = { ...context, response, source: 'context' };
                } catch (error) { result.contextError = error.message; }
            }
        }
        // Empty reads still replace the previous graph, rather than leaving stale data.
        if (!result.graph && result.response.ok) result.graph = { query, response: result.response, schemaMode: kind === 'schema',
            source: 'result', note: 'Executed result; no additional graph context was available.' };
        result.elapsedMs = Date.now() - start;
        result.lines = formatRun(result);
        return result;
    };
}
