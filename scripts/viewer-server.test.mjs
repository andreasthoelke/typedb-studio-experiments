import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir, readdir, readFile, symlink } from 'node:fs/promises';
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

test('caret gestures broadcast separately, validate coordinates, and never replay or replace queries', { timeout: 5000 }, async t => {
    const { post, subscribe, origin } = await start(t);
    const query=await (await post({query:'match $x isa scene;'})).json();
    const first=await subscribe(),second=await subscribe();await first();await second();
    const caret={source:'entity scene;\n  owns title;',line:0,column:7,schemaOnly:true,database:'example'};
    const send=body=>fetch(origin+'/api/viewer/caret',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const response=await send(caret);assert.equal(response.status,202);const accepted=await response.json();
    assert.equal(accepted.caretNavigation,true);assert.equal(accepted.viewers,2);
    assert.deepEqual(await first(),{id:accepted.id,...caret});assert.deepEqual(await second(),{id:accepted.id,...caret});
    const reconnected=await subscribe();assert.equal((await reconnected()).id,query.id,'Only queries replay');
    for(const invalid of [{},null,{...caret,line:-1},{...caret,line:2},{...caret,column:999},{...caret,column:1.5},
        {...caret,schemaOnly:'yes'},{...caret,database:''},{...caret,source:42}]) assert.equal((await send(invalid)).status,400);
    const health=await (await fetch(origin+'/api/viewer/health')).json();
    assert.equal(health.caretNavigation,true);assert.equal(health.latestRequestId,query.id);
});

test('viewer controls broadcast independently with a bounded command allowlist and never replay', {timeout:5000}, async t=>{
    const {post,subscribe,origin}=await start(t);
    const query=await (await post({query:'match $x isa scene;'})).json();
    const first=await subscribe(),second=await subscribe();await first();await second();
    const send=body=>fetch(origin+'/api/viewer/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    for(const command of ['centreCaret','caretTop','caretBottom','caretLeft','caretRight','panLeft','panRight','panUp','panDown','zoomIn','zoomOut','back','focus','relayout','snap']) {
        const control={command,database:'example',projectTempDirectory:'/tmp/studio-project/temp'};
        const response=await send(control);assert.equal(response.status,202);const accepted=await response.json();
        assert.equal(accepted.viewerControls,true);assert.deepEqual(await first(),{id:accepted.id,...control});assert.deepEqual(await second(),{id:accepted.id,...control});
    }
    for(const bad of [null,{}, {command:'delete'}, {command:'snap',database:''}, {command:'snap',projectTempDirectory:'relative'}]) assert.equal((await send(bad)).status,400);
    const reconnected=await subscribe();assert.equal((await reconnected()).id,query.id);
});

test('window focus escalation validates its closed direction set and never reaches the viewers', { timeout: 5000 }, async t => {
    // Stubbed: the real implementation spawns Hammerspoon, which would move
    // this machine's window focus while the suite runs.
    const escalated = [];
    const { origin, post, subscribe } = await start(t, { windowFocus: direction => { escalated.push(direction); return { focused: true }; } });
    const events = await subscribe();
    const query = await (await post({ query: 'match $x isa person;' })).json();
    assert.equal((await events()).id, query.id);
    const send = body => fetch(origin + '/api/viewer/focus', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const direction of ['west', 'east', 'north', 'south', 'far-west', 'far-east', 'previous']) {
        const response = await send({ direction });
        assert.equal(response.status, 202);
        const accepted = await response.json();
        assert.equal(accepted.direction, direction);
        assert.equal(accepted.focused, true);
    }
    assert.deepEqual(escalated, ['west', 'east', 'north', 'south', 'far-west', 'far-east', 'previous']);
    // A focus motion is an OS gesture, not viewer state: nothing may be
    // broadcast, and the replayable latest query must be untouched.
    for (const bad of [null, {}, { direction: 'up' }, { direction: '' }, { direction: ['west'] },
        { direction: 'far' }, { direction: 'west; open -a Calculator' }]) {
        assert.equal((await send(bad)).status, 400);
    }
    assert.equal(escalated.length, 7, 'A rejected direction never reaches the window manager');
    const replay = await subscribe();
    assert.equal((await replay()).id, query.id, 'Focus requests left the latest query in place');
    assert.equal((await fetch(origin + '/api/viewer/focus', { method: 'GET' })).status, 404);
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

test('PNG exports save to a project folder with filesystem-based, concurrent-safe counters', async t => {
    const downloadsDirectory = await mkdtemp(join(tmpdir(), 'studio-downloads-'));
    t.after(() => rm(downloadsDirectory, { recursive: true, force: true }));
    const { origin } = await start(t);
    const context = new URLSearchParams({projectTempDirectory: downloadsDirectory, database: 'test-db'});
    const directory = join(downloadsDirectory, 'imgs', 'test-db');
    await mkdir(directory, {recursive:true});
    const { readFile, readdir } = await import('node:fs/promises');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
    const save = (name = 'scene-take', headers = {}, body = png) => fetch(`${origin}/api/viewer/export?name=${encodeURIComponent(name)}&${context}`, {
        method: 'POST', headers: {'Content-Type':'image/png', ...headers}, body,
    });
    assert.equal((await (await fetch(`${origin}/api/viewer/health`)).json()).pngExport, true);
    await writeFile(join(directory, 'scene-take-00.png'), 'existing export');
    const results = await Promise.all([save(), save(), save()]);
    assert.ok(results.every(r => r.status === 201));
    const saved = await Promise.all(results.map(r => r.json()));
    assert.deepEqual(saved.map(s => s.filename).sort(), ['scene-take-01.png', 'scene-take-02.png', 'scene-take-03.png']);
    assert.equal(await readFile(join(directory, 'scene-take-00.png'), 'utf8'), 'existing export');
    for (const item of saved) assert.deepEqual(await readFile(item.path), png);
    // A fresh server still reads the directory rather than an in-memory counter.
    const second = await start(t, { downloadsDirectory });
    const next = await fetch(`${second.origin}/api/viewer/export?name=scene-take&${context}`, {method:'POST', headers:{'Content-Type':'image/png'}, body:png});
    assert.equal((await next.json()).filename, 'scene-take-04.png');
    assert.equal((await save('../escape')).status, 400);
    assert.equal((await save('scene', {'Origin':'https://example.com'})).status, 403);
    assert.equal((await save('scene', {'Content-Type':'text/plain'})).status, 415);
    assert.equal((await save('scene', {}, Buffer.from('not a PNG'))).status, 400);
    assert.equal((await readdir(directory)).length, 5);
});

test('project snapshot destinations travel with editor requests and isolate counters per project and database', async t => {
    const root = await mkdtemp(join(tmpdir(), 'studio-project-snaps-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const downloadsDirectory = join(root, 'Downloads');
    const projectTempDirectory = join(root, 'project with spaces', 'temp');
    const { post, subscribe, origin } = await start(t, { downloadsDirectory });
    const response = await post({ query: 'query text', database: 'pts-tour3', projectTempDirectory });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).projectSnapshots, true);
    const next = await subscribe();
    const request = await next();
    assert.equal(request.projectTempDirectory, projectTempDirectory);
    assert.equal(request.database, 'pts-tour3');
    assert.equal((await post({ query: 'text', projectTempDirectory: '../temp' })).status, 400);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
    const save = (database, directory = projectTempDirectory) => fetch(`${origin}/api/viewer/export?${new URLSearchParams({name:'motivation', database, projectTempDirectory:directory})}`, {
        method:'POST', headers:{'Content-Type':'image/png'}, body:png,
    });
    const first = await save('pts-tour3');
    assert.equal(first.status, 201);
    assert.equal((await first.json()).path, join(projectTempDirectory, 'imgs', 'pts-tour3', 'motivation-00.png'));
    assert.equal((await (await save('pts-tour3')).json()).filename, 'motivation-01.png');
    assert.equal((await (await save('other-db')).json()).path, join(projectTempDirectory, 'imgs', 'other-db', 'motivation-00.png'));
    const otherProject = join(root, 'second-project', 'temp');
    assert.equal((await (await save('pts-tour3', otherProject)).json()).path, join(otherProject, 'imgs', 'pts-tour3', 'motivation-00.png'));
    for (const badDatabase of ['..', '../escape', 'db/escape', 'db\\escape', '']) assert.equal((await save(badDatabase)).status, 400);
    assert.equal((await save('pts-tour3', 'relative/temp')).status, 400);
    const { stat } = await import('node:fs/promises');
    assert.equal(await stat(downloadsDirectory).catch(() => null), null, 'project saves must not create Downloads');
});

test('data snaps keep independent collision-safe names in the snaps folder', async t => {
    const downloadsDirectory = await mkdtemp(join(tmpdir(), 'studio-data-snaps-'));
    t.after(() => rm(downloadsDirectory, { recursive: true, force: true }));
    const { origin } = await start(t);
    const context = new URLSearchParams({projectTempDirectory: downloadsDirectory, database: 'test-db'});
    const directory = join(downloadsDirectory, 'snaps', 'test-db');
    await mkdir(directory, {recursive:true});
    const value = {format:'typedb-studio-graph-snap',version:1,query:'stored text',graph:{nodes:[],edges:[]},view:{}};
    const save = body => fetch(`${origin}/api/viewer/snap?name=motivation&${context}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    await writeFile(join(directory,'motivation-00.png'),'image');
    const first = await save(value);assert.equal(first.status,201);
    assert.equal((await first.json()).filename,'motivation-00.snap.json');
    assert.equal((await (await save(value)).json()).filename,'motivation-01.snap.json');
    assert.equal((await save({...value,version:2})).status,400);
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(JSON.parse(await readFile(join(directory,'motivation-00.snap.json'),'utf8')),value);
});


test('project selection creates the real folder; snap listing and reopening survive server restart', async t => {
    const root = await mkdtemp(join(tmpdir(), 'studio-library-'));
    t.after(() => rm(root, {recursive:true,force:true}));
    await mkdir(join(root, 'temp'));
    const schemaFile = join(root, 'temp', 'schema_test-db.tql');
    await writeFile(schemaFile, '');
    const { origin, post } = await start(t);
    const context = new URLSearchParams({projectTempDirectory:join(root,'temp'),database:'test-db'});
    const directory = join(root,'temp','snaps','test-db');
    for (const path of [root, join(root,'temp'), schemaFile]) {
        const selected = await fetch(`${origin}/api/viewer/project?${new URLSearchParams({path,database:'test-db'})}`, {method:'POST'});
        assert.equal(selected.status,200);
        assert.equal((await selected.json()).directory,directory);
        assert.deepEqual(await readdir(directory),[]);
        assert.deepEqual(await readdir(join(root,'temp','imgs','test-db')),[]);
    }
    const invalid = await fetch(`${origin}/api/viewer/project?${new URLSearchParams({path:root,database:'../escape'})}`, {method:'POST'});
    assert.equal(invalid.status,400);
    const value = {format:'typedb-studio-graph-snap',version:1,query:'stored text',graph:{nodes:[],edges:[]},view:{}};
    const saved = await fetch(`${origin}/api/viewer/snap?name=scene&${context}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    assert.equal(saved.status,201);
    const {filename} = await saved.json();
    await writeFile(join(directory,'unrelated.png'),'not a snap');
    await symlink(schemaFile,join(directory,'linked.snap.json'));
    const second = await start(t);
    const list = await (await fetch(`${second.origin}/api/viewer/snaps?${context}`)).json();
    assert.deepEqual(list.files.map(f=>f.filename),[filename]);
    assert.equal(list.files[0].kind,'data');
    assert.equal(list.files[0].nodeCount,0);
    assert.equal(list.imageDirectory,join(root,'temp','imgs','test-db'));
    assert.equal(list.directory,directory);
    assert.ok(list.files[0].bytes>0);
    const open = name => fetch(`${second.origin}/api/viewer/snap?${context}&filename=${encodeURIComponent(name)}`);
    assert.deepEqual(await (await open(filename)).json(),value);
    for (const bad of ['../escape.snap.json','linked.snap.json','unrelated.png']) assert.equal((await open(bad)).status,400);
    assert.equal((await fetch(`${second.origin}/api/viewer/snaps?${context}`,{headers:{Origin:'https://example.com'}})).status,403);
    // No editor metadata or selection means a clear error, never a Downloads fallback.
    assert.equal((await fetch(`${second.origin}/api/viewer/snaps?database=test-db`)).status,400);
    assert.equal((await fetch(`${second.origin}/api/viewer/snap?name=scene&database=test-db`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).status,400);
    // A recent Neovim request also supplies the project when the browser does not know it.
    await post({query:'stored text',database:'test-db',projectTempDirectory:join(root,'temp')});
    const inferred = await (await fetch(`${origin}/api/viewer/snaps?database=test-db`)).json();
    assert.equal(inferred.directory,directory);
    assert.deepEqual(inferred.files.map(f=>f.filename),[filename]);
    const other = await (await fetch(`${origin}/api/viewer/snaps?${new URLSearchParams({projectTempDirectory:join(root,'temp'),database:'other-db'})}`)).json();
    assert.deepEqual(other.files,[]);
});

test('snap chips describe node names, and deletion removes only the named snap without confirmation', async t => {
    const root = await mkdtemp(join(tmpdir(), 'studio-delete-snap-'));
    t.after(() => rm(root, {recursive:true,force:true}));
    const { origin } = await start(t);
    const context = new URLSearchParams({database:'test-db',projectTempDirectory:root});
    const value = {format:'typedb-studio-graph-snap',version:1,query:'stored text',schemaMode:false,
        graph:{nodes:[{attributes:{metadata:{concept:{type:{label:'mental-state'}}}}}, {attributes:{metadata:{concept:{type:{label:'goal'}}}}}],edges:[]},view:{}};
    const save = async name => (await fetch(`${origin}/api/viewer/snap?${context}&name=${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})).json();
    const first=await save('first');const second=await save('second');
    const list=await(await fetch(`${origin}/api/viewer/snaps?${context}`)).json();
    assert.equal(list.files[0].abbreviation,'me st go');
    const titled=await (await fetch(`${origin}/api/viewer/snap?${context}&name=8d-read-the-patt-bind&digits=1`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...value,title:'8d · Read the pattern bindings.'})})).json();
    assert.equal(titled.filename,'8d-read-the-patt-bind-0.snap.json');
    const titledList=await(await fetch(`${origin}/api/viewer/snaps?${context}`)).json();
    assert.equal(titledList.files.find(file=>file.filename===titled.filename).abbreviation,'8d read the patt bind 0');
    await fetch(`${origin}/api/viewer/snap?${context}&filename=${titled.filename}`,{method:'DELETE'});
    const remove=(filename,headers={})=>fetch(`${origin}/api/viewer/snap?${context}&filename=${encodeURIComponent(filename)}`,{method:'DELETE',headers});
    assert.equal((await remove(first.filename,{Origin:'https://example.com'})).status,403);
    assert.equal((await remove('../second-00.snap.json')).status,400);
    assert.equal((await remove('image.png')).status,400);
    assert.equal((await remove(first.filename)).status,200);
    assert.equal((await remove(first.filename)).status,400);
    const remaining=await(await fetch(`${origin}/api/viewer/snaps?${context}`)).json();
    assert.deepEqual(remaining.files.map(file=>file.filename),[second.filename]);
    assert.equal(await readFile(first.path).catch(()=>null),null);
    assert.ok(await readFile(second.path));
});
