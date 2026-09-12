/** Browser smoke check with synthetic snaps; no TypeDB server or real database is used.
 * PLAYWRIGHT_MODULE may point to an existing playwright/index.mjs installation.
 * Run after pnpm build:viewer. Optional VIMIUM_PATH + CHROMIUM_PATH tests real extension interception.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
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
const root = await mkdtemp(join(tmpdir(), 'studio-shortcuts-'));
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
for (let i=0;i<3;i++) await writeFile(join(directory,`example-0${i}.snap.json`),JSON.stringify(fixture(i)));
const server=createViewerServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://localhost:${server.address().port}`;
let browser,context;
try {
    if(process.env.VIMIUM_PATH) {
        assert.ok(process.env.CHROMIUM_PATH,'Set CHROMIUM_PATH to an extension-capable Chromium executable.');
        const extension=join(root,'extension');await cp(process.env.VIMIUM_PATH,extension,{recursive:true});
        context=await chromium.launchPersistentContext(join(root,'browser'),{executablePath:process.env.CHROMIUM_PATH,headless:true,viewport:{width:1450,height:950},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    } else {
        browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH,headless:true}:{channel:'chrome',headless:true});
        context=await browser.newContext({viewport:{width:1450,height:950}});
    }
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.stack || error.message));

    // The legacy standalone surface mounts the shared canvas without a database connection.
    // Query/schema in-place restoration is covered by the live workflow described in the handoff.
    await page.goto(origin+'/snap');await page.waitForSelector('ts-graph-canvas');
    await page.evaluate(({projectTempDirectory})=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));
        c.snapshots.remember('shortcut-test',projectTempDirectory);
        Object.defineProperty(c,'snapshotDatabase',{get:()=> 'shortcut-test'});
        window.ng.applyChanges(c);
    },{projectTempDirectory});
    await page.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapFiles.length===3);
    await page.locator('.canvas-element').first().click({position:{x:450,y:350}});
    const active=()=>page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapshots.activeFile?.filename);
    if(process.env.VIMIUM_PATH) {
        const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
        await page.waitForTimeout(700);await page.keyboard.press('l');await page.waitForTimeout(200);
        assert.equal(await page.locator('.snap-chip-open[aria-pressed="true"]').count(),0,'Vimium should consume l before the page receives it');
        await worker.evaluate(async origin=>{await Settings.onLoaded();await Settings.set('exclusionRules',[{pattern:origin+'/*',passKeys:'hls/?'}]);},origin);
        await page.reload();await page.waitForSelector('ts-graph-canvas');
        await page.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));Object.defineProperty(c,'snapshotDatabase',{get:()=> 'shortcut-test'});window.ng.applyChanges(c);});
        await page.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapFiles.length===3);
        await page.waitForTimeout(700);
        console.log('PASS real Vimium blocks default l; configured per-site hls/? in isolated profile');
    }
    const names=await page.locator('.snap-chip-open').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')));
    // Focus is on the graph/body, never a chip: this was the original focus restriction.
    await page.keyboard.press('l');await page.waitForFunction(()=>!!window.ng.getComponent(document.querySelector('ts-graph-canvas')).inlineSnap);
    assert.equal(await active(),names[0]);
    await page.keyboard.press('l');await page.waitForFunction(name=>document.querySelector('.snap-chip-open[aria-pressed="true"]')?.getAttribute('aria-label')===name,names[1]);
    await page.keyboard.press('h');await page.waitForFunction(name=>document.querySelector('.snap-chip-open[aria-pressed="true"]')?.getAttribute('aria-label')===name,names[0]);
    await page.keyboard.press('h');await page.waitForFunction(name=>document.querySelector('.snap-chip-open[aria-pressed="true"]')?.getAttribute('aria-label')===name,names.at(-1));
    // Exercise the real interaction handler and reducer with overlapping neighborhoods.
    await page.evaluate(() => {
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')), v=c.visualiser, graph=v.graph;
        const template=graph.getNodeAttributes('n');
        for (const [key,x] of [['other',30],['shared',15],['unrelated',70]]) {
            graph.addNode(key,{...structuredClone(template),x,y:30,label:key,metadata:{...structuredClone(template.metadata),concept:{...structuredClone(template.metadata.concept),iid:key}}});
        }
        graph.addEdge('n','shared',{type:'line',size:1,color:'#112233',metadata:{}});
        graph.addEdge('other','shared',{type:'line',size:1,color:'#112233',metadata:{}});
        v.sigma.refresh();
        const click=(node,shiftKey)=>v.interactionHandler.onClickNode({node,event:{original:new MouseEvent('click',{shiftKey})}});
        v.interactionHandler.setSelectionMode('instances');
        click('n',false);click('other',true);
        if([...v.elementSelection.nodes].sort().join(',')!=='n,other,shared') throw new Error('Shift-click did not extend inspection: '+JSON.stringify({nodes:[...v.elementSelection.nodes],primary:v.interactionHandler.state.selectedNode,mode:v.interactionHandler.selectionMode,hasVisualiser:!!v.interactionHandler.visualiser}));
        click('n',true);
        if([...v.elementSelection.nodes].sort().join(',')!=='other,shared') throw new Error('Overlap lost on deselect');
        if(v.sigma.getSetting('nodeReducer')('unrelated',graph.getNodeAttributes('unrelated')).zIndex!==0) throw new Error('Unselected node not faded');
        v.sigma.getCamera().setState({x:0,y:0,ratio:4});
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().getState().ratio!==4);
    await page.keyboard.press('/');assert.equal(await page.locator('input[aria-label="Find types or labels"]').evaluate(el=>document.activeElement===el),true);
    await page.keyboard.type('hls');await page.keyboard.press('Backspace');assert.equal(await page.locator('input[aria-label="Find types or labels"]').inputValue(),'hl');assert.equal(await active(),names.at(-1));
    await page.locator('.canvas-element').last().click({position:{x:450,y:350}});
    await page.keyboard.press('?');await page.getByText('Last shortcut: ? → help',{exact:true}).waitFor();
    await page.keyboard.press('s');await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapping&&window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapFiles.length===4);
    assert.equal((await readdir(directory)).length,4);
    await page.keyboard.press('l');
    const savedName=(await readdir(directory)).find(name=>!names.includes(name));
    await page.waitForFunction(name=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));return !c.snapsBusy && c.snapshots.activeFile?.filename===name;},savedName);
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.interactionHandler.onClickNode({node:'other',event:{original:new MouseEvent('click',{shiftKey:true})}});
        if(v.elementSelection.nodes.size!==0) throw new Error('Saved neighborhood did not toggle off after restoration');
    });
    const url=page.url();await page.keyboard.press('Backspace');await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).inlineSnap).catch(async error=>{
        console.error(errors);
        console.error(await page.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));return {last:c.lastShortcut,active:document.activeElement?.outerHTML,visible:c.isKeyboardVisible(),busy:c.snapsBusy};}));
        throw error;
    });assert.equal(page.url(),url);
    // Returning live cancels a pending file response, including from an empty live surface.
    let release;
    const delayed=new Promise(resolve=>release=resolve);
    await page.route('**/api/viewer/snap?*',async route=>{await delayed;await route.continue();});
    await page.keyboard.press('l');
    await page.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapsBusy);
    await page.keyboard.press('Backspace');release();
    await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapsBusy);
    assert.equal(await page.evaluate(()=>!!window.ng.getComponent(document.querySelector('ts-graph-canvas')).inlineSnap),false);
    assert.deepEqual(errors,[]);
    console.log('PASS Shift-click overlap, Enter focus, saved group restoration; h/l from graph focus, order/wrap, / finder, text editing protection, ? help, s real save, Backspace live without navigation, cancellation of pending snap load');
} finally {
    await context?.close();await browser?.close();server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});
}
