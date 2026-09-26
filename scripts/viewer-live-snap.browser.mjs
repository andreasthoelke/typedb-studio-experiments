import { checkRoleEdges } from "./role-edges.browser-checks.mjs";
/** Live read-only smoke check: restore saved results, then expand them with the normal Explorer.
 * Requires a built local viewer and an existing TypeDB database containing motivation/goal/scene.
 * Set PLAYWRIGHT_MODULE, TYPEDB_TEST_CONNECTION, TYPEDB_TEST_DATABASE as needed.
 * Synthetic completed-schema notifications trigger context reads; no writes are performed.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViewerServer } from './viewer-server.mjs';
import { checkGraphNavigation } from './graph-navigation.browser-checks.mjs';
import { checkGraphCustomise } from './graph-customise.browser-checks.mjs';
import { checkEditorCaret } from './editor-caret.browser-checks.mjs';
let playwright;
if(process.env.PLAYWRIGHT_MODULE) playwright=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
else {
 try { playwright=await import('playwright'); } catch {
  for(const dir of await readdir(join(homedir(),'.npm/_npx')).catch(()=>[])) {
   try { playwright=await import(pathToFileURL(join(homedir(),'.npm/_npx',dir,'node_modules/playwright/index.mjs')).href);break; } catch {}
  }
 }
}
assert.ok(playwright,'Install Playwright or set PLAYWRIGHT_MODULE');
const database=process.env.TYPEDB_TEST_DATABASE || 'pts-tour3';
const connection=process.env.TYPEDB_TEST_CONNECTION || `typedb://admin:password@http://localhost:8000/${database}`;
const root=await mkdtemp(join(tmpdir(),'studio-live-snap-')), projectTempDirectory=join(root,'temp');
const server=createViewerServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://localhost:${server.address().port}`;
const browser=await playwright.chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1500,height:1000}});
await context.addInitScript(connection=>localStorage.setItem('typeDBStudio.connections',JSON.stringify([{name:'Local test',url:connection,preferences:{isStartupConnection:true}}])),connection);
const query=await context.newPage(), schema=await context.newPage(), errors=[];
for(const page of [query,schema]) page.on('pageerror',error=>errors.push(error.stack));
const selection=()=>schema.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-schema-page')).state.visualiser.visualiser;return [...v.elementSelection.nodes].map(key=>v.graph.getNodeAttribute(key,'metadata').concept.label).sort();});
const send=async(source, execution)=>{
 const response=await query.request.post(origin+'/api/viewer/query',{data:{query:source,database,projectTempDirectory,...(execution?{execution}:{})}});
 assert.equal(response.status(),202);const {id}=await response.json();
 await query.waitForFunction(id=>{const b=window.ng?.getComponent(document.querySelector('ts-query-page'))?.bridge;return b?.lastRequest?.id===id&&!b.pending&&!b.busy;},id,{timeout:30000});
 return id;
};
const waitSchema=id=>schema.waitForFunction(id=>{const b=window.ng?.getComponent(document.querySelector('ts-schema-page'))?.bridge;return b?.lastRequest?.id===id&&!b.pending;},id,{timeout:30000});
try {
 await Promise.all([query.goto(origin+'/query?nvim=1'),schema.goto(origin+'/schema?nvim=1')]);
 await waitSchema(await send('match $item isa motivation; $item isa! $concrete;'));
 await query.bringToFront();
 const inspected=await query.evaluate(()=>{
  const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
  v.layout.stop();const key=v.graph.nodes().find(key=>v.graph.getNodeAttribute(key,'metadata').concept.type?.label==='motivation');
  v.interactionHandler.focusInstance(key);return key;
 });
 const save=async()=>{
  const response=query.waitForResponse(r=>r.url().includes('/api/viewer/snap?')&&r.request().method()==='POST');
  await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).saveSnap());
  return (await response).json();
 };
 const originalFile=await save(), originalText=await readFile(originalFile.path,'utf8'), original=JSON.parse(originalText);
 await waitSchema(await send('match $item isa goal;'));
 const beforeCounter=await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-query-page')).state.currentTabOutputState.runCounter);
 await query.evaluate(filename=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).openSavedSnap(filename),originalFile.filename);
 await query.waitForFunction(()=>!!window.ng.getComponent(document.querySelector('ts-query-page')).currentRun?.restoredSnap);
 const restored=await query.evaluate(()=>{
  const p=window.ng.getComponent(document.querySelector('ts-query-page')),c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));
  return {query:p.queryTabsState.getTabControl(p.queryTabsState.currentTab).value,runQuery:p.currentRun.query,graph:c.visualiser.graph.export(),camera:c.visualiser.sigma.getCamera().getState(),inline:!!c.inlineSnap,snapshot:c.snapshotMode,counter:p.state.currentTabOutputState.runCounter,lastResponse:p.currentRun.lastResponse};
 });
 assert.equal(restored.query,original.query);assert.equal(restored.runQuery,original.query);
 assert.equal(restored.counter,beforeCounter+1);assert.equal(restored.lastResponse,null,'Restoration must not execute the saved source');
 assert.equal(restored.inline,false);assert.equal(restored.snapshot,false);
 assert.deepEqual(restored.graph,original.graph);assert.deepEqual(restored.camera,original.view.camera);
 await schema.waitForFunction(source=>window.ng.getComponent(document.querySelector('ts-schema-page')).contextQuery===source,original.query);
 await query.getByRole('tab',{name:'Explorer',exact:true}).click();
 await query.getByRole('button',{name:'here',exact:true}).waitFor();
 await query.getByRole('button',{name:"every 'motivation'",exact:true}).waitFor();
 const explorer=query.locator('ts-graph-instance-explorer');
 await query.waitForFunction(()=>{const e=window.ng.getComponent(document.querySelector('ts-graph-instance-explorer'));return e?.hasSelection&&!e.state.loading&&e.state.attributes.length>0;});
 const count=await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order);
 await explorer.locator('.detail-section').filter({has:query.getByRole('heading',{name:'Attributes',exact:true})}).getByRole('button',{name:'Add all to graph',exact:true}).click();
 await query.waitForFunction(count=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order>count,count);
 await query.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-query-page')).currentRun.expansionQueries.length>0);
 // The header action strip's eye toggles hiding; aria-pressed reflects the state.
 const hideToggle=explorer.locator('.type-section').getByRole('button',{name:'Hidden this node',exact:true});
 await hideToggle.click();
 assert.equal(await query.evaluate(key=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.getNodeAttribute(key,'viewHidden'),inspected),true);
 assert.equal(await hideToggle.getAttribute('aria-pressed'),'true');
 await hideToggle.click();
 assert.equal(await query.evaluate(key=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.getNodeAttribute(key,'viewHidden'),inspected),false);
 await query.getByRole('button',{name:"every 'motivation'",exact:true}).click();
 await query.locator('ts-graph-type-explorer').waitFor();
 await query.getByRole('button',{name:'here',exact:true}).click();
 // Rebuild the canvas, then expand again; the restored run remains the target.
 const expanded=await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order);
 await query.locator('.dock-kebab').click();await query.getByRole('menuitem',{name:'Dock to bottom',exact:true}).click();
 await query.waitForTimeout(300);
 assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order),expanded);
 await query.waitForFunction(()=>{const e=window.ng.getComponent(document.querySelector('ts-graph-instance-explorer'));return e?.hasSelection&&!e.state.loading&&!e.state.relationsLoading;});
 const relationCount=await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order);
 await explorer.locator('.detail-section').filter({has:query.getByRole('heading',{name:'Relations',exact:true})}).getByRole('button',{name:'Add all to graph',exact:true}).first().click();
 await query.waitForFunction(count=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order>count,relationCount);
 const nextFile=await save(), next=JSON.parse(await readFile(nextFile.path,'utf8'));
 assert.equal(next.query,original.query);assert.ok(next.graph.nodes.length>original.graph.nodes.length);assert.ok(next.expansionQueries.length>original.expansionQueries.length);
 assert.equal(await readFile(originalFile.path,'utf8'),originalText,'Exploration must not modify the source snap file');
 // Reopen expanded data exactly; a following Neovim run replaces it normally.
 await query.evaluate(filename=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).openSavedSnap(filename),nextFile.filename);
 assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order),next.graph.nodes.length);
 const pinnedRun=await query.evaluate(()=>{const p=window.ng.getComponent(document.querySelector('ts-query-page'));p.currentRun.pinned=true;return p.currentRun.id;});
 await waitSchema(await send('match $item isa scene;'));
 assert.equal(await query.evaluate(()=>!!window.ng.getComponent(document.querySelector('ts-query-page')).currentRun.restoredSnap),false);
 assert.ok(await query.evaluate(id=>{const p=window.ng.getComponent(document.querySelector('ts-query-page'));return p.state.currentTabRuns.some(run=>run.id===id&&run.pinned&&run.restoredSnap);},pinnedRun));
 await query.evaluate(id=>{const p=window.ng.getComponent(document.querySelector('ts-query-page'));p.state.selectRun(p.state.currentTabRuns.findIndex(run=>run.id===id));},pinnedRun);
 await query.waitForFunction(()=>!!window.ng.getComponent(document.querySelector('ts-query-page')).currentRun.graph.visualiser);
 assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapshotMode),false);
 assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order),next.graph.nodes.length);
 // A working subset remains an expandable normal run, including after save and remount.
 const whole=await query.evaluate(key=>{
  const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
  v.stopLayout();const saved=structuredClone(v.graph.export());
  v.elementSelection.replace([key]);v.isolateSelection();v.stopLayout();
  return saved;
 },inspected);
 await query.getByRole('tab',{name:'Explorer',exact:true}).click();
 await query.waitForFunction(()=>{const e=window.ng.getComponent(document.querySelector('ts-graph-instance-explorer'));return e?.hasSelection&&!e.state.loading;});
 await explorer.locator('.detail-section').filter({has:query.getByRole('heading',{name:'Attributes',exact:true})}).getByRole('button',{name:'Add all to graph',exact:true}).click();
 await query.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.order>1);
 assert.equal(await query.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return v.graph.nodes().every(key=>v.elementSelection.nodes.has(key));}),true,'New Explorer nodes join the working selection');
 const workingFile=await save();
 await query.evaluate(filename=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).openSavedSnap(filename),workingFile.filename);
 assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.hasWorkingContext),true);
 await query.locator('.dock-kebab').click();await query.getByRole('menuitem',{name:'Dock to right',exact:true}).click();
 await query.waitForTimeout(300);
 await query.getByRole('button',{name:'Restore context',exact:true}).first().click();
 const fullAgain=await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.export());
 for(const node of whole.nodes){
  const current=fullAgain.nodes.find(n=>n.key===node.key);assert.ok(current,'Original node restored');
  assert.equal(current.attributes.x,node.attributes.x);assert.equal(current.attributes.y,node.attributes.y);
 }
 await checkGraphNavigation(query, 'query');
    await checkGraphCustomise(query, 'query');
 await checkEditorCaret(query,schema,database);
 await checkRoleEdges(query,database);
 assert.deepEqual(errors,[]);
 console.log('PASS working subset expansion, save/open, remount and context restoration; live snap restores exact graph/camera/query without rerunning, updates Schema, exposes here/every, expands attributes and relations, hides/shows, survives docking, saves a separate expanded snap, and remains available as a pinned run after the next Neovim query');
} catch(error) {
 console.error(errors);console.error(await query.locator('body').innerText());throw error;
} finally {
 await browser.close();server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});
}
