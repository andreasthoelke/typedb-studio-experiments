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
import { checkGraphNavigation } from './graph-navigation.browser-checks.mjs';
import { checkGraphCustomise } from './graph-customise.browser-checks.mjs';
import { checkPaneFocus } from './pane-focus.browser-checks.mjs';

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
const escalated=[];
const server=createViewerServer({windowFocus:direction=>{escalated.push(direction);return {focused:true};}});server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://localhost:${server.address().port}`;
let browser,context,page;const errors=[];
try {
    if(process.env.VIMIUM_PATH) {
        assert.ok(process.env.CHROMIUM_PATH,'Set CHROMIUM_PATH to an extension-capable Chromium executable.');
        const extension=join(root,'extension');await cp(process.env.VIMIUM_PATH,extension,{recursive:true});
        context=await chromium.launchPersistentContext(join(root,'browser'),{executablePath:process.env.CHROMIUM_PATH,headless:true,viewport:{width:1450,height:950},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    } else {
        browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH,headless:true}:{channel:'chrome',headless:true});
        context=await browser.newContext({viewport:{width:1450,height:950}});
    }
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.stack || error.message));

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
        await page.waitForTimeout(700);
        await page.evaluate(()=>{window.vimiumProbe=[];window.addEventListener('keydown',event=>window.vimiumProbe.push(event.key),true);});
        await page.keyboard.press('l');
        assert.deepEqual(await page.evaluate(()=>window.vimiumProbe),[],'Default Vimium consumes l before page listeners');
        await worker.evaluate(async origin=>{await Settings.onLoaded();await Settings.set('exclusionRules',[{pattern:origin+'/*',passKeys:''}]);},origin);
        await page.reload();await page.waitForSelector('ts-graph-canvas');
        await page.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));Object.defineProperty(c,'snapshotDatabase',{get:()=> 'shortcut-test'});window.ng.applyChanges(c);});
        await page.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapFiles.length===3);
        await page.waitForTimeout(700);
        console.log('PASS real Vimium blocks default l; disabled Vimium entirely for Studio in isolated profile');
    }
    const names=await page.locator('.snap-chip-open').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')));
    // Focus is on the graph/body, never a chip: this was the original focus restriction.
    await page.keyboard.press('Space');await page.keyboard.press('l');await page.waitForFunction(()=>!!window.ng.getComponent(document.querySelector('ts-graph-canvas')).inlineSnap);
    assert.equal(await active(),names[0]);
    await page.keyboard.press('Space');await page.keyboard.press('l');await page.waitForFunction(name=>document.querySelector('.snap-chip-open[aria-pressed="true"]')?.getAttribute('aria-label')===name,names[1]);
    await page.keyboard.press('Space');await page.keyboard.press('h');await page.waitForFunction(name=>document.querySelector('.snap-chip-open[aria-pressed="true"]')?.getAttribute('aria-label')===name,names[0]);
    await page.keyboard.press('Space');await page.keyboard.press('h');await page.waitForFunction(name=>document.querySelector('.snap-chip-open[aria-pressed="true"]')?.getAttribute('aria-label')===name,names.at(-1));
    // Exercise exact, idempotent selection through the real interaction handler and reducer.
    await page.evaluate(() => {
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')), v=c.visualiser, graph=v.graph;
        const template=graph.getNodeAttributes('n');
        for (const [key,x] of [['other',30],['shared',15],['unrelated',70]]) {
            graph.addNode(key,{...structuredClone(template),x,y:30,label:key,metadata:{...structuredClone(template.metadata),concept:{...structuredClone(template.metadata.concept),iid:key}}});
        }
        graph.addEdge('n','shared',{type:'line',size:1,color:'#112233',metadata:{}});
        graph.addEdge('other','shared',{type:'line',size:1,color:'#112233',metadata:{}});
        v.sigma.refresh();
        const click=(node,extra={})=>v.interactionHandler.onClickNode({node,event:{original:new MouseEvent('click',extra)}});
        v.interactionHandler.setSelectionMode('instances');
        v.elementSelection.replace([]);
        click('n');click('other',{shiftKey:true});click('other',{shiftKey:true});
        if([...v.elementSelection.nodes].join(',')!=='other') throw new Error('Shift-click must add only its destination, once');
        click('n',{shiftKey:true});click('n',{altKey:true});click('n',{altKey:true});
        if([...v.elementSelection.nodes].join(',')!=='other') throw new Error('Option-click must remove only its destination, once');
        if(v.navigation.caret!=='n'||v.interactionHandler.state.selectedNode!=='n') throw new Error('Unselected node did not receive caret and inspection');
        if(v.sigma.getSetting('nodeReducer')('unrelated',graph.getNodeAttributes('unrelated')).zIndex!==0) throw new Error('Unselected node not faded');
        v.sigma.getCamera().setState({x:0,y:0,ratio:4});
    });
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        window.layoutStarts=[];
        const redraw=v.reLayout.bind(v), start=v.layout.startOrRedraw.bind(v.layout);
        v.reLayout=()=>{
            window.beforeRestart={running:v.isLayoutRunning,positions:v.graph.nodes().map(key=>[key,v.graph.getNodeAttribute(key,'x'),v.graph.getNodeAttribute(key,'y')])};
            redraw();
        };
        v.layout.startOrRedraw=()=>{
            const positions=v.graph.nodes().map(key=>[key,v.graph.getNodeAttribute(key,'x'),v.graph.getNodeAttribute(key,'y')]);
            if(window.beforeRestart.running&&JSON.stringify(positions)!==JSON.stringify(window.beforeRestart.positions)) throw new Error('Running re-layout randomized positions');
            window.layoutStarts.push(window.beforeRestart.running);start();
        };
    });
    await page.keyboard.press('r');await page.keyboard.press('r');
    assert.deepEqual(await page.evaluate(()=>window.layoutStarts),[false,true],'r starts once then interrupts the active layout');
    await page.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;v.stopLayout();v.sigma.getCamera().setState({x:0,y:0,ratio:4});});
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().getState().ratio!==4);
    await page.waitForTimeout(350);
    const cameraRatio=()=>page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().ratio);
    await page.evaluate(()=>{const camera=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera();camera.setState({ratio:Math.max(.2,camera.ratio)});});
    const originalRatio=await cameraRatio();
    await page.keyboard.press('+');await page.waitForTimeout(200);
    assert.ok(Math.abs(await cameraRatio()-originalRatio*0.7**(1/3))<1e-6,'+ zooms in by the toolbar factor (a third of the former 0.7 step)');
    await page.keyboard.press('-');await page.waitForTimeout(200);
    assert.ok(Math.abs(await cameraRatio()-originalRatio)<1e-6,'- zooms back out');
    await page.keyboard.press('/');assert.equal(await page.locator('input[aria-label="Find node"]').evaluate(el=>document.activeElement===el),true);
    const editingRatio=await cameraRatio();
    await page.keyboard.type('+-');assert.equal(await page.locator('input[aria-label="Find node"]').inputValue(),'+-');assert.equal(await cameraRatio(),editingRatio);
    await page.locator('input[aria-label="Find node"]').fill('');
    await page.keyboard.type('hls');await page.keyboard.press('Backspace');assert.equal(await page.locator('input[aria-label="Find node"]').inputValue(),'hl');assert.equal(await active(),names.at(-1));
    await page.locator('.canvas-element').last().click({position:{x:450,y:350}});
    await page.keyboard.press('?');await page.getByText('Last shortcut: ? → help',{exact:true}).waitFor();
    await page.keyboard.press('s');await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapping&&window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapFiles.length===4);
    assert.equal((await readdir(directory)).length,4);
    await page.keyboard.press('Space');await page.keyboard.press('l');
    const savedName=(await readdir(directory)).find(name=>!names.includes(name));
    await page.waitForFunction(name=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));return !c.snapsBusy && c.snapshots.activeFile?.filename===name;},savedName);
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.interactionHandler.onClickNode({node:'other',event:{original:new MouseEvent('click',{shiftKey:true})}});
        if([...v.elementSelection.nodes].join(',')!=='other') throw new Error('Saved exact selection changed on repeated addition');
    });
    // Exercise a real Option-click through Sigma's mouse captor, not only handler calls.
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.stopLayout();v.graph.nodes().forEach((key,index)=>v.graph.mergeNodeAttributes(key,{x:index*300,y:0}));
        v.elementSelection.replace(v.graph.nodes());v.sigma.setCustomBBox(null);v.focusHighlightedNodes();
    });
    await page.waitForTimeout(350);
    const point=await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        const p=v.sigma.graphToViewport(v.graph.getNodeAttributes('shared'));
        const r=v.sigma.getContainer().getBoundingClientRect();return {x:r.x+p.x,y:r.y+p.y};
    });
    await page.keyboard.down('Alt');await page.mouse.click(point.x,point.y);await page.keyboard.up('Alt');
    assert.equal(await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.elementSelection.nodes.has('shared')),false,'Real Option-click subtracts the clicked node');
    // Exact edits must remove nodes from an original explicit set and from overlapping groups.
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.elementSelection.replace(v.graph.nodes());
        v.interactionHandler.onClickNode({node:'shared',event:{original:new MouseEvent('click',{altKey:true})}});
        if(v.elementSelection.nodes.has('shared')) throw new Error('Option-click did not remove original node');
        window.workingOriginal=structuredClone(v.graph.export());
        window.workingCamera={...v.sigma.getCamera().getState()};
    });
    await page.getByRole('tab',{name:'Elements',exact:true}).click();
    await page.keyboard.press('Shift+r');
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.stopLayout();
        if(v.graph.hasNode('shared')||v.graph.size!==0) throw new Error('Excluded shared attribute still constrains the working layout');
        if(!v.hasWorkingContext) throw new Error('Missing original context');
        v.removeFromGraph('n');
        if(v.interactionHandler.state.selectedNode==='n') throw new Error('Removed node still inspected');
    });
    await page.screenshot({path:join(tmpdir(),'studio-working-subset.png')});
    await page.getByRole('button',{name:'Restore context',exact:true}).first().click();
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        if(v.hasWorkingContext||v.graph.order!==window.workingOriginal.nodes.length) throw new Error('Context not restored');
        for(const node of window.workingOriginal.nodes){
            const current=v.graph.getNodeAttributes(node.key);
            if(current.x!==node.attributes.x||current.y!==node.attributes.y) throw new Error('Original positions lost');
        }
        if(JSON.stringify(v.sigma.getCamera().getState())!==JSON.stringify(window.workingCamera)) throw new Error('Original camera lost: '+JSON.stringify({now:v.sigma.getCamera().getState(),original:window.workingCamera}));
    });
    // Native UI hints work with Vimium fully disabled, and activate a real control.
    const hintButton=page.locator('[aria-label="Kinds"] .highlight-chip').first();
    await page.evaluate(()=>document.activeElement?.blur());
    const expanded=await hintButton.getAttribute('aria-pressed');
    const box=await hintButton.boundingBox();
    await page.keyboard.press('f');await page.waitForSelector('.studio-ui-hints span');
    const uiHint=await page.evaluate(()=> {
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));
        const target=document.querySelector('[aria-label="Kinds"] .highlight-chip');
        return c.uiHints.entries.find(entry=>entry.target===target)?.label;
    });
    assert.ok(uiHint, 'Visible kind chip has a native UI hint');
    await page.keyboard.type(uiHint);
    await page.waitForFunction(expanded=>document.querySelector('[aria-label="Kinds"] .highlight-chip')?.getAttribute('aria-pressed')!==expanded,expanded);
    assert.equal(await page.locator('.studio-ui-hints').count(),0);
    console.log('PASS native f hints activate a visible UI control');
    await checkGraphNavigation(page, 'saved preview');
    await checkGraphCustomise(page, 'saved preview');
    await checkPaneFocus(page, escalated, 'saved preview');
    await page.locator('.canvas-element').last().click({position:{x:450,y:350}});
    const url=page.url();await page.keyboard.press('Backspace');await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).inlineSnap).catch(async error=>{
        console.error(errors);
        console.error(await page.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));return {last:c.lastShortcut,active:document.activeElement?.outerHTML,visible:c.isKeyboardVisible(),busy:c.snapsBusy};}));
        throw error;
    });assert.equal(page.url(),url);
    // Returning live cancels a pending file response, including from an empty live surface.
    let release;
    const delayed=new Promise(resolve=>release=resolve);
    await page.route('**/api/viewer/snap?*',async route=>{await delayed;await route.continue();});
    await page.keyboard.press('Space');await page.keyboard.press('l');
    await page.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapsBusy);
    await page.keyboard.press('Backspace');release();
    await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).snapsBusy);
    assert.equal(await page.evaluate(()=>!!window.ng.getComponent(document.querySelector('ts-graph-canvas')).inlineSnap),false);
    assert.deepEqual(errors,[]);
    console.log('PASS +/- camera zoom and input protection, r restart from current positions, real Option-click, working subset UI and original context/camera restoration; idempotent Shift/Option clicks, Enter focus, saved selection restoration; Space h/l from graph focus, order/wrap, / finder, text editing protection, ? help, s real save, Backspace live without navigation, cancellation of pending snap load');
} catch(error) {
    console.error(errors);console.error(await page?.locator("body").innerText());throw error;
} finally {
    await context?.close();await browser?.close();server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});
}
