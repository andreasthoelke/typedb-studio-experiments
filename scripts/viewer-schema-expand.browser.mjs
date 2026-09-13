/** Live read-only smoke check: expand schema-context Query results through real Explorer chips.
 * Requires a built local viewer and an existing TypeDB database containing scene, scene-take, take and take-includes.
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
const root=await mkdtemp(join(tmpdir(),'studio-schema-expand-')), projectTempDirectory=join(root,'temp');
const server=createViewerServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://localhost:${server.address().port}`;
const browser=await playwright.chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1500,height:1000}});
await context.addInitScript(connection=>localStorage.setItem('typeDBStudio.connections',JSON.stringify([{name:'Local test',url:connection,preferences:{isStartupConnection:true}}])),connection);
const query=await context.newPage(), errors=[];
query.setDefaultTimeout(30000);
query.on('pageerror',error=>errors.push(error.stack));
const send=async(source, execution)=>{
 const response=await query.request.post(origin+'/api/viewer/query',{data:{query:source,database,projectTempDirectory,...(execution?{execution}:{})}});
 assert.equal(response.status(),202);const {id}=await response.json();
 await query.waitForFunction(id=>{const b=window.ng?.getComponent(document.querySelector('ts-query-page'))?.bridge;return b?.lastRequest?.id===id&&!b.pending&&!b.busy;},id,{timeout:30000});
 return id;
};
try {
 await query.goto(origin+'/query?nvim=1');
 await query.waitForFunction(()=>window.schemaState?.value$.value?.relations['take-includes']);
 const live=await query.evaluate(()=>{
  const s=window.schemaState.value$.value;
  const roles=s.relations['take-includes'].relatedRoles.map(r=>r.label);
  const players=[...Object.values(s.entities),...Object.values(s.relations)].filter(t=>t.playedRoles.some(r=>roles.includes(r.label))).map(t=>t.label);
  return {take:s.entities.take.playedRoles.map(r=>r.label),roles,players};
 });
 console.log('Live schema',live);
 assert.ok(live.take.some(label=>label.startsWith('take-includes:')));
 // A completion notification only: the schema definition is never executed by Studio.
 const source='relation scene-take relates scene @card(1), relates take @card(1);\nentity scene @meta("layer", "scenic-core"), owns scene-id @key, owns title, plays scene-take:scene;';
 await send(source,{kind:'schema',status:'success'});
 await query.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas'))?.visualiser?.graph.order>0);
 const graphState=()=>query.evaluate(()=>{
  const p=window.ng.getComponent(document.querySelector('ts-query-page')),v=p.currentRun.graph.visualiser;
  return {graph:v.graph.export(),query:p.currentRun.query,expansions:p.currentRun.expansionQueries||[],camera:v.sigma.getCamera().getState(),run:p.currentRun.id};
 });
 const inspect=async label=>{
  await query.evaluate(label=>{
   const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
   v.stopLayout();const key=v.graph.nodes().find(k=>v.graph.getNodeAttribute(k,'metadata').concept.label===label);
   if(!key)throw new Error('Missing '+label);v.interactionHandler.focusType(key);
  },label);
  await query.getByRole('tab',{name:'Explorer',exact:true}).click();
  await query.waitForFunction(label=>window.ng.getComponent(document.querySelector('ts-graph-type-explorer'))?.selectedType?.label===label,label);
 };
 const explorer=query.locator('ts-graph-type-explorer');
 const section=name=>explorer.locator('.schema-connections').filter({has:query.getByRole('heading',{name,exact:true})});
 const labels=state=>state.graph.nodes.map(n=>n.attributes.metadata.concept.label);
 await inspect('take');
 const before=await graphState();
 assert.ok(!labels(before).includes('take-includes'));
 await section('Relations').getByRole('button',{name:'take-includes',exact:true}).click();
 await query.waitForFunction(()=>{const e=window.ng.getComponent(document.querySelector('ts-graph-type-explorer'));return !e.schemaLoading;});
 assert.equal(await explorer.locator('[role=alert]').count(),0);
 const expanded=await graphState();
 assert.ok(labels(expanded).includes('take-includes'));
 for(const label of [...live.roles,...live.players])assert.ok(labels(expanded).includes(label),'Loaded role/player '+label);
 assert.ok(expanded.graph.edges.length>before.graph.edges.length);
 assert.equal(expanded.query,before.query);assert.equal(expanded.run,before.run);
 assert.equal(expanded.expansions.length,1);
 assert.deepEqual(expanded.camera,before.camera,'Additions preserve camera');
 assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-type-explorer')).selectedType.label),'take');
 // Same chip remains usable, but cannot duplicate graph nodes or edges.
 await section('Relations').getByRole('button',{name:'take-includes',exact:true}).click();
 await query.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-type-explorer')).schemaLoading);
 const twice=await graphState();
 assert.equal(twice.graph.nodes.length,expanded.graph.nodes.length);assert.equal(twice.graph.edges.length,expanded.graph.edges.length);
 // Removal is reversible and a role chip can reload its relation and edges.
 await query.evaluate(()=>{
  const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
  const key=v.graph.nodes().find(k=>v.graph.getNodeAttribute(k,'metadata').concept.label==='take-includes');v.removeFromGraph(key);
 });
 await section('Plays roles').getByRole('button',{name:live.take.find(l=>l.startsWith('take-includes:')),exact:true}).click();
 await query.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-type-explorer')).schemaLoading);
 assert.ok(labels(await graphState()).includes('take-includes'));
 const saveResponse=query.waitForResponse(r=>r.url().includes('/api/viewer/snap?')&&r.request().method()==='POST');
 await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).saveSnap());
 const saved=await(await saveResponse).json(),snap=JSON.parse(await readFile(saved.path,'utf8'));
 assert.equal(snap.expansionQueries.length,3);assert.ok(snap.schemaMode);
 assert.ok(await query.evaluate(filename=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapFiles.some(file=>file.filename===filename),saved.filename),'Schema-context snap appears in Query library');
 await query.evaluate(filename=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).openSavedSnap(filename),saved.filename);
 await query.waitForFunction(()=>!!window.ng.getComponent(document.querySelector('ts-query-page')).currentRun?.restoredSnap);
 await inspect('take');
 assert.equal(new URL(query.url()).pathname,'/query');
 // Section additions work on restored schema-mode Query runs too.
 await section('Relations').getByRole('button',{name:'Add all relations in graph',exact:true}).click();
 await query.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-type-explorer')).schemaLoading);
 assert.equal(await explorer.locator('[role=alert]').count(),0);
 const restored=await graphState();
 assert.equal(restored.expansions.length,4);
 for(const role of live.take)assert.ok(labels(restored).includes(role.split(':')[0]));
 assert.deepEqual(errors,[]);
 console.log('PASS schema Query Explorer loads missing relation/roles/players, preserves source and camera, deduplicates, reloads removed relations through role chips, and expands groups after snap restoration');
} catch(error) {
 console.error(errors);console.error(await query.locator('body').innerText());throw error;
} finally {
 await browser.close();server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});
}
