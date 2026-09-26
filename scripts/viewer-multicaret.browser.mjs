/** Live, read-only check of secondary carets: Neovim geo on a typed variable
 * and on an anonymous relation, and Schema → Query Space Enter through the
 * isa closure (abstract stage-intent → its subtypes' instances). Requires the
 * pts-tour3 specimen; override TYPEDB_TEST_CONNECTION/TYPEDB_TEST_DATABASE. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViewerServer } from './viewer-server.mjs';
let pw;
if (process.env.PLAYWRIGHT_MODULE) pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
else for (const dir of await readdir(join(homedir(), '.npm', '_npx'))) {
    try { pw = await import(pathToFileURL(join(homedir(), '.npm', '_npx', dir, 'node_modules/playwright/index.mjs')).href); break; } catch {}
}
if (!pw) throw Error('Set PLAYWRIGHT_MODULE');
const database = process.env.TYPEDB_TEST_DATABASE || 'pts-tour3';
const connection = process.env.TYPEDB_TEST_CONNECTION || `typedb://admin:password@http://localhost:8000/${database}`;
const server = createViewerServer({ windowFocus: () => ({ focused: true }) }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://localhost:${server.address().port}`;
const browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
await context.addInitScript(url => localStorage.setItem('typeDBStudio.connections', JSON.stringify([{ name: 'Multi-caret test', url, preferences: { isStartupConnection: true } }])), connection);
const errors = [];
const canvas = page => page.evaluate(() => { const v = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
    return { caret: v.navigation.caret, marks: [...v.correspondenceNodes], types: [...v.correspondenceNodes].map(k => v.graph.getNodeAttribute(k, 'metadata').concept.type?.label ?? v.graph.getNodeAttribute(k, 'metadata').concept.label) }; });
const post = (path, data) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
try {
    const query = await context.newPage(); query.on('pageerror', e => errors.push(String(e)));
    await query.goto(origin + '/query?nvim=1');
    const ready = () => query.waitForFunction(() => { const p = window.ng.getComponent(document.querySelector('ts-query-page')); return p?.state.graphOutput.visualiser?.graph.order > 0 && !p.bridge.busy && !p.bridge.pending; });
    const stages = 'match\n  $scene isa scene;\n  scene-take (scene: $scene, take: $take);\n  take-includes (take: $take, member: $claim);\n  in-script (scene: $scene, element: $intent);\n  $intent isa stage-intent;';
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await post('/api/viewer/query', { query: stages, database })).status, 202);
    await ready();
    // Instances of stage-intent: every loaded relation whose type is in its subtype closure.
    const intents = () => query.evaluate(() => { const c = window.ng.getComponent(document.querySelector('ts-graph-canvas')), v = c.visualiser;
        const family = new Set(), pending = [c.schemaState.value$.value.relations['stage-intent']];
        while (pending.length) { const t = pending.pop(); family.add(t.label); pending.push(...t.subtypes); }
        return v.graph.nodes().filter(k => { const concept = v.graph.getNodeAttribute(k, 'metadata').concept; return concept.kind === 'relation' && family.has(concept.type.label); }).sort(); });
    const before = await intents();
    await post('/api/viewer/caret', { source: stages, line: 5, column: 2, schemaOnly: false, database });
    await query.waitForFunction(() => window.ng.getComponent(document.querySelector('ts-query-page')).bridge.caretMessage.startsWith('Caret:'));
    const geo = await canvas(query), loaded = await intents();
    console.log('geo $intent:', geo.marks.length, 'marks;', before.length, 'intents before,', loaded.length, 'after;', await query.evaluate(() => window.ng.getComponent(document.querySelector('ts-query-page')).bridge.caretMessage));
    assert.ok(loaded.length > 1 && geo.marks.includes(geo.caret));
    // The paragraph read (scene → in-script → intent) marks exactly the paragraph's intents.
    assert.deepEqual([...geo.marks].sort(), loaded, 'Every stage-intent instance of the paragraph is marked');

    const bindings = 'match\n  role-binding (instance: $pi, bound: $o), has role-name $rn;\n  occurrence-of (occurrence: $o, subject: $r);\n  $r has title $who;\nfetch { "pattern-role": $rn, "played-by": $who };';
    assert.equal((await post('/api/viewer/query', { query: bindings, database })).status, 202);
    await query.waitForFunction(() => window.ng.getComponent(document.querySelector('ts-query-page')).state.graphOutput.visualiser?.navigation.caret == null);
    await ready();
    await post('/api/viewer/caret', { source: bindings, line: 2, column: 2, schemaOnly: false, database });
    await query.waitForFunction(() => /^Caret: occurrence-of/.test(window.ng.getComponent(document.querySelector('ts-query-page')).bridge.caretMessage));
    const occ = await canvas(query);
    console.log('geo occurrence-of:', occ.marks.length, occ.types);
    assert.ok(occ.marks.length >= 2 && occ.types.every(t => t === 'occurrence-of'), 'All occurrence-of instances of the paragraph are marked');

    // geo on a schema `relates` clause marks the instances playing that role.
    const relates = 'relation occurrence-of,\n  relates occurrence @card(1..1),\n  relates subject @card(1..1);';
    await post('/api/viewer/caret', { source: relates, line: 2, column: relates.split('\n')[2].indexOf('subject'), schemaOnly: false, database });
    await query.waitForFunction(() => /^(Caret: subject|No visible)/.test(window.ng.getComponent(document.querySelector('ts-query-page')).bridge.caretMessage));
    const players = () => query.evaluate(() => { const v = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        return [...new Set(v.graph.filterEdges((_k, a) => { const d = a.metadata?.dataEdge; return d?.tag === 'links' && d.role?.label === 'occurrence-of:subject'; }).map(e => v.graph.target(e)))].sort(); });
    const clause = await canvas(query), subjects = await players();
    console.log('geo relates subject:', clause.marks.length, 'marks,', subjects.length, 'loaded subject players', [...new Set(clause.types)]);
    assert.ok(subjects.length >= 2 && clause.marks.length >= 2, 'Several subject players are loaded and marked');
    assert.ok(clause.marks.every(k => subjects.includes(k)), 'Every mark plays occurrence-of:subject');

    // Schema → Query: abstract stage-intent marks its subtypes' instances.
    assert.equal((await post('/api/viewer/query', { query: stages, database })).status, 202);
    await ready();
    const schema = await context.newPage(); schema.on('pageerror', e => errors.push(String(e)));
    await schema.goto(origin + '/schema');
    await schema.waitForFunction(() => { const v = window.ng.getComponent(document.querySelector('ts-graph-canvas'))?.visualiser; return v && v.graph.hasNode && v.graph.nodes().some(k => v.graph.getNodeAttribute(k, 'metadata').concept.label === 'stage-intent'); }, null, { timeout: 60000 });
    await schema.evaluate(() => { const c = window.ng.getComponent(document.querySelector('ts-graph-canvas')), v = c.visualiser;
        v.pointCaret(v.graph.nodes().find(k => v.graph.getNodeAttribute(k, 'metadata').concept.label === 'stage-intent')); c.paneFocus.focus('graph'); });
    // geo with the side panel focused: the panel's gg must hand the g back.
    await schema.evaluate(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('panel'));
    assert.equal(await schema.evaluate(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focusedPane), 'panel');
    const schemaCaret = await canvas(schema);
    await schema.keyboard.press('g'); await schema.keyboard.press('e'); await schema.keyboard.press('o');
    assert.equal((await canvas(schema)).caret, schemaCaret.caret, 'geo from the panel does not move the Schema caret');
    await query.waitForFunction(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.correspondenceNodes.size > 0, null, { timeout: 5000 }).catch(() => {});
    const related = await canvas(query);
    console.log('schema → query:', related.marks.length, [...new Set(related.types)], await query.evaluate(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).lastShortcut));
    assert.equal(related.marks.length, (await intents()).length, 'Schema stage-intent marks every instance of its subtypes');
    // Schema role type → Query: the loaded players of that role.
    assert.equal((await post('/api/viewer/query', { query: bindings, database })).status, 202);
    await query.waitForFunction(() => window.ng.getComponent(document.querySelector('ts-query-page')).state.graphOutput.visualiser?.navigation.caret == null);
    await ready();
    const roleNode = await schema.evaluate(() => { const c = window.ng.getComponent(document.querySelector('ts-graph-canvas')), v = c.visualiser;
        const key = v.graph.nodes().find(k => v.graph.getNodeAttribute(k, 'metadata').concept.label === 'occurrence-of:subject');
        if (key) { v.pointCaret(key); c.paneFocus.focus('graph'); } return key; });
    assert.ok(roleNode, 'The Schema graph shows the occurrence-of:subject role type');
    await schema.keyboard.press('g'); await schema.keyboard.press('e'); await schema.keyboard.press('o');
    await query.waitForFunction(() => /^Players of/.test(window.ng.getComponent(document.querySelector('ts-graph-canvas')).lastShortcut), null, { timeout: 5000 });
    const rolePlayers = await canvas(query), loadedPlayers = await players();
    console.log('schema role → query:', rolePlayers.marks.length, 'marks;', loadedPlayers.length, 'players');
    assert.deepEqual([...rolePlayers.marks].sort(), loadedPlayers.length > 1 ? loadedPlayers : [], 'A role marks exactly its loaded players');
    assert.ok(loadedPlayers.includes(rolePlayers.caret));
    assert.ok(errors.length === 0, errors.join('\n'));
    console.log('PASS live secondary carets: geo typed variable, anonymous relation and relates clause; schema → query isa closure and role players via geo, including from the side panel');
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
