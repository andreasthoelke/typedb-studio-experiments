/** Database-free browser check for dash dropdowns, WebGL rendering, snaps and PNG exports.
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
const root = await mkdtemp(join(tmpdir(), 'studio-dashes-'));
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
 const styles=['solid','dotted','short-dash','long-dash','dash-dot'];
 const shapes=['rounded-rect','ellipse','diamond','hexagon'];
 const tags=['has','links','owns','relates','plays'];
 snap.style.edgeLineStyles={};snap.style.labelsVisible=true;
 for(const [row,lineStyle] of styles.entries()){
  for(const [column,shape] of shapes.entries()){
   const key=`${lineStyle}-${shape}`, attrs=structuredClone(fixture(0).graph.nodes[0].attributes);
   Object.assign(attrs,{x:column*270,y:-row*180,label:lineStyle,type:shape,width:66,height:38,size:66});
   attrs.metadata.concept.iid=key;attrs.metadata.concept.type.label=key;
   snap.graph.nodes.push({key,attributes:attrs});
   snap.style.typeStyles[key]={shape,width:66,height:38,color:'#304f69',lineStyle};
  }
  snap.style.edgeLineStyles[tags[row]]=lineStyle;
  for(const [from,to,type] of [[0,1,'line'],[2,3,'curved']]){
   snap.graph.edges.push({key:`e-${row}-${from}`,source:`${lineStyle}-${shapes[from]}`,target:`${lineStyle}-${shapes[to]}`,
    attributes:{label:'',size:2,color:'#304f69',type,curvature:0.3,metadata:{dataEdge:{tag:tags[row]}}}});
  }
 }
 snap.view.bbox={x:[0,810],y:[-720,0]};snap.view.camera={x:.5,y:.5,ratio:1,angle:0};
 await writeFile(join(directory,'gallery-00.snap.json'),JSON.stringify(snap));
 await page.goto(origin+'/snap');await page.waitForSelector('ts-graph-canvas');
 await page.locator('input[type="file"][accept=".snap.json,.json"]').setInputFiles(join(directory,'gallery-00.snap.json'));
 await page.waitForFunction(()=>!!window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser);
 await page.getByRole('button',{name:'Customise',exact:true}).click();
 const choose=async(label,option)=>{await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();};
 await choose('Outline dash for entity','Dotted');
 await page.getByRole('button',{name:'Types',exact:true}).click();
 await choose('Outline dash for solid-rounded-rect','Inherit');
 assert.equal(await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return v.sigma.getNodeDisplayData('solid-rounded-rect').lineStyle;}),'dotted');
 await choose('Outline dash for solid-rounded-rect','Solid');
 await choose('Dash for all edges','Long dash');
 await choose('Edge dash for has','Dash-dot');
 assert.equal(await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getEdgeDisplayData('e-0-0').lineStyle),'dash-dot');
 await choose('Edge dash for has','Solid');
 await page.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));c.visualiser.interactionHandler.clearSelection();c.visualiser.focusHighlightedNodes();});
 await page.waitForTimeout(350);
 await page.screenshot({path:join(tmpdir(),'studio-dash-gallery.png')});
 const png=await page.evaluate(async()=>{
  const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
  const blob=await v.exportPng('currentView');return [...new Uint8Array(await blob.arrayBuffer())];
 });
 assert.deepEqual(png.slice(0,8),[137,80,78,71,13,10,26,10]);
 await writeFile(join(tmpdir(),'studio-dash-export.png'),Buffer.from(png));
 const response=page.waitForResponse(r=>r.url().includes('/api/viewer/snap?')&&r.request().method()==='POST');
 await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).saveSnap());
 const file=await(await response).json();assert.ok(file.filename);
 await page.evaluate(async filename=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));await c.openSavedSnap(filename);},file.filename);
 assert.equal(await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getNodeDisplayData('dotted-ellipse').lineStyle),'dotted');
 assert.deepEqual(errors,[]);
 console.log('PASS all outline shapes and dash styles, straight/curved edges, dropdown inheritance, snap save/reopen and PNG export; gallery in '+join(tmpdir(),'studio-dash-gallery.png'));
} catch(error){console.error(errors);console.error(await page?.locator("body").innerText());await page?.screenshot({path:join(tmpdir(),"studio-dash-failure.png")});throw error;} finally {
 await browser?.close();server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});
}
