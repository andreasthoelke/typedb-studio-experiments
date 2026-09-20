/** Isolated end-to-end test: its own TypeDB data, ports, browser and bridge. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createViewerServer } from './viewer-server.mjs';
import { createRunExecutor } from './viewer-run.mjs';
import { checkFollowups } from './viewer-followup.browser-checks.mjs';
const root = await mkdtemp(join(tmpdir(),'studio-run-live-'));
const freePort = async () => {const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const httpPort=await freePort(),grpcPort=await freePort(),address=`http://localhost:${httpPort}`;
const typedb=spawn(process.env.TYPEDB_TEST_BINARY || join(homedir(),'.typedb/server/typedb_server_bin'),[
 '--server.listen-address',`127.0.0.1:${grpcPort}`,'--server.http.enabled','true','--server.http.listen-address',`127.0.0.1:${httpPort}`,
 '--storage.data-directory',join(root,'data'),'--logging.directory',join(root,'logs'),
 '--storage.rocksdb.cache-size','128mb','--storage.rocksdb.write-buffers-limit','128mb',
 '--diagnostics.reporting.metrics','false','--diagnostics.reporting.errors','false'],{cwd:root});
let logs='';typedb.stdout.on('data',d=>logs+=d);typedb.stderr.on('data',d=>logs+=d);
let browser,server;
const calls=[];
try {
 for(let i=0;i<100;i++) {try {if((await fetch(address+'/v1/version')).ok)break;}catch{} if(typedb.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
 const version=await (await fetch(address+'/v1/version')).json();
 assert.match(version.version,/^3\./);
 const signin=await (await fetch(address+'/v1/signin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'password'})})).json();
 const headers={'Content-Type':'application/json',Authorization:`Bearer ${signin.token}`};
 const database='result_fixture';
 assert.equal((await fetch(address+'/v1/databases/'+database,{method:'POST',headers,body:JSON.stringify({name:database})})).status,200);
 server=createViewerServer({runExecutor:createRunExecutor({address,fetchImpl:async(url,options)=>{if(url.endsWith('/v1/query'))calls.push(JSON.parse(options.body));return fetch(url,options);}})});
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://localhost:${server.address().port}`;
 const run=async (query,limit=100)=>{const response=await fetch(origin+'/api/viewer/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,database,runId:randomUUID(),limit,projectTempDirectory:join(root,'temp')})});assert.equal(response.status,200);return response.json();};
 // Declare the relation family before connecting browser readers. TypeDB 3.12.3
 // can panic in type_cache when that family is first added amid concurrent reads.
 const schema='define attribute person-id, value string; attribute name, value string; entity person, owns person-id @key, owns name; attribute title, value string; attribute intensity, value double; relation tension, relates pole @card(2..2), owns intensity; entity mental-state, owns title, plays tension:pole;';
 let result=await run(schema);assert.equal(result.execution.status,'success',JSON.stringify(result));assert.ok(result.graph,JSON.stringify(result));assert.equal(result.graph.source,'context',JSON.stringify(result));
 result=await run('insert $p isa person, has person-id "p1", has name "Ann";');assert.equal(result.execution.status,'success',JSON.stringify(result));assert.equal(result.graph.source,'result');
 result=await run('insert $p isa person, has person-id "p1", has name "Changed";');assert.equal(result.execution.status,'error');assert.match(result.response.err.code,/CNT/);assert.equal(result.graph?.source,'context',JSON.stringify(result));assert.match(result.lines.join('\n'),/Ann/);assert.doesNotMatch(result.lines.join('\n'),/already present/);
 const read=await run('match $p isa person, has name $name; select $p, $name;');assert.equal(read.response.ok.answers.length,1);assert.deepEqual(read.response,read.graph.response);
 result=await run('match $p isa person, has name $name; fetch { "name": $name };');assert.match(result.lines.join('\n'),/1 documents/);assert.equal(result.graph.source,'context');
 result=await run('match $p isa person, has name $name; fetch { "nested": { "name": $name } };');assert.match(result.lines.join('\n'),/nested JSON/);
 result=await run(schema);assert.equal(result.execution.status,'success');assert.equal(result.graph.source,'context');
 result=await run('insert $fear isa mental-state, has title "Fear"; $safety isa mental-state, has title "Safety"; $t isa tension, links (pole: $fear, pole: $safety), has intensity 0.8;');assert.equal(result.execution.status,'success',JSON.stringify(result));
 let playwright;
 if(process.env.PLAYWRIGHT_MODULE) playwright=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
 else {try{playwright=await import('playwright');}catch{for(const dir of await readdir(join(homedir(),'.npm/_npx')).catch(()=>[])){try{playwright=await import(pathToFileURL(join(homedir(),'.npm/_npx',dir,'node_modules/playwright/index.mjs')).href);break;}catch{}}}}
 assert.ok(playwright,'Install Playwright or set PLAYWRIGHT_MODULE');
 browser=await playwright.chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1400,height:1000}});
 const browserCalls=[]; context.on('request',request=>{if(request.url().endsWith('/v1/query'))browserCalls.push(request.postDataJSON());});
 await context.addInitScript(url=>localStorage.setItem('typeDBStudio.connections',JSON.stringify([{name:'Isolated',url,preferences:{isStartupConnection:true}}])),`typedb://admin:password@${address}/${database}`);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.stack));
 await page.goto(origin+'/query?nvim=1');
 const wait=async id=>page.waitForFunction(id=>{const b=window.ng?.getComponent(document.querySelector('ts-query-page'))?.bridge;return b?.lastRequest?.id===id&&!b.pending&&!b.busy;},id,{timeout:30000});
 await wait(result.id);
 const writesBefore=calls.filter(c=>c.transactionType!=='read').length;
 result=await run('match $p isa person, has name $name; select $p, $name;');await wait(result.id);
 await page.waitForFunction(()=>window.ng?.getComponent(document.querySelector('ts-query-page'))?.state.graphOutput.visualiser?.graph.order>0);
 const state=()=>page.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-query-page'));return {query:c.state.graphOutput.query,nodes:c.state.graphOutput.visualiser.graph.order,note:c.bridge.note,last:c.bridge.lastRequest.response};});
 let observed=await state();assert.deepEqual(observed.last,result.response);assert.equal(observed.query,result.query);assert.match(observed.note,/same executed answer/);
 const readCount=calls.filter(c=>c.query===result.query).length;
 assert.equal(browserCalls.filter(c=>c.query===result.query).length,0,'Browser must not submit the executed read again');
 const schemaPage=await context.newPage();schemaPage.on('pageerror',e=>{errors.push(e.stack);console.error(e.stack);});await schemaPage.goto(origin+'/schema?nvim=1');
 await schemaPage.waitForFunction(id=>{const c=window.ng?.getComponent(document.querySelector('ts-schema-page'));return c?.bridge.lastRequest?.id===id&&!c.bridge.pending&&!c.state.isRefreshing&&c.state.visualiser.visualiser;},result.id).catch(async error=>{
  console.error(await schemaPage.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-schema-page'));return {message:c.bridge.message,pending:c.bridge.pending,refreshing:c.state.isRefreshing,status:c.state.visualiser.status,database:c.state.visualiser.database,schema:!!c.state.value$.value,responses:c.state.queryResponses$.value?.length,canvas:!!c.state.visualiser.canvasEl$.value,graph:!!c.state.visualiser.visualiser};}));throw error;
 });
 const topology=await schemaPage.evaluate(()=>{
  const v=window.ng.getComponent(document.querySelector('ts-schema-page')).state.visualiser.visualiser;
  return {nodes:v.graph.order,edges:v.graph.size,simNodes:v.layout.simulation.nodes().length,simEdges:v.layout.simulation.force('link').links().length};
 });
 assert.ok(topology.edges>0);assert.equal(topology.simNodes,topology.nodes);assert.equal(topology.simEdges,topology.edges,'Initial schema layout must include all owns/plays/relates edges');
 await schemaPage.evaluate(()=>{
  const v=window.ng.getComponent(document.querySelector('ts-schema-page')).state.visualiser.visualiser;
  const prototype=Object.getPrototypeOf(v),original=prototype.focusHighlightedNodes;
  window.__automaticFocus=[];
  prototype.focusHighlightedNodes=function(...args){window.__automaticFocus.push(this.layout.isRunning);return original.apply(this,args);};
 });
 const second=await context.newPage();await second.goto(origin+'/query?nvim=1');
 await second.waitForFunction(id=>{const b=window.ng?.getComponent(document.querySelector('ts-query-page'))?.bridge;return b?.lastRequest?.id===id&&!b.pending;},result.id);
 assert.equal(calls.filter(c=>c.query===result.query).length,readCount,'SSE replay must only render cached answers');
 assert.equal(browserCalls.filter(c=>c.query===result.query).length,0,'Second browser must not replay the source');
 result=await run('insert $p isa person, has person-id "p2", has name "Bo";');await wait(result.id);assert.equal((await state()).nodes>0,true);
 await page.bringToFront();
 await page.getByRole('button',{name:'Neovim',exact:true}).click();
 await page.getByRole('button',{name:'Read graph context',exact:true}).click();
 await page.waitForFunction(()=>{const c=window.ng.getComponent(document.querySelector('ts-query-page'));return !c.bridge.pending&&!c.bridge.busy&&c.state.graphOutput.query.startsWith('match');});
 await page.locator('.mat-mdc-menu-panel').waitFor({state:'hidden'});
 result=await run('insert $p isa person, has person-id "p2", has name "Changed";');await wait(result.id);observed=await state();assert.match(observed.note,/Current data context/);assert.match(observed.query,/^match/);
 result=await run('match $p isa person, has person-id "missing";');await wait(result.id);assert.equal((await state()).nodes,0,'Empty result replaces the previous graph');
 assert.equal(calls.filter(c=>c.transactionType!=='read').length,writesBefore+2,'Only the two requested inserts can write');
 assert.equal(browserCalls.filter(c=>c.transactionType && c.transactionType!=='read').length,0,'Browsers never write');
 assert.deepEqual(errors,[]);
 result=await run('match $p isa person, has name $name; select $p, $name;');await wait(result.id);
 await page.bringToFront();
 await page.evaluate(()=>document.fonts.ready);
 await page.waitForTimeout(1800);
 await page.screenshot({path:join(root,'shared-result.png')});
 await writeFile(join(root,'sample-result.json'),JSON.stringify(result,null,2));
 const schemaRun=await run('define attribute checked, value boolean; entity person, owns checked;');
 await schemaPage.waitForFunction(id=>{const c=window.ng?.getComponent(document.querySelector('ts-schema-page'));return c?.bridge.lastRequest?.id===id&&!c.bridge.pending&&!!c.state.value$.value?.attributes?.checked;},schemaRun.id);
 await schemaPage.bringToFront();
 await schemaPage.waitForFunction(()=>window.__automaticFocus.length>0,{},{timeout:30000});
 assert.deepEqual(await schemaPage.evaluate(()=>window.__automaticFocus.filter(Boolean)),[],'Automatic schema focus must not stop an unfinished simulation');
 const limited=await run('match $p isa person; insert $p has checked true;',1); assert.equal(limited.execution.status,'success');
 const count=await run('match $p isa person, has checked true; reduce $n = count;');
 assert.equal(count.response.ok.answers[0].data.n.value,2,'Display limit must not truncate writes');
 await checkFollowups(page,schemaPage,run,database);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({version,passed:true,root,queryRequests:calls.length,checks:['schema + repeat','insert + duplicate key context','shared concept rows','flat/nested fetch','empty result','two Query tabs and parallel Schema','explicit graph context','no source replay','display limit preserves writes']},null,2));
} finally {
 await browser?.close();if(server){server.closeViewers();server.closeAllConnections();server.close();}
 if(typedb.exitCode===null){typedb.kill('SIGTERM');await once(typedb,'exit');}
 await rm(join(root,'data'),{recursive:true,force:true});
}
