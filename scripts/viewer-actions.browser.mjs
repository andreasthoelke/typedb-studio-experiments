/** Isolated end-to-end test of schema @meta defaults, the node action strip,
 * the Data view and direct attribute edits. Owns its TypeDB data, ports,
 * browser and bridge; never touches the user's server or databases. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViewerServer } from './viewer-server.mjs';

const root = await mkdtemp(join(tmpdir(), 'studio-actions-'));
const freePort = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const httpPort = await freePort(), grpcPort = await freePort(), address = `http://localhost:${httpPort}`;
const typedb = spawn(process.env.TYPEDB_TEST_BINARY || join(homedir(), '.typedb/server/typedb_server_bin'), [
    '--server.listen-address', `127.0.0.1:${grpcPort}`, '--server.http.enabled', 'true', '--server.http.listen-address', `127.0.0.1:${httpPort}`,
    '--storage.data-directory', join(root, 'data'), '--logging.directory', join(root, 'logs'),
    '--storage.rocksdb.cache-size', '128mb', '--storage.rocksdb.write-buffers-limit', '128mb',
    '--diagnostics.reporting.metrics', 'false', '--diagnostics.reporting.errors', 'false'], { cwd: root });
let logs = ''; typedb.stdout.on('data', d => logs += d); typedb.stderr.on('data', d => logs += d);
let browser, server;
try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(address + '/v1/version')).ok) break; } catch {} if (typedb.exitCode !== null) throw Error(logs); await new Promise(r => setTimeout(r, 200)); }
    const { token } = await (await fetch(address + '/v1/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password' }) })).json();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const database = 'actions_fixture';
    assert.equal((await fetch(address + '/v1/databases/' + database, { method: 'POST', headers })).status, 200);
    const q = async (transactionType, query) => {
        const response = await fetch(address + '/v1/query', { method: 'POST', headers, body: JSON.stringify({ databaseName: database, transactionType, query }) });
        const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
    };
    await q('schema', `define
        attribute title value string; attribute scene-id value string; attribute note value string; attribute n value integer;
        entity scene @meta("graph-label", "scene-id, title"), owns scene-id @key, owns title, owns note @card(0..3), owns n @card(0..1), plays occurrence-of:subject;
        entity occurrence, owns title, plays occurrence-of:occurrence;
        relation occurrence-of, relates occurrence @meta("graph-arrow", "relation"), relates subject @meta("graph-arrow", "none");`);
    await q('write', `insert $s1 isa scene, has scene-id "S1", has title "Opening"; $s2 isa scene, has scene-id "S2", has title "Middle";
        $o isa occurrence, has title "Fear here"; occurrence-of (occurrence: $o, subject: $s1);`);
    const values = async (sceneId, attribute) => (await q('read', `match $s isa scene, has scene-id "${sceneId}", has ${attribute} $v; fetch { "v": $v };`)).answers.map(a => a.v).sort();

    server = createViewerServer({ windowFocus: () => ({ focused: true }) });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://localhost:${server.address().port}`;
    let playwright;
    if (process.env.PLAYWRIGHT_MODULE) playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
    else { try { playwright = await import('playwright'); } catch { for (const dir of await readdir(join(homedir(), '.npm/_npx')).catch(() => [])) { try { playwright = await import(pathToFileURL(join(homedir(), '.npm/_npx', dir, 'node_modules/playwright/index.mjs')).href); break; } catch {} } } }
    assert.ok(playwright, 'Install Playwright or set PLAYWRIGHT_MODULE');
    browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await context.addInitScript(url => localStorage.setItem('typeDBStudio.connections', JSON.stringify([{ name: 'Isolated', url, preferences: { isStartupConnection: true } }])), `typedb://admin:password@${address}/${database}`);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.stack));
    await page.goto(origin + '/query?nvim=1');
    await new Promise(r => setTimeout(r, 1500));
    await fetch(origin + '/api/viewer/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database, query: 'match $s isa scene; $o isa occurrence; occurrence-of (occurrence: $o, subject: $s);' }) });
    await page.waitForFunction(() => { const p = window.ng?.getComponent(document.querySelector('ts-query-page')); return p?.state.graphOutput.visualiser?.graph.order > 0 && !p.bridge.busy && !p.bridge.pending; }, null, { timeout: 60000 });
    const canvas = (fn, arg) => page.evaluate(fn, arg);

    // Schema @meta: arrows per role and a two-attribute label, with no user settings.
    await page.waitForFunction(() => { const s = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.styleService; return !!s.schemaDefaults; });
    const arrows = await canvas(() => { const s = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.styleService;
        return [s.getRoleArrow('occurrence-of:occurrence'), s.getRoleArrow('occurrence-of:subject'), s.getRoleArrow('evidence:claimed')]; });
    assert.deepEqual(arrows, ['relation', 'none', 'player']);
    const sceneLabel = () => canvas(() => { const v = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        return v.graph.nodes().map(k => v.graph.getNodeAttribute(k, 'label')).filter(l => l.startsWith('scene: S1'))[0]; });
    await page.waitForFunction(() => { const v = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser; return v.graph.nodes().some(k => v.graph.getNodeAttribute(k, 'label') === 'scene: S1 · Opening'); }, null, { timeout: 15000 });

    // The action strip on the Explorer header: exact selection, mark, hide, go to.
    const s1 = await canvas(() => { const c = window.ng.getComponent(document.querySelector('ts-graph-canvas')), v = c.visualiser;
        const key = v.graph.nodes().find(k => v.graph.getNodeAttribute(k, 'label') === 'scene: S1 · Opening'); v.pointCaret(key, 'none', true); c.paneFocus.focus('explorer'); return key; });
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('ts-graph-instance-explorer'))?.state.attributes.length > 0);
    const header = page.locator('ts-graph-instance-explorer .type-section');
    await header.getByRole('button', { name: 'Selected this node', exact: true }).click();
    const strip = () => canvas(key => { const v = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        return { selected: [...v.elementSelection.nodes], marked: v.isMarked(key), hidden: !!v.graph.getNodeAttribute(key, 'viewHidden'), caret: v.navigation.caret }; }, s1);
    assert.deepEqual((await strip()).selected, [s1], 'Selecting from the strip selects exactly this node, not the whole graph');
    await page.getByText('Selection (1)', { exact: true }).waitFor();
    await header.getByRole('button', { name: 'Marked this node', exact: true }).click();
    await header.getByRole('button', { name: 'Hidden this node', exact: true }).click();
    assert.deepEqual(await strip(), { selected: [s1], marked: true, hidden: true, caret: s1 });
    await header.getByRole('button', { name: 'Go to this node', exact: true }).click();
    assert.equal((await strip()).hidden, false, 'Go to shows a hidden node');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    assert.deepEqual((await strip()).selected, [], 'Clear empties the selection');
    // Clear also resets inspection; return the caret to S1 for editing.
    await canvas(key => { const c = window.ng.getComponent(document.querySelector('ts-graph-canvas')); c.visualiser.pointCaret(key, 'none', true); c.paneFocus.focus('explorer'); }, s1);
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('ts-graph-instance-explorer'))?.state.attributes.length > 0);

    // Explorer edits write to the database once and update the label.
    const explorer = page.locator('ts-graph-instance-explorer');
    await explorer.getByRole('button', { name: 'Edit title value', exact: true }).click();
    await explorer.getByRole('textbox', { name: 'New title value' }).fill('Renamed');
    await explorer.getByRole('textbox', { name: 'New title value' }).press('Enter');
    await explorer.getByText('Saved title.').waitFor();
    assert.deepEqual(await values('S1', 'title'), ['Renamed']);
    assert.equal(await sceneLabel(), 'scene: S1 · Renamed', 'The label follows the edit without a re-read');
    await explorer.getByRole('button', { name: 'Add note value', exact: true }).click();
    await explorer.getByRole('textbox', { name: 'New note value' }).fill('first "quoted" note');
    await explorer.getByRole('textbox', { name: 'New note value' }).press('Enter');
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('ts-graph-instance-explorer')).state.attributes.some(a => a.type === 'note'));
    assert.deepEqual(await values('S1', 'note'), ['first "quoted" note']);
    await explorer.getByRole('button', { name: 'Remove note value', exact: true }).click();
    assert.deepEqual(await values('S1', 'note'), ['first "quoted" note'], 'The first click only arms removal');
    await explorer.getByRole('button', { name: 'Confirm removing note value', exact: true }).click();
    await page.waitForFunction(() => !window.ng.getComponent(document.querySelector('ts-graph-instance-explorer')).state.attributes.some(a => a.type === 'note'));
    assert.deepEqual(await values('S1', 'note'), []);
    // Invalid input never reaches the database.
    await q('write', 'match $s isa scene, has scene-id "S1"; insert $s has n 1;');
    await canvas(() => window.ng.getComponent(document.querySelector('ts-graph-instance-explorer')).state.refresh());
    await explorer.getByRole('button', { name: 'Edit n value', exact: true }).click();
    await explorer.getByRole('textbox', { name: 'New n value' }).fill('abc');
    await explorer.getByRole('textbox', { name: 'New n value' }).press('Enter');
    await explorer.getByText('Enter a whole number.').waitFor();
    assert.deepEqual(await values('S1', 'n'), [1]);
    // A value changed elsewhere: nothing is written and the inspector re-reads.
    await q('write', 'match $s isa scene, has scene-id "S1", has n $v; delete has $v of $s; insert $s has n 7;');
    await explorer.getByRole('textbox', { name: 'New n value' }).fill('2');
    await explorer.getByRole('textbox', { name: 'New n value' }).press('Enter');
    await explorer.getByText(/Nothing changed/).waitFor();
    assert.deepEqual(await values('S1', 'n'), [7]);

    // Space Ctrl-f/d cycles the Explorer's sub-tabs (here → every → data);
    // plain Ctrl-f/d still cycles the panel's main tabs.
    const subtab = () => page.evaluate(() => [...document.querySelectorAll('[data-subtabs] [data-subtab].active')].map(b => b.textContent.trim())[0]);
    await canvas(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('panel'));
    assert.equal(await subtab(), 'here');
    await page.keyboard.press(' '); await page.keyboard.press('Control+f');
    await page.waitForFunction(() => document.querySelector('[data-subtabs] [data-subtab].active')?.textContent.trim().startsWith('every'));
    await page.keyboard.press(' '); await page.keyboard.press('Control+f');
    await page.locator('ts-graph-data-table').waitFor();
    assert.equal(await subtab(), 'data');
    await page.keyboard.press(' '); await page.keyboard.press('Control+d');
    await page.waitForFunction(() => document.querySelector('[data-subtabs] [data-subtab].active')?.textContent.trim().startsWith('every'));
    assert.equal(await page.locator('[data-panel-tab="explorer"]').getAttribute('aria-selected'), 'true', 'Sub-tab cycling keeps the main tab');
    // Data view: graph rows, a cell edit, and the database source.
    await page.getByRole('button', { name: 'data', exact: true }).click();
    const table = page.locator('ts-graph-data-table');
    await table.getByRole('table', { name: 'Instance data' }).waitFor();
    const headers_ = await table.locator('thead th').allInnerTexts();
    assert.equal(headers_[1].trim(), 'scene-id', `Identifying attribute first: ${headers_.join('|')}`);
    // Graph rows: only S1 is loaded (S2 plays no role in the query).
    assert.equal(await table.locator('tbody tr').count(), 1);
    await table.locator('tbody tr').filter({ hasText: 'S1' }).getByRole('button', { name: 'Edit title of scene', exact: true }).click();
    await table.getByRole('textbox', { name: 'New title value' }).fill('From the table');
    await table.getByRole('textbox', { name: 'New title value' }).press('Enter');
    await table.getByText('Saved title.').waitFor();
    assert.deepEqual(await values('S1', 'title'), ['From the table']);
    assert.equal(await sceneLabel(), 'scene: S1 · From the table');
    // Database rows include instances outside the graph; they can be edited and added.
    await table.getByRole('radio', { name: 'database' }).click();
    await page.waitForFunction(() => window.ng.getComponent(document.querySelector('ts-graph-data-table')).rows.length === 2);
    const s2row = table.locator('tbody tr').filter({ hasText: 'S2' });
    await s2row.getByRole('button', { name: 'Edit title of scene', exact: true }).click();
    await table.getByRole('textbox', { name: 'New title value' }).fill('Second');
    await table.getByRole('textbox', { name: 'New title value' }).press('Enter');
    await table.getByText('Saved title.').waitFor();
    assert.deepEqual(await values('S2', 'title'), ['Second']);
    assert.match(await s2row.innerText(), /Second/);
    await s2row.getByRole('button', { name: 'Add to graph scene', exact: true }).click();
    await page.waitForFunction(() => { const v = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser; return v.graph.nodes().some(k => v.graph.getNodeAttribute(k, 'label') === 'scene: S2 · Second'); }, null, { timeout: 15000 });
    // Ctrl-= / Ctrl-- step the layout density from graph focus.
    await canvas(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('graph'));
    const density = () => canvas(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.layoutDensity);
    const before = await density();
    await page.keyboard.press('Control+=');
    assert.notEqual(await density(), before, 'Ctrl-= makes the layout roomier');
    await page.keyboard.press('Control+-');
    assert.equal(await density(), before, 'Ctrl-- steps back');
    // Panel keyboard stops in a non-Explorer tab: Ctrl-n/p walk the controls,
    // the focus ring shows, Space activates after its leader wait, Space Space
    // at once, and Space Ctrl-n still jumps sections without activating.
    await canvas(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('panel'));
    await page.locator('[data-panel-tab="customise"]').click();
    await canvas(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('panel'));
    const active = () => page.evaluate(() => { const a = document.activeElement; return { label: a?.getAttribute('aria-label') ?? '', text: a?.textContent.trim() ?? '',
        role: a?.getAttribute('role') ?? '', ring: a ? getComputedStyle(a).outlineWidth : '', visible: !!a?.matches(':focus-visible, .kbd-focus') }; });
    const walkTo = async (predicate, key = 'Control+n') => { for (let i = 0; i < 80; i++) { await page.keyboard.press(key); const a = await active(); if (predicate(a)) return a; } throw Error('Ctrl-n never reached the control'); };
    await walkTo(a => a.text === "Settings");
    const arrow = await walkTo(a => a.label === 'Arrowhead size');
    assert.ok(arrow.visible && arrow.ring === '2px', `Focus ring on keyboard stops: ${JSON.stringify(arrow)}`);
    await page.keyboard.press('ArrowRight');
    assert.equal(await canvas(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).liveStyleService.arrowHeadScale), 1.05);
    assert.match(await page.locator('.style-row').filter({ hasText: 'Arrowhead size' }).innerText(), /105%/);
    const rows = await page.locator('.style-row .style-label').allInnerTexts();
    assert.equal(rows[rows.indexOf('Node fill opacity') + 1], 'Arrowhead size', 'Arrowhead size sits just below Node fill opacity');
    await page.keyboard.press('Control+p');
    assert.equal((await active()).label, '', 'Ctrl-p steps back from the slider');
    await walkTo(a => a.role === 'switch');
    const labels = () => canvas(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).liveStyleService.labelsVisible);
    const shown = await labels();
    await page.keyboard.press(' ');
    assert.equal(await labels(), shown, 'Space waits for a leader continuation');
    await page.waitForFunction(v => window.ng.getComponent(document.querySelector('ts-graph-canvas')).liveStyleService.labelsVisible !== v, shown, { timeout: 2000 });
    await page.keyboard.press(' '); await page.keyboard.press(' ');
    assert.equal(await labels(), shown, 'Space Space activates at once');
    await page.keyboard.press(' '); await page.keyboard.press('Control+n');
    await page.waitForTimeout(700);
    assert.equal(await labels(), shown, 'Space Ctrl-n does not activate');
    assert.notEqual((await active()).role, 'switch', 'Space Ctrl-n moved focus');
    assert.ok(errors.length === 0, errors.join('\n'));
    console.log('PASS isolated: schema @meta arrows and labels, Space Ctrl-f/d sub-tabs, Ctrl-=/- density, panel Ctrl-n/p stops with focus ring and Space activation, arrowhead size, action strip (exact select, mark, hide, go to), Explorer edit/add/remove with confirmation, validation, stale-value refusal, Data view identifying columns, graph and database cell edits, adding a database row to the graph');
} finally {
    await browser?.close(); server?.closeAllConnections(); server?.close();
    typedb.kill(); await once(typedb, 'exit').catch(() => {}); await rm(root, { recursive: true, force: true });
}
