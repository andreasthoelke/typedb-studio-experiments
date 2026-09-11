import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createViewerServer } from './viewer-server.mjs';

async function start(t, options) {
    const server = createViewerServer(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeViewers(); server.closeAllConnections(); server.close(); });
    const origin = `http://localhost:${server.address().port}`;
    const post = (body, headers = {}) => fetch(`${origin}/api/viewer/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const subscribe = async () => {
        const abort = new AbortController();
        t.after(() => abort.abort());
        const response = await fetch(`${origin}/api/viewer/events`, { signal: abort.signal });
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        return async () => {
            while (true) {
                const boundary = buffer.indexOf('\n\n');
                if (boundary >= 0) {
                    const event = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const line = event.split('\n').find(line => line.startsWith('data: '));
                    if (line) return JSON.parse(line.slice(6));
                } else {
                    const { value, done } = await reader.read();
                    if (done) throw new Error('Event stream closed before query arrived');
                    buffer += value;
                }
            }
        };
    };
    return { origin, post, subscribe };
}

test('queues before a browser connects, preserves query text, and broadcasts updates', { timeout: 5000 }, async t => {
    const { post, subscribe, origin } = await start(t);
    const query = 'selected text with $variables, "quotes", `backticks`, $(text)\nand Unicode: café 日本語';
    const response = await post({ query, database: 'example', limit: 25 });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.viewers, 0);
    const first = await subscribe();
    assert.deepEqual(await first(), { id: accepted.id, query, database: 'example', limit: 25 });
    const second = await subscribe();
    assert.equal((await second()).id, accepted.id);
    const update = await (await post({ query: 'next query' })).json();
    assert.equal(update.viewers, 2);
    assert.notEqual(update.id, accepted.id);
    assert.equal((await first()).id, update.id);
    assert.equal((await second()).limit, 1000);
    const reconnected = await subscribe();
    assert.equal((await reconnected()).id, update.id);
    const health = await (await fetch(`${origin}/api/viewer/health`)).json();
    assert.equal(health.latestRequestId, update.id);
    assert.equal(health.service, 'typedb-studio-bridge');
});

test('rejects malformed, excessive, and foreign-origin requests without replacing latest', { timeout: 5000 }, async t => {
    const { post, origin, subscribe } = await start(t);
    const accepted = await (await post({ query: 'valid' })).json();
    for (const body of [null, {}, { query: '' }, { query: '   ' }, { query: 1 }, { query: 'q', database: '' },
        { query: 'q', limit: 0 }, { query: 'q', limit: 1.5 }, { query: 'q', limit: 100001 }]) {
        assert.equal((await post(body)).status, 400);
    }
    assert.equal((await post({ query: 'q' }, { Origin: 'https://example.com' })).status, 403);
    // Node fetch normalises Host; use the HTTP client to exercise a foreign Host.
    const foreignHostStatus = await new Promise((resolve, reject) => {
        const request = httpRequest(`${origin}/api/viewer/health`, { headers: { Host: 'example.com' } }, response => {
            response.resume();
            resolve(response.statusCode);
        });
        request.on('error', reject);
        request.end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await post({ query: 'q' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post({ query: 'q' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await fetch(`${origin}/api/viewer/query`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await post({ query: 'x'.repeat(1024 * 1024) })).status, 413);
    assert.equal((await (await subscribe())()).id, accepted.id);
});

test('serves built assets and SPA routes, with clear missing-build and traversal errors', async t => {
    const dist = await mkdtemp(join(tmpdir(), 'typedb-viewer-test-'));
    t.after(() => rm(dist, { recursive: true, force: true }));
    const { origin } = await start(t, { dist });
    const legacy = await fetch(`${origin}/viewer`, { redirect: 'manual' });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('location'), '/query?nvim=1');
    assert.equal((await fetch(`${origin}/query?nvim=1`)).status, 404);
    await writeFile(join(dist, 'index.html'), '<html>viewer</html>');
    await writeFile(join(dist, 'main.js'), 'window.loaded = true;');
    assert.equal(await (await fetch(`${origin}/query?nvim=1`)).text(), '<html>viewer</html>');
    assert.equal(await (await fetch(`${origin}/`)).text(), '<html>viewer</html>');
    assert.equal((await fetch(`${origin}/main.js`)).headers.get('content-type'), 'text/javascript');
    assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
    assert.equal((await fetch(`${origin}/..%2fsecret`)).status, 403);
    assert.equal(await (await fetch(`${origin}/query?nvim=1`, { method: 'HEAD' })).text(), '');
});

test('development proxy serves Angular while keeping query events local', async t => {
    const upstream = createServer((request, response) => response.end(`Angular ${request.url}`));
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const { origin, post } = await start(t, { devPort: upstream.address().port });
    assert.equal(await (await fetch(`${origin}/query?nvim=1`)).text(), 'Angular /query?nvim=1');
    assert.equal((await post({ query: 'q' })).status, 202);
});


test('completed operation outcomes survive event delivery and invalid outcomes are rejected', async t => {
    const { post, subscribe } = await start(t);
    const execution = { kind: 'write', status: 'error', error: 'Duplicate key S1' };
    const query = 'insert $s isa scene;';
    assert.equal((await post({ query, execution })).status, 202);
    const event = await (await subscribe())();
    assert.deepEqual(event.execution, execution);
    assert.equal(event.query, query);
    for (const bad of [null, {}, { kind: 'write', status: 'pending' }, { kind: 'schema', status: 'error', error: 7 }]) {
        assert.equal((await post({ query, execution: bad })).status, 400);
    }
});

test('PNG exports save to Downloads with filesystem-based, concurrent-safe counters', async t => {
    const downloadsDirectory = await mkdtemp(join(tmpdir(), 'studio-downloads-'));
    t.after(() => rm(downloadsDirectory, { recursive: true, force: true }));
    const { origin } = await start(t, { downloadsDirectory });
    const { readFile, readdir } = await import('node:fs/promises');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
    const save = (name = 'scene-take', headers = {}, body = png) => fetch(`${origin}/api/viewer/export?name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: {'Content-Type':'image/png', ...headers}, body,
    });
    assert.equal((await (await fetch(`${origin}/api/viewer/health`)).json()).pngExport, true);
    await writeFile(join(downloadsDirectory, 'scene-take-00.png'), 'existing export');
    const results = await Promise.all([save(), save(), save()]);
    assert.ok(results.every(r => r.status === 201));
    const saved = await Promise.all(results.map(r => r.json()));
    assert.deepEqual(saved.map(s => s.filename).sort(), ['scene-take-01.png', 'scene-take-02.png', 'scene-take-03.png']);
    assert.equal(await readFile(join(downloadsDirectory, 'scene-take-00.png'), 'utf8'), 'existing export');
    for (const item of saved) assert.deepEqual(await readFile(item.path), png);
    // A fresh server still reads the directory rather than an in-memory counter.
    const second = await start(t, { downloadsDirectory });
    const next = await fetch(`${second.origin}/api/viewer/export?name=scene-take`, {method:'POST', headers:{'Content-Type':'image/png'}, body:png});
    assert.equal((await next.json()).filename, 'scene-take-04.png');
    assert.equal((await save('../escape')).status, 400);
    assert.equal((await save('scene', {'Origin':'https://example.com'})).status, 403);
    assert.equal((await save('scene', {'Content-Type':'text/plain'})).status, 415);
    assert.equal((await save('scene', {}, Buffer.from('not a PNG'))).status, 400);
    assert.equal((await readdir(downloadsDirectory)).length, 5);
});
