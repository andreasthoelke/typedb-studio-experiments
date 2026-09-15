import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Read-only integration: illustrates missing patterns in temporary working
 * graphs. The source insert stages are never executed. */
export async function checkEditorCaret(query,schema,database) {
 const origin=new URL(query.url()).origin;
 const slots=`insert
  $d isa depiction, has depiction-id "conflict-stage", has title "Conflict stage";
  $sa isa slot-def, has slot-id "conflict-stage/agent", has title "agent";
  $sg isa slot-def, has slot-id "conflict-stage/goal", has title "goal";
  $sb isa slot-def, has slot-id "conflict-stage/barrier", has title "barrier";
  depiction-slot (host: $d, slot: $sa);
  depiction-slot (host: $d, slot: $sg);
  depiction-slot (host: $d, slot: $sb);`;
 const scene=`match
  $t isa take, has take-id "T1";
  $d isa depiction, has depiction-id "conflict-stage";
insert
  $s isa scene, has scene-id "S1", has title "Approach–avoidance, held";
  scene-take (scene: $s, take: $t);
  stages (scene: $s, root: $d);`;
 const partial=`match
  role-binding (instance: $pi, bound: $o), has role-name $rn;
  occurrence-of (occurrence: $o, subject: $r);
  $r has title $who;`;
 // Disable the ordinary automatic neighbour augmentation: the three relation
 // instances below must actually be missing before Enter illustrates them.
 await query.evaluate(()=>{
  const b=window.ng.getComponent(document.querySelector('ts-query-page')).bridge;
  b.neighbours=false;
  localStorage.setItem('typedb-studio-nvim-options',JSON.stringify({neighbours:false,seedVariable:'',relationTypes:''}));
 });
 const load=await query.request.post(origin+'/api/viewer/query',{data:{database,query:'match $d isa depiction, has depiction-id "conflict-stage"; select $d;'}});
 const {id}=await load.json();
 for(const page of [query,schema]) await page.waitForFunction(id=>{
  const c=window.ng.getComponent(document.querySelector('ts-query-page, ts-schema-page'));return c.bridge.lastRequest?.id===id&&!c.bridge.pending&&!c.bridge.busy&&!c.state.isRefreshing;
 },id);
 await schema.bringToFront();await schema.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-schema-page')).focusFrame);
 const mirror=await query.context().newPage();await mirror.goto(origin+'/query?nvim=1');
 await mirror.waitForFunction(id=>{const c=window.ng?.getComponent(document.querySelector('ts-query-page'));return c?.bridge.lastRequest?.id===id&&!c.bridge.pending&&!c.bridge.busy&&c.state.graphOutput.visualiser?.graph.order>0;},id);
 const pages=[query,schema,mirror];
 const settle=async page=>{
  await page.bringToFront();await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().isAnimated());
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 };
 const state=page=>page.evaluate(()=>{
  const c=window.ng.getComponent(document.querySelector('ts-query-page, ts-schema-page')),v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
  const key=v.navigation.caret,concept=key?v.graph.getNodeAttribute(key,'metadata').concept:null;
  return {key,concept,positions:v.graph.nodes().map(key=>({key,x:v.graph.getNodeAttribute(key,'x'),y:v.graph.getNodeAttribute(key,'y')})),edges:v.graph.edges().sort(),
   selection:[...v.elementSelection.nodes],camera:v.sigma.getCamera().getState(),query:c.bridge.lastRequest?.query,
   run:c.state.currentTabOutputState?.runCounter,expansions:c.currentRun?.expansionQueries??[],message:c.bridge.caretMessage};
 });
 for(const page of pages) await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;v.stopLayout();v.pointCaret(v.graph.nodes()[0]);v.elementSelection.replace(v.graph.nodes().slice(0,1));});
 const original=await Promise.all(pages.map(state));
 assert.equal(original[0].positions.length,1,'The starting Query graph contains only the depiction');
 const send=async(text,line=0,column=0,schemaOnly=false)=>{
  const before=await Promise.all(pages.map(state));
  const response=await query.request.post(origin+'/api/viewer/caret',{data:{source:text,line,column,schemaOnly,database}});
  assert.equal(response.status(),202);const {id}=await response.json();
  for(const page of schemaOnly?[schema]:pages) await page.waitForFunction(id=>{const b=window.ng.getComponent(document.querySelector('ts-query-page, ts-schema-page')).bridge;return b.lastCaretRequest?.id===id&&!b.caretRequest&&!b.caretBusy;},id);
  for(const [index,page] of pages.entries()) {
   const after=await state(page);
   for(const old of before[index].positions) assert.deepEqual(after.positions.find(p=>p.key===old.key),old,'An illustration preserves every existing coordinate');
   assert.deepEqual(after.selection,before[index].selection,'An illustration preserves explicit highlights');
   assert.equal(after.query,before[index].query);assert.equal(after.run,before[index].run);
  }
  return id;
 };
 const assertVisible=async page=>{
  await settle(page);
  const d=await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return {b:v.navigationBounds([v.navigation.caret]),...v.sigma.getDimensions()};});
  const mx=Math.min(70,d.width*.15),my=Math.min(90,d.height*.18);
  assert.ok(d.b&&d.b.left>=mx-1&&d.b.right<=d.width-mx+1&&d.b.top>=my-1&&d.b.bottom<=d.height-my+1,'Caret is visible with padding: '+JSON.stringify(d));
 };
 await send('entity take, plays scene-take:take;',0,0,true);
 assert.equal((await state(schema)).concept.label,'take');assert.equal((await state(query)).key,original[0].key);
 const ids=[];
 for(const line of [5,6,7]) {
  await send(slots,line);const q=await state(query);ids.push(q.concept.iid);
  assert.equal(q.concept.type.label,'depiction-slot');assert.equal((await state(schema)).concept.label,'depiction-slot');
  assert.equal((await state(mirror)).concept.iid,q.concept.iid);
  const wanted=['agent','goal','barrier'][line-5];
  const neighbors=await query.evaluate(key=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return v.graph.neighbors(key).map(k=>v.graph.getNodeAttribute(k,'metadata').concept);},q.key);
  const slot=neighbors.find(c=>c.type?.label==='slot-def');assert.ok(slot,'Relation has a slot player edge');
  const matches=await query.evaluate(async({iid,database,wanted})=>{const b=window.ng.getComponent(document.querySelector('ts-query-page')).bridge;return await new Promise((resolve,reject)=>b.driver.queryReadOnly(`match $s isa slot-def, has slot-id "conflict-stage/${wanted}"; $s iid ${iid}; select $s;`,database).subscribe({next:r=>resolve(r.ok?.answers?.length),error:reject}));},{iid:slot.iid,database,wanted});
  assert.equal(matches,1,'The chosen relation uses the intended slot, not merely the shared host');
 }
 assert.equal(new Set(ids).size,3,'Three source relation lines resolve three distinct instances');
 assert.equal((await state(query)).positions.length,7,'Enter adds three relation nodes and their three slot players');
 await query.bringToFront();await query.screenshot({path:join(tmpdir(),'studio-editor-illustrations.png')});
 const once=await state(query);await send(slots,7);const twice=await state(query);
 assert.deepEqual(twice.positions,once.positions);assert.deepEqual(twice.edges,once.edges);assert.deepEqual(twice.expansions,once.expansions,'Repeated illustration is idempotent');
 await send(slots,6,slots.split('\n')[6].indexOf('$sg'));assert.equal((await state(query)).concept.type.label,'slot-def','An explicit variable still inspects its player');
 for(const [line,type] of [[5,'scene-take'],[6,'stages']]) {await send(scene,line);assert.equal((await state(query)).concept.type.label,type);assert.equal((await state(schema)).concept.label,type);}
 await send('entity take, plays scene-take:take;');assert.equal((await state(query)).concept.type.label,'take');assert.equal((await state(schema)).concept.label,'take');
 await send('entity take, plays scene-take:take;',0,13);assert.equal((await state(query)).concept.type.label,'scene-take');assert.equal((await state(schema)).concept.label,'scene-take:take');
 for(const [line,type] of [[1,'role-binding'],[2,'occurrence-of']]) {await send(partial,line);assert.equal((await state(query)).concept.type.label,type);}
 await send(partial,3);assert.ok(['mental-state','goal'].includes((await state(query)).concept.type.label));
 assert.ok((await state(query)).positions.length>original[0].positions.length,'Enter adds missing illustrative data');
 assert.ok((await state(query)).expansions.length>0,'Illustrations are retained as snapshot provenance');
 // Visible targets preserve framing; an off-screen target stops at the padded edge.
 await send(slots,6,slots.split('\n')[6].indexOf('$sg'));
 for(const page of pages) {await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.centreCaret(.4,.42));await assertVisible(page);}
 const placed=await Promise.all(pages.map(state));await send(slots,6,slots.split('\n')[6].indexOf('$sg'));
 for(const [i,page] of pages.entries()) {await assertVisible(page);assert.deepEqual((await state(page)).camera,placed[i].camera,'Visible target does not centre');await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.centreCaret(1.3,.5));await settle(page);}
 await send(slots,6,slots.split('\n')[6].indexOf('$sg'));for(const page of pages) await assertVisible(page);
 const miss=await state(query);await send('$x isa occurrence, has occurrence-id "no-such-instance-unique";');
 assert.match((await state(query)).message,/No visible match/);assert.deepEqual(await state(query),{...miss,message:(await state(query)).message});
 // A hidden exact target remains hidden and does not append its neighbourhood.
 const hidden=(await state(query)).key;
 await query.evaluate(key=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;v.graph.setNodeAttribute(key,'viewHidden',true);v.pointCaret(v.graph.nodes().find(k=>k!==key&&!v.graph.getNodeAttribute(k,'viewHidden')));},hidden);
 const hiding=await state(query);await send(slots,6,slots.split('\n')[6].indexOf('$sg'));
 assert.equal((await state(query)).key,hiding.key);assert.deepEqual((await state(query)).positions,hiding.positions);
 await query.evaluate(key=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.graph.setNodeAttribute(key,'viewHidden',false),hidden);
 // Stale reads must neither move the caret nor append removed data.
 const take=await query.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;const key=v.graph.nodes().find(k=>v.graph.getNodeAttribute(k,'metadata').concept.type?.label==='take');const iid=v.graph.getNodeAttribute(key,'metadata').concept.iid;v.graph.dropNode(key);const b=window.ng.getComponent(document.querySelector('ts-query-page')).bridge,old=b.driver.queryReadOnly.bind(b.driver);b.driver.queryReadOnly=(...args)=>{const observable=old(...args),subscribe=observable.subscribe.bind(observable);observable.subscribe=(...handlers)=>{const timer=setTimeout(()=>subscribe(...handlers),200);return {unsubscribe:()=>clearTimeout(timer)};};return observable;};window.restoreCaretRead=()=>b.driver.queryReadOnly=old;return iid;});
 await query.request.post(origin+'/api/viewer/caret',{data:{source:'$t isa take, has take-id "T1";',line:0,column:0,schemaOnly:false,database}});
 await send(slots,1);assert.equal((await state(query)).concept.type.label,'depiction');
 assert.equal(await query.evaluate(iid=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return v.graph.nodes().some(k=>v.graph.getNodeAttribute(k,'metadata').concept.iid===iid);},take),false,'Superseded read cannot append its target');
 await query.evaluate(()=>window.restoreCaretRead());
 // The view command channel acts on following tabs without focusing the browser.
 const control=async command=>{
  const response=await query.request.post(origin+'/api/viewer/control',{data:{command,database}});assert.equal(response.status(),202);const {id}=await response.json();
  for(const page of pages) await page.waitForFunction(id=>window.ng.getComponent(document.querySelector('ts-query-page, ts-schema-page')).bridge.lastControlId===id,id);
 };
 for(const [command,x,y] of [['centreCaret',.5,.5],['caretTop',.5,.125],['caretBottom',.5,.875],['caretLeft',.125,.5],['caretRight',.875,.5]]) {
  await control(command);
  for(const page of pages) {await settle(page);const error=await page.evaluate(({x,y})=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser,p=v.sigma.graphToViewport(v.graph.getNodeAttributes(v.navigation.caret)),d=v.sigma.getDimensions();return Math.hypot(p.x-d.width*x,p.y-d.height*y);},{x,y});assert.ok(error<.2,command);}
 }
 for(const command of ['panLeft','panRight','panUp','panDown','zoomIn','zoomOut']) {const before=await state(query);await control(command);await settle(query);assert.notDeepEqual((await state(query)).camera,before.camera,command);}
 const saved=query.waitForResponse(r=>r.url().includes('/api/viewer/snap?')&&r.request().method()==='POST');await control('snap');assert.equal((await saved).status(),201);
 for(const page of pages) await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser,old=v.reLayout.bind(v);window.remoteLayouts=0;v.reLayout=()=>{window.remoteLayouts++;old();};});
 await control('relayout');for(const page of pages) assert.equal(await page.evaluate(()=>window.remoteLayouts),1);
 await mirror.close();
 console.log('PASS Neovim: exact relation/player resolution, bounded missing-data illustrations, minimal follow, preserved old positions/highlights/query, hidden/no-match handling, stale-read rejection, view controls and real snapshot saving across following tabs');
}
