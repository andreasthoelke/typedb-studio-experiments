import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createViewerServer } from './viewer-server.mjs';
import { createRunExecutor, prepareRun, contextQuery } from './viewer-run.mjs';
import { formatAnswer } from './viewer-result.mjs';

const concept = (value, valueType = 'string') => ({ kind: 'value', value, valueType });
const rows = { answerType: 'conceptRows', queryType: 'read', answers: [{ data: { name: concept('Ann'), n: concept(0, 'integer') } }], query: null };
const input = { query: 'match $x isa person;', database: 'test', runId: 'test-run-000000001', limit: 10 };

test('classifies real stages, ignoring comments, strings, nested fetch and keyword prefixes', () => {
    for (const q of ['match $x isa putative_father;', '# insert\nmatch $x isa person, has name "delete";',
        'match $x isa person; fetch { "insert": "put" };']) assert.equal(prepareRun(q).kind, 'read');
    assert.equal(prepareRun('match $x isa person; insert $x has name "Ann";').kind, 'write');
    assert.equal(prepareRun('fun f() -> boolean: match $x isa person; return check;').kind, 'schema');
    assert.match(prepareRun('entity putative_father;').query, /^define\n/);
    assert.equal(prepareRun('redefine entity person, owns name @key;').query, 'redefine entity person, owns name @key;');
    assert.throws(() => prepareRun('# comment only'), /no statement/);
    assert.throws(() => prepareRun('database delete test;'), /Expected/);
    assert.throws(() => prepareRun('insert $p isa person, has name "oops;'), /Unclosed/);
});

test('tables preserve variable names, false/zero/null, escaping, missing columns and nested document structure', () => {
    const rendered = formatAnswer({ ok: { ...rows, answers: [...rows.answers, { data: { flag: concept(false), name: concept('a\nb'), nil: concept(null) } }] } }).join('\n');
    for (const expected of ['$name', '$flag', '$n', 'false', '0', 'null', 'a\\nb', '—']) assert.ok(rendered.includes(expected), rendered);
    const flat = formatAnswer({ok: {answerType:'conceptDocuments', answers:[{name:'Ann',n:0},{n:2,name:'Bo'}]}}).join('\n');
    assert.match(flat, /name.*n/); assert.match(flat, /2 documents/);
    for (const answers of [[{a:{b:2}}], [{a:1},{b:2}], [null], [[1,2]]]) {
        assert.match(formatAnswer({ok:{answerType:'conceptDocuments',answers}}).join('\n'), /nested JSON/);
    }
    assert.deepEqual(formatAnswer({ok:{...rows, answers:[]}}), ['0 rows']);
    const error = '[CNT9] conflict\nNear 1:2\n--> insert\n    ^';
    assert.match(formatAnswer({err:{code:'CNT9',message:error}}).join('\n'), /Near 1:2\n--> insert\n    \^/);
});

test('context reads never include the mutation and retain quoted values', () => {
    const q = contextQuery('insert $p isa person, has person-id "p1", has name "new";', 'write');
    assert.match(q.query, /person-id "p1"/); assert.doesNotMatch(q.query, /insert|new/);
    assert.match(q.note, /not proof/);
    assert.equal(contextQuery('match $x isa person; select $x;', 'read'), null);
    assert.equal(contextQuery('match $x isa person; fetch { "name": "insert" };', 'read').query, 'match $x isa person;');
});

test('one execution shares answers, and failed writes keep their error with a separate read', async () => {
    const calls = [];
    const run = createRunExecutor({fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body); calls.push(body);
        if (url.endsWith('signin')) return Response.json({token:'secret'});
        if (body.transactionType === 'write') return Response.json({code:'CNT9',message:'key conflict\n ^'}, {status:400});
        return Response.json(rows);
    }});
    const read = await run(input);
    assert.strictEqual(read.graph.response, read.response);
    assert.equal(calls.length, 2); assert.equal(calls[1].commit, false);
    const failed = await run({...input,query:'insert $p isa person, has name "Ann";'});
    assert.equal(failed.execution.status, 'error'); assert.equal(failed.response.err.code, 'CNT9');
    assert.equal(failed.graph.source, 'context'); assert.equal(calls.length, 4);
    assert.equal(calls[2].commit, true); assert.equal(calls[3].transactionType, 'read');
    assert.match(failed.lines.join('\n'), /key conflict[\s\S]*Current data context[\s\S]*Ann/);
    assert.ok(!JSON.stringify(failed).includes('secret'));
});

test('lost/malformed/5xx responses are unknown and never retry or run context', async () => {
    for (const failure of [() => {throw Error('socket closed');}, () => new Response('bad json'), () => Response.json({code:'ERR',message:'server crash'}, {status:500})]) {
        let calls = 0;
        const run = createRunExecutor({fetchImpl: async url => {
            calls++; if (url.endsWith('signin')) return Response.json({token:'secret'}); return failure();
        }});
        const result = await run({...input,query:'insert $p isa person;'});
        assert.equal(result.execution.status, 'unknown'); assert.equal(calls, 2); assert.equal(result.graph, undefined);
        assert.match(result.lines.join('\n'), /may have committed/);
    }
});

test('bridge deduplicates concurrent runs, rejects ID reuse and replays completed data without execution', {timeout:5000}, async t => {
    let calls = 0;
    const server = createViewerServer({runExecutor:async request => {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return {...request,id:request.runId,response:{ok:rows},execution:{kind:'read',status:'success'},lines:['Ann']};
    }});
    server.listen(0, '127.0.0.1'); await once(server,'listening');
    t.after(() => {server.closeViewers();server.closeAllConnections();server.close();});
    const origin = `http://localhost:${server.address().port}`;
    const post = (body, headers = {}) => fetch(origin+'/api/viewer/run', {method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    const results = await Promise.all([post(input),post(input)]);
    assert.equal(calls,1); assert.deepEqual(await results[0].json(),await results[1].json());
    assert.equal((await post({...input,query:'insert $x isa person;'})).status,409);
    for (const bad of [{...input,database:''},{...input,runId:'short'},{...input,execution:{kind:'read',status:'success'}}]) assert.equal((await post(bad)).status,400);
    assert.equal((await post(input,{origin:'https://example.com'})).status,403);
    const abort = new AbortController(); t.after(() => abort.abort());
    const replay = await fetch(origin+'/api/viewer/events',{signal:abort.signal});
    const chunk = await replay.body.getReader().read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /conceptRows/); assert.match(text,/Ann/); assert.doesNotMatch(text, /"lines"/);
    assert.equal(calls,1);
    assert.equal((await post({...input,runId:'test-run-private-01',publish:false})).status,200);
    assert.equal(calls,2);
    assert.equal((await (await fetch(origin+'/api/viewer/health')).json()).latestRequestId,input.runId,'Private evaluation must not replace the graph');
});

test('successful anonymous inserts get a bounded read of their original patterns, never a second write', async () => {
    const query = 'match $d isa depiction, has depiction-id "conflict-stage"; $s isa slot-def, has slot-id "agent"; $r isa mental-state, has referent-id "craving"; insert $o isa occurrence, has occurrence-id "occ-craving"; occurrence-of (occurrence: $o, subject: $r); composition (host: $d, slot: $s, child: $o);';
    const calls = [];
    const run = createRunExecutor({fetchImpl: async (url, opts) => {
        if (url.endsWith('signin')) return Response.json({token:'test'});
        const body = JSON.parse(opts.body); calls.push(body); return Response.json(rows);
    }});
    const result = await run({...input,query});
    assert.equal(calls.length, 2);
    assert.equal(calls[0].query, query); assert.equal(calls[0].transactionType, 'write');
    assert.equal(calls[1].transactionType, 'read'); assert.equal(calls[1].commit, false);
    assert.doesNotMatch(calls[1].query, /\binsert\b/);
    assert.match(calls[1].query, /\$graph_relation_1 isa occurrence-of/);
    assert.match(calls[1].query, /\$graph_relation_2 isa composition \(host: \$d, slot: \$s, child: \$o\)/);
    assert.equal(result.graph.source, 'context');
    assert.match(contextQuery('match composition (host: $d); fetch { "host": $d };', 'read').query, /\$graph_relation_1 isa composition/);
});
