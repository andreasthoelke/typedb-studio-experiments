/** Database-free browser check for role styling, edge inspection, snaps and PNG exports.
 * Run after pnpm build:viewer; PLAYWRIGHT_MODULE can point to an installed Playwright.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViewerServer } from './viewer-server.mjs';

async function playwright() {
    if (process.env.PLAYWRIGHT_MODULE) return import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
    try { return await import('playwright'); } catch { /* Reuse a local npx installation when available. */ }
    const cache = join(homedir(), '.npm', '_npx');
    for (const dir of await readdir(cache).catch(() => [])) {
        try { return await import(pathToFileURL(join(cache, dir, 'node_modules/playwright/index.mjs')).href); } catch { /* next */ }
    }
    throw new Error('Install Playwright (e.g. npx playwright --version), or set PLAYWRIGHT_MODULE to its index.mjs.');
}
const { chromium } = await playwright();
const root = await mkdtemp(join(tmpdir(), 'studio-role-edges-'));
const projectTempDirectory = join(root, 'project', 'temp');
const directory = join(projectTempDirectory, 'snaps', 'shortcut-test');
await mkdir(directory, { recursive: true });
const fixture = index => ({
    format:'typedb-studio-graph-snap', version:1, createdAt:'2026-09-12T00:00:00Z', query:'Saved test query', expansionQueries:[], schemaMode:false,
    graph:{attributes:{elementSelection:{active:false,nodes:[]}}, nodes:[{key:'n',attributes:{x:index,y:0,size:40,width:50,height:30,type:'ellipse',label:`Example ${index}`,color:'#ffffff',borderColor:'#112233',metadata:{concept:{kind:'entity',iid:'n',type:{kind:'entityType',label:'example'}},defaultLabel:'Example',hoverLabel:'Example'}}}],edges:[]},
    style:{name:'Snapshot',description:'',kindStyles:{},typeStyles:{},edgeLabelColors:{},colorEdgesByConstraint:false,labelsVisible:true,showHoverLabel:true,degreeScaling:false,background:{type:'solid',color1:'#ffffff',color2:'#000000',gradientAngle:0}},
    view:{camera:{x:.4,y:.6,ratio:.8,angle:0},bbox:{x:[0,100],y:[0,100]},viewport:{width:800,height:600},searchTerm:'',finderMatches:null,selectedNode:null,selectedNeighbors:[],highlightedEdges:[],highlightedTypes:[],highlightedKinds:[]},
    labels:{attributes:[],overrides:[]}, database:'shortcut-test', project:{database:'shortcut-test',projectTempDirectory},
});
const server=createViewerServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://localhost:${server.address().port}`;

let browser,page;
const errors=[];
try {
 browser=await chromium.launch({channel:'chrome',headless:true});
 page=await browser.newPage({viewport:{width:1700,height:1120},deviceScaleFactor:2});
 page.on('pageerror',e=>errors.push(e.stack));
 page.on('console',message=>{if(message.type()==='error'&&/shader|WebGL|program/i.test(message.text()))errors.push(message.text());});
 const snap=fixture(0);snap.graph.nodes=[];
 const node=(key,kind,label,x,y)=>{
  const attrs=structuredClone(fixture(0).graph.nodes[0].attributes);
  Object.assign(attrs,{x,y,label:key,type:kind==='relation'?'diamond':'rounded-rect',width:70,height:40,size:70});
  attrs.metadata.concept={kind,iid:key,type:{kind:kind+'Type',label}};attrs.metadata.defaultLabel=key;
  snap.graph.nodes.push({key,attributes:attrs});return attrs.metadata.concept;
 };
 const r=node('composition','relation','composition',0,200), p=node('depiction','entity','depiction',500,200);
 const r2=node('depiction-slot','relation','depiction-slot',0,-200),p2=node('slot-def','entity','slot-def',500,-200);
 const edge=(key,source,target,role,relation,player)=>snap.graph.edges.push({key,source,target,attributes:{label:'links',size:2,color:'#304f69',type:'line',metadata:{answerIndex:0,dataEdge:{tag:'links',role:{kind:'roleType',label:role},relation,player}}}});
 edge('host','composition','depiction','composition:host',r,p);
 edge('slot','composition','depiction','composition:slot',r,p);
 edge('other-host','depiction-slot','slot-def','depiction-slot:host',r2,p2);
 snap.style.edgeLabelColors={links:'#304f69'};
 snap.view.bbox={x:[-150,650],y:[-400,400]};snap.view.camera={x:.5,y:.5,ratio:1,angle:0};
 await writeFile(join(directory,'roles-00.snap.json'),JSON.stringify(snap));
 await page.goto(origin+'/snap');await page.waitForSelector('ts-graph-canvas');
 await page.locator('input[type="file"][accept=".snap.json,.json"]').setInputFiles(join(directory,'roles-00.snap.json'));
 await page.waitForFunction(()=>!!window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser);
 await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;v.stopLayout();v.applyEdgeCurvature();v.pointCaret('composition');});
 const initial=await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return {selection:{active:v.elementSelection.active,nodes:[...v.elementSelection.nodes]},caret:v.navigation.caret,positions:v.graph.nodes().map(key=>[key,v.graph.getNodeAttribute(key,'x'),v.graph.getNodeAttribute(key,'y')])};});
 const read=()=>page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return Object.fromEntries(v.graph.edges().map(e=>[e,v.sigma.getEdgeDisplayData(e)]));});
 assert.equal((await read()).host.label,'host','old snap links label repaired from role metadata');
 // Click the real WebGL picking surface at a curved edge apex (not a synthetic event).
 const point=await page.evaluate(()=>{
  const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
  const a=v.sigma.graphToViewport(v.graph.getNodeAttributes('composition')),b=v.sigma.graphToViewport(v.graph.getNodeAttributes('depiction'));
  const k=v.graph.getEdgeAttribute('host','curvature'),rect=v.sigma.getContainer().getBoundingClientRect();
  return {x:rect.left+(a.x+b.x)/2+.5*k*(b.y-a.y),y:rect.top+(a.y+b.y)/2-.5*k*(b.x-a.x)};
 });
 await page.mouse.click(point.x,point.y);
 await page.getByLabel('Edge inspector',{exact:true}).waitFor();
 assert.match(await page.getByLabel('Edge inspector',{exact:true}).innerText(),/composition:host/);
 assert.deepEqual(await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return {selection:{active:v.elementSelection.active,nodes:[...v.elementSelection.nodes]},caret:v.navigation.caret,positions:v.graph.nodes().map(key=>[key,v.graph.getNodeAttribute(key,'x'),v.graph.getNodeAttribute(key,'y')])};}),initial);
 await page.getByRole('button',{name:'Customise role',exact:true}).click();
 const row=page.locator('[data-edge-style="composition:host"]');await row.waitFor();
 assert.match(await row.getAttribute('class'),/inspected-edge-style/);
 const choose=async(label,option)=>{await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();};
 await choose('Dash for all edges','Long dash');
 await choose('Edge dash for links','Dotted');
 await choose('Edge dash for composition:host','Dash-dot');
 await page.getByRole('spinbutton',{name:'Edge thickness for composition:host',exact:true}).fill('2.5');
 await page.getByRole('spinbutton',{name:'Edge thickness for composition:host',exact:true}).press('Tab');
 await row.locator('input[type="color"]').evaluate(el=>{el.value='#b82244';el.dispatchEvent(new Event('input',{bubbles:true}));});
 let data=await read();assert.equal(data.host.lineStyle,'dash-dot');assert.equal(data.slot.lineStyle,'dotted');assert.equal(data['other-host'].lineStyle,'dotted');
 assert.equal(data.host.color,'#b82244');assert.equal(data.host.size,6,'2 * 2.5 plus inspection accent');assert.equal(data['other-host'].size,2);
 await page.getByRole('button',{name:'Go to player',exact:true}).click();
 await page.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.navigation.caret==='depiction');
 assert.equal(await page.getByLabel('Edge inspector',{exact:true}).count(),0);
 await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;v.restoreLabels();});
 assert.equal((await read()).host.label,'host');
 await page.getByRole('textbox',{name:'Filter role styles',exact:true}).fill('composition');
 assert.equal(await page.locator('[data-edge-style="depiction-slot:host"]').count(),0);
 await page.getByRole('textbox',{name:'Filter role styles',exact:true}).fill('');
 await page.screenshot({path:join(tmpdir(),'studio-role-edges.png')});
 const response=page.waitForResponse(r=>r.url().includes('/api/viewer/snap?')&&r.request().method()==='POST');
 await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).saveSnap());
 const file=await(await response).json();assert.ok(file.filename);
 await page.evaluate(async filename=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));await c.openSavedSnap(filename);},file.filename);
 data=await read();assert.equal(data.host.lineStyle,'dash-dot');assert.equal(data.host.color,'#b82244');assert.equal(data.host.size,5);assert.equal(data.host.label,'host');
 await page.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-side-panel-customise-tab'));c.clearEdgeLabelOverride('composition:host');});
 data=await read();assert.equal(data.host.lineStyle,'dotted');assert.equal(data.host.size,2);assert.equal(data.host.color,'#304f69');
 const png=await page.evaluate(async()=>[...new Uint8Array(await (await window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.exportPng('currentView')).arrayBuffer())]);
 assert.deepEqual(png.slice(0,8),[137,80,78,71,13,10,26,10]);
 await writeFile(join(tmpdir(),'studio-role-edges-export.png'),Buffer.from(png));
 assert.deepEqual(errors,[]);
 console.log('PASS scoped role styles/inheritance/reset, actual curved-edge click, endpoint caret, parallel lanes, label restoration, snap round-trip and PNG export');
} catch(error){console.error(errors);console.error(await page?.locator("body").innerText());await page?.screenshot({path:join(tmpdir(),"studio-role-edges-failure.png")});throw error;} finally {
 await browser?.close();server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});
}
