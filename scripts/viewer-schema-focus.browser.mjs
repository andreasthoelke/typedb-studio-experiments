/** Live read-only smoke check: two browser tabs follow one Neovim event.
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
const root=await mkdtemp(join(tmpdir(),'studio-schema-focus-')), projectTempDirectory=join(root,'temp');
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
 let source='match $item isa motivation; $item isa! $concrete;';
 await waitSchema(await send(source));
 let selected=await selection();
 for(const type of ['motivation','mental-state','goal']) assert.ok(selected.includes(type),type);
 assert.ok(selected.some(label=>label.startsWith('motivation:')));
 assert.equal(await schema.evaluate(()=>window.ng.getComponent(document.querySelector('ts-schema-page')).bridge.state.currentTabRuns.length),0,'Schema follower must not run a data query');
 assert.ok(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-query-page')).state.graphOutput.visualiser.graph.order>0));
 assert.equal(new URL(schema.url()).pathname,'/schema');
 await schema.bringToFront();
 await schema.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-schema-page')).focusFrame===0);
 await schema.waitForTimeout(400);
 await schema.screenshot({path:join(tmpdir(),'studio-schema-focus.png')});
 await schema.locator('.dock-kebab').click();
 await schema.getByRole('menuitem',{name:'Dock to bottom',exact:true}).click();
 await schema.waitForTimeout(250);
 assert.deepEqual(await selection(),selected,'Dock remount must preserve shared schema selection');
 await schema.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-schema-page')).state.visualiser.visualiser;v.elementSelection.replace([]);});
 assert.equal(await schema.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-schema-page')).state.visualiser.visualiser;return v.graph.nodes().every(key=>v.sigma.getSetting('nodeReducer')(key,v.graph.getNodeAttributes(key)).zIndex===0);}),true,'Remounted reducers must follow the new selection');
 const otherTabOptions=JSON.stringify({neighbours:false,seedVariable:'$other',relationTypes:'motivation'});
 await schema.evaluate(value=>localStorage.setItem('typedb-studio-nvim-options',value),otherTabOptions);
 await schema.getByRole('button',{name:'Refocus',exact:true}).click();
 assert.equal(await schema.evaluate(()=>localStorage.getItem('typedb-studio-nvim-options')),otherTabOptions,'Schema refocus must not overwrite data augmentation preferences');
 await schema.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-schema-page')).bridge.pending);
 assert.deepEqual(await selection(),selected);
 const stableSchema=await schema.evaluate(()=>{
  const v=window.ng.getComponent(document.querySelector('ts-schema-page')).state.visualiser.visualiser;
  v.stopLayout();const saved=structuredClone(v.graph.export());v.isolateSelection();v.stopLayout();
  if(!v.hasWorkingContext||v.graph.order>=saved.nodes.length) throw new Error('Schema was not reduced');
  return saved;
 });
 await waitSchema(await send(source));
 const restoredSchema=await schema.evaluate(()=>{
  const v=window.ng.getComponent(document.querySelector('ts-schema-page')).state.visualiser.visualiser;
  if(v.hasWorkingContext) throw new Error('New source did not restore the stable schema context');
  return v.graph.export();
 });
 assert.equal(restoredSchema.nodes.length,stableSchema.nodes.length);
 for(const node of stableSchema.nodes){
  const current=restoredSchema.nodes.find(n=>n.key===node.key);
  assert.equal(current.attributes.x,node.attributes.x);assert.equal(current.attributes.y,node.attributes.y);
 }
 await schema.getByRole('button',{name:'Neovim · following',exact:true}).click();
 await schema.waitForURL('**/schema?nvim=0');
 await send('match $item isa goal;');
 assert.deepEqual(await selection(),selected,'Paused schema must keep its view');
 await schema.getByRole('button',{name:'Follow Neovim',exact:true}).click();
 await schema.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-schema-page')).contextQuery==='match $item isa goal;');
 // Saving the focused schema includes the original source and project destination.
 const savedResponse=schema.waitForResponse(r=>r.url().includes('/api/viewer/snap?')&&r.request().method()==='POST');
 await schema.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).saveSnap());
 const saved=await (await savedResponse).json(), snap=JSON.parse(await readFile(saved.path,'utf8'));
 assert.equal(snap.query,'match $item isa goal;');assert.equal(snap.schemaMode,true);
 assert.equal(snap.project.projectTempDirectory,projectTempDirectory);
 await schema.evaluate(filename=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).openSavedSnap(filename),saved.filename);
 assert.ok(await schema.evaluate(()=>!!window.ng.getComponent(document.querySelector('ts-schema-page')).restoredSnap));
 source='relation scene-take relates scene, relates take; entity scene plays scene-take:scene;';
 await waitSchema(await send(source,{kind:'schema',status:'success'}));
 assert.equal(await schema.evaluate(()=>!!window.ng.getComponent(document.querySelector('ts-schema-page')).restoredSnap),false);
 selected=await selection();for(const label of ['scene','scene-take','take']) assert.ok(selected.includes(label),label);
 // An unknown/dynamic type cannot be inferred from source alone; preserve useful context.
 await waitSchema(await send('match $item isa missing-schema-focus-test;'));
 assert.deepEqual(await selection(),selected);
 assert.match(await schema.evaluate(()=>window.ng.getComponent(document.querySelector('ts-schema-page')).bridge.message),/No explicit type names/);
 await checkGraphNavigation(schema, 'schema');
    await checkGraphCustomise(schema, 'schema');
 assert.deepEqual(errors,[]);
 console.log('PASS full schema positions restored after working subset; parallel Query/Schema, roles and players, no data execution in Schema, docking and selection edits, pause/resume with replay, project snap provenance, schema refresh, saved-view exit, unknown-type fallback');
} catch(error) {
 console.error(errors);
 console.error(await schema.locator('body').innerText());
 throw error;
} finally {
 await browser.close();server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});
}
