/** Isolated browser regression for type arrows, theme-neutral snaps, shared tabs,
 * compact spacing and correspondence across windows. No database mutations. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViewerServer } from './viewer-server.mjs';
let pw;
if (process.env.PLAYWRIGHT_MODULE) pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
else for (const dir of await readdir(join(homedir(), '.npm', '_npx'))) {
    try { pw = await import(pathToFileURL(join(homedir(), '.npm', '_npx', dir, 'node_modules/playwright/index.mjs')).href); break; } catch {}
}
if (!pw) throw Error('Set PLAYWRIGHT_MODULE');
const escalated=[];
const server=createViewerServer({windowFocus:direction=>{escalated.push(direction);return {focused:true};}}); server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await pw.chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1300,height:950},deviceScaleFactor:2}),errors=[];
const origin=`http://localhost:${server.address().port}`;
const node=(key,x,y,concept)=>({key,attributes:{x,y,size:30,width:35,height:25,type:'ellipse',label:key,color:'#111111',borderColor:'#ffffff',metadata:{concept,defaultLabel:key,hoverLabel:key}}});
const nodes=[node('a',-150,0,{kind:'entity',iid:'0x1',type:{kind:'entityType',label:'goal'}}),
    node('b',0,-100,{kind:'entity',iid:'0x2',type:{kind:'entityType',label:'goal'}}),
    node('other',0,140,{kind:'entity',iid:'0x3',type:{kind:'entityType',label:'other'}}),
    node('goal',180,0,{kind:'entityType',label:'goal'})];
const snap={format:'typedb-studio-graph-snap',version:1,createdAt:new Date().toISOString(),query:'fixture',expansionQueries:[],schemaMode:false,database:'workflow-fixture',
    graph:{attributes:{elementSelection:{active:true,nodes:['other']}},nodes,edges:[{key:'isa',source:'a',target:'goal',attributes:{label:'isa!',size:2,color:'#ff0000',type:'curved',curvature:.25,metadata:{defaultLabel:'isa!',answerIndex:0,dataEdge:{tag:'isa!'}}}}]},
    style:{name:'Captured dark',description:'',kindStyles:{},typeStyles:{},edgeLabelColors:{},background:{type:'solid',color1:'#050505',color2:'#050505',gradientAngle:0}},
    view:{camera:{x:.5,y:.5,ratio:1.1,angle:0},bbox:{x:[-220,250],y:[-200,200]},viewport:{width:1000,height:700},searchTerm:'',finderMatches:null,selectedNode:null,selectedNeighbors:[],highlightedEdges:[],highlightedTypes:[],highlightedKinds:[]},labels:{attributes:[],overrides:[]}};
async function mount(schema=false) {
    const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(origin+'/snap');await page.waitForSelector('ts-graph-canvas');
    await page.evaluate(({snap,schema})=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));
        c.liveStyleService.themeService.setPreference("light");
        c.liveStyleService.background={type:'solid',color1:'#f9f9f9',color2:'#ffffff',gradientAngle:0};
        const incoming=structuredClone(snap);incoming.schemaMode=schema;
        if(schema) {incoming.graph.nodes=incoming.graph.nodes.filter(n=>n.key==='goal');incoming.graph.edges=[];incoming.graph.attributes.elementSelection={active:false,nodes:[]};}
        c.snapshots.opened$.next(incoming);
    },{snap,schema});
    await page.waitForFunction(()=>!!window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser);
    return page;
}
try {
    const query=await mount();
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.layoutDensity),'compact');
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.styleService.effectiveBackgroundHex),'#f9f9f9');
    const arrowPixels=await query.evaluate(()=>{
        const canvas=document.querySelector('canvas.sigma-semanticArrows');const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        return pixels.filter((_,i)=>i%4===3&&pixels[i]>0).length;
    });
    assert.ok(arrowPixels>0,'An isa! arrow is painted');
    assert.deepEqual(await query.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        const layer=v.sigma.getCanvases().semanticArrows, r=layer.getBoundingClientRect(), d=v.sigma.getDimensions();
        return [r.width===d.width,r.height===d.height,layer.width===d.width*devicePixelRatio];
    }),[true,true,true],'Arrow layer has correct CSS and backing dimensions before any resize at Retina scale');
    await query.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        v.setLayoutDensity('tight');v.stopLayout();v.reLayout();v.stopLayout();
    });
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.layoutDensity),'tight','Redraw preserves density');
    const tabFit=await query.evaluate(()=>{
        const row=document.querySelector('[aria-label="Graph panels"]'),r=row.getBoundingClientRect();
        return [...row.querySelectorAll('[role="tab"]')].map(el=>({label:el.textContent.trim(),width:el.getBoundingClientRect().width,rowWidth:r.width,overflow:el.getBoundingClientRect().right-r.right,fits:el.getBoundingClientRect().left>=r.left-1&&el.getBoundingClientRect().right<=r.right+1}));
    });
    console.log('Panel tab fit:', tabFit);
    assert.ok(tabFit.every(t=>t.fits),'All six tabs fit in the standard side panel');
    // Every tab is in the same keyboard cycle, in the requested order.
    await query.getByRole('tab',{name:'Explorer',exact:true}).click();
    const visited=[];
    for(let i=0;i<6;i++) { visited.push((await query.locator('[data-pane-tabs="panel"] [data-pane-tab].active').innerText()).trim());await query.keyboard.press('Control+f'); }
    assert.deepEqual(visited,['Explorer','Snaps','Elements','Themes','Customise','Source']);
    await query.keyboard.press('Control+d');assert.equal(await query.locator('[data-pane-tabs="panel"] [data-pane-tab].active').innerText(),'Source');
    // First-entry motion must act from the graph, without spending a chord on focus.
    await query.evaluate(()=>{document.activeElement?.blur();window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.activePane=null;});
    const focusResponse=query.waitForResponse(r=>r.url().endsWith('/api/viewer/focus'));
    await query.keyboard.press('Control+w');await query.keyboard.press('h');await focusResponse;
    assert.equal(escalated.at(-1),'west');
    await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('graph'));
    await query.keyboard.press('Control+,');
    await query.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).dock==='bottom');
    const graphHeight=await query.locator('[tsPane="graph"]').evaluate(el=>el.getBoundingClientRect().height);
    await query.keyboard.press('Control+w');await query.keyboard.press('j');
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focusedPane),'panel');
    await query.keyboard.press('Control+,');
    await query.waitForFunction(h=>document.querySelector('[tsPane="graph"]').getBoundingClientRect().height<h,graphHeight);
    // Ctrl-w Space j/k: the focused pane (here the panel) gets taller, then shorter.
    const panelHeight=()=>query.locator('ts-graph-side-panel').evaluate(el=>el.getBoundingClientRect().height);
    const beforeGrow=await panelHeight();
    await query.keyboard.press('Control+w');await query.keyboard.press('Space');await query.keyboard.press('j');
    await query.waitForFunction(h=>document.querySelector('ts-graph-side-panel').getBoundingClientRect().height>h+20,beforeGrow);
    const grown=await panelHeight();
    await query.keyboard.press('Control+w');await query.keyboard.press('Space');await query.keyboard.press('k');
    await query.waitForFunction(h=>document.querySelector('ts-graph-side-panel').getBoundingClientRect().height<h-20,grown);
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.lastAction),'Ctrl+w Space k');
    // Both native menu entries and Material selects accept the control aliases.
    await query.locator('button').filter({has:query.locator('.fa-line-height')}).click();
    await query.keyboard.press('Control+n');await query.keyboard.press('Enter');
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.layoutDensity),'default');
    await query.getByRole('tab',{name:'Customise',exact:true}).click();
    await query.locator('mat-select').first().click();
    await query.keyboard.press('Control+n');await query.keyboard.press('Enter');
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).liveStyleService.labelColorMode),'fixed');
    await query.locator('.mat-mdc-select-panel').waitFor({state:'detached'});
    // Source metadata is available in maximised mode and survives a snap remount.
    await query.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));c.contextSource={path:'/tmp/tour.tql',line:10,anchor:'# ─ 6f · Fill the slots',title:'6f · Fill the slots',comment:'Keep the identity.',query:'original snippet'};});
    await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('graph'));
    await query.keyboard.press('Space');await query.keyboard.press('s');
    await query.getByRole('heading',{name:'6f · Fill the slots'}).waitFor();
    // The title and comment share one translucent plate over the canvas, and the PNG carries them too.
    assert.deepEqual(await query.evaluate(()=>[...document.querySelectorAll('.graph-source-caption span')].map(el=>el.textContent.trim())),['6f · Fill the slots','Keep the identity.']);
    const captionInk=await query.evaluate(async()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        const ink=async blob=>{const bitmap=await createImageBitmap(blob),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
            ctx.drawImage(bitmap,0,0);const data=ctx.getImageData(0,0,Math.min(300,bitmap.width),Math.min(60,bitmap.height)).data;let sum=0;for(let i=0;i<data.length;i+=4)sum+=data[i]+data[i+1]+data[i+2];return sum;};
        return [await ink(await v.exportPng('currentView')),await ink(await v.exportPng('currentView',{title:c.sourceTitle,comment:c.sourceComment}))];
    });
    assert.notEqual(captionInk[0],captionInk[1],'PNG export draws the caption');
    // r keeps the caret on its node; zz from a focused panel still centres the graph caret.
    const kept=await query.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;v.pointCaret('b','none',true);v.reLayout();v.stopLayout();return v.navigation.caret;});
    assert.equal(kept,'b');
    await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('panel'));
    await query.keyboard.press('z');await query.keyboard.press('z');
    await query.waitForFunction(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;const d=v.sigma.getDimensions();
        const p=v.sigma.framedGraphToViewport(v.sigma.getNodeDisplayData('b'));return !v.sigma.getCamera().isAnimated()&&Math.abs(p.x-d.width/2)<2&&Math.abs(p.y-d.height/2)<2;});
    const pair=await query.evaluate(()=>{
        const s=window.ng.getComponent(document.querySelector('ts-graph-canvas')).liveStyleService;
        s.setKindStyle('entity',{width:123,color:'#aabbcc'});s.choosePalette('dark');
        const dark=s.getKindStyle('entity');s.setKindStyle('entity',{height:31});s.choosePalette('light');
        return {darkWidth:dark.width,darkColor:dark.color,light:s.getKindStyle('entity')};
    });
    assert.equal(pair.darkWidth,123);assert.notEqual(pair.darkColor,'#aabbcc');assert.equal(pair.light.color,'#aabbcc');assert.equal(pair.light.height,31);
    const schema=await mount(true);
    await schema.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));c.visualiser.pointCaret('goal');});
    await schema.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('graph'));
    await schema.keyboard.press('Space');await schema.keyboard.press('Enter');
    await query.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.correspondenceNodes.size===2);
    const correspondence=await query.evaluate(()=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;return {caret:v.navigation.caret,marks:[...v.correspondenceNodes],selection:[...v.elementSelection.nodes]};});
    assert.deepEqual(correspondence.marks,['a','b']);assert.ok(correspondence.marks.includes(correspondence.caret));assert.deepEqual(correspondence.selection,['other']);
    await schema.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.endNavigation());
    await query.bringToFront();await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).paneFocus.focus('graph'));
    await query.keyboard.press('Space');await query.keyboard.press('Enter');
    await schema.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.navigation.caret==='goal');
    await query.keyboard.press('Escape');
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.correspondenceNodes.size),0);
    // Theme changes made after a capture survive both standalone and inline restoration.
    await query.evaluate(snap=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));
        c.liveStyleService.background={type:'solid',color1:'#fafafa',color2:'#ffffff',gradientAngle:0};
        c.openGraphSnap(snap);
    },snap);
    assert.equal(await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.styleService.effectiveBackgroundHex),'#fafafa');
    await query.evaluate(async()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        const blob=await v.exportPng('currentView');if(!blob.size)throw Error('Empty PNG');
    });
    await query.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.clearGraphSelection());
    await query.screenshot({path:join(tmpdir(),'studio-workflow-light.png')});
    // Role direction follows relation/player endpoints even when both are relations.
    const rolePage=await mount();
    const roleDirections=await rolePage.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.stopLayout();v.clearGraphSelection();
        v.graph.mergeNodeAttributes('a',{metadata:{concept:{kind:'relation',iid:'0xa',type:{kind:'relationType',label:'motivation'}},defaultLabel:'relation'}});
        v.graph.mergeNodeAttributes('goal',{metadata:{concept:{kind:'relation',iid:'0xb',type:{kind:'relationType',label:'scene'}},defaultLabel:'player relation'}});
        v.graph.mergeEdgeAttributes('isa',{type:'line',metadata:{dataEdge:{tag:'links',role:{kind:'roleType',label:'motivation:driver'}},defaultLabel:'driver'}});
        const ctx=v.sigma.getCanvases().semanticArrows.getContext('2d'), original=ctx.moveTo;
        let tip;ctx.moveTo=function(x,y){tip={x,y};return original.call(this,x,y);};
        const positions={};
        // Other fixture links would otherwise draw their default player arrows.
        v.styleService.setRoleArrow('links','none');
        for(const direction of ['relation','player','none']){
            tip=null;v.styleService.setRoleArrow('motivation:driver',direction);v.sigma.refresh();positions[direction]=tip;
        }
        // A role without its own setting inherits links; links defaults to toward the player.
        v.styleService.setRoleArrow('motivation:driver',null);v.styleService.setRoleArrow('links',null);
        const defaults={role:v.styleService.getRoleArrow('motivation:driver'),links:v.styleService.getRoleArrow('links')};
        v.styleService.setRoleArrow('links','relation');const inheritedRelation=v.styleService.getRoleArrow('motivation:driver');
        v.styleService.setRoleArrow('links',null);
        ctx.moveTo=original;
        const a=v.sigma.framedGraphToViewport(v.sigma.getNodeDisplayData('a'));
        const b=v.sigma.framedGraphToViewport(v.sigma.getNodeDisplayData('goal'));
        const dist=(p,q)=>Math.hypot(p.x-q.x,p.y-q.y);
        return {relation:dist(positions.relation,a)<dist(positions.relation,b),player:dist(positions.player,b)<dist(positions.player,a),none:positions.none,defaults,inheritedRelation};
    });
    assert.deepEqual(roleDirections,{relation:true,player:true,none:null,defaults:{role:'player',links:'player'},inheritedRelation:'relation'});await rolePage.close();
    if (process.env.TYPEDB_TEST_CONNECTION) {
        const fresh=await browser.newContext();
        await fresh.addInitScript(url=>localStorage.setItem('typeDBStudio.connections',JSON.stringify([{name:'Read-only startup test',url,preferences:{isStartupConnection:true}}])),process.env.TYPEDB_TEST_CONNECTION);
        const empty=await fresh.newPage();empty.on('pageerror',e=>errors.push(String(e)));
        await empty.goto(origin+'/query?nvim=0');
        await empty.locator('ts-graph-canvas .graph-canvas-container.maximised').waitFor();
        assert.equal(await empty.evaluate(()=>window.ng.getComponent(document.querySelector('ts-query-page')).state.currentTabRuns.length),0);
        assert.equal(await empty.locator('.graph-maximise-button').isVisible(),true,'Empty query route exposes maximise control');
        await empty.goto(origin+'/query?nvim=1');
        const source='match\n  occurrence-of (occurrence: $occurrence, subject: $subject);\n  composition (host: $host, slot: $slot, child: $occurrence);\n  $subject isa! $subject-type;';
        const posted=await empty.request.post(origin+'/api/viewer/query',{data:{query:source,database:'pts-tour3',sourceLocation:{path:'/tmp/tour.tql',line:1,anchor:'# ─ Explorer check',title:'Explorer check',comment:'Loaded relations',query:source}}});
        assert.equal(posted.status(),202);
        await empty.waitForFunction(()=>{const p=window.ng.getComponent(document.querySelector('ts-query-page'));return p?.state.graphOutput.visualiser?.graph.order>0&&!p.bridge.busy&&!p.bridge.pending;});
        await empty.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
            const depiction=v.graph.nodes().find(k=>v.graph.getNodeAttribute(k,'metadata').concept.type?.label==='depiction');
            if(!depiction)throw Error('No depiction in test database');v.pointCaret(depiction,'none',true);c.paneFocus.focus('explorer');});
        await empty.waitForFunction(()=>window.ng.getComponent(document.querySelector('ts-graph-instance-explorer'))?.state.allRelations.length>0);
        const inspection=await empty.evaluate(()=>{const e=window.ng.getComponent(document.querySelector('ts-graph-instance-explorer')),v=e.visualiser;
            const rel=e.state.allRelations.find(r=>v.nodeKeyByIid(r.relationIID));
            if(!rel||!e.isRelationAdded(rel))throw Error('Initially loaded relation not recognised');
            const old=v.navigation.caret, selection=[...v.elementSelection.nodes];e.revealRelation(rel);
            if(v.navigation.caret!==old)throw Error('Mark changed primary caret');
            if(!v.correspondenceNodes.has(v.nodeKeyByIid(rel.relationIID)))throw Error('Missing secondary mark');
            e.inspectRelation(rel);return {old,current:v.navigation.caret,selection,after:[...v.elementSelection.nodes]};});
        assert.notEqual(inspection.old,inspection.current);assert.deepEqual(inspection.selection,inspection.after);
        await empty.keyboard.press('Control+o');
        assert.equal(await empty.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.navigation.caret),inspection.old);
        await empty.getByRole('heading',{name:'Relations',exact:true}).waitFor();
        await empty.getByRole('button',{name:'Relations',exact:true}).focus();
        await empty.keyboard.press('z');await empty.keyboard.press('c');
        assert.equal(await empty.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-instance-explorer')).relationsCollapsed),true);
        await empty.keyboard.press('z');await empty.keyboard.press('o');
        assert.equal(await empty.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-instance-explorer')).relationsCollapsed),false);
        await empty.keyboard.press('Control+n');
        assert.notEqual(await empty.evaluate(()=>document.activeElement.textContent.trim()),'Relations');
        // Space Ctrl-n/p jumps between main sections instead of individual controls.
        await empty.getByRole('button',{name:'Relations',exact:true}).focus();
        await empty.keyboard.press('Space');await empty.keyboard.press('Control+p');
        const section=await empty.evaluate(()=>document.activeElement.textContent.trim());
        assert.match(section,/^Attributes/,'Space Ctrl-p reaches the previous section header');
        assert.equal(await empty.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-instance-explorer')).attributesCollapsed!==undefined),true);
        await empty.keyboard.press('Space');await empty.keyboard.press('Control+n');
        assert.match(await empty.evaluate(()=>document.activeElement.textContent.trim()),/^Relations/,'Space on a focused header does not click it');
        await empty.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));c.visualiser.stopLayout();c.liveStyleService.choosePalette('light');});
        await empty.evaluate(async()=>{await document.fonts.ready;const c=window.ng.getComponent(document.querySelector('ts-graph-canvas'));c.styleService.sidePanelDock='bottom';});
        await empty.waitForTimeout(300);
        await empty.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.centerCamera());
        await empty.screenshot({path:join(tmpdir(),'studio-paper-relations.png')});
        await empty.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).liveStyleService.choosePalette('dark'));
        await empty.screenshot({path:join(tmpdir(),'studio-ink-relations.png')});
        assert.equal(await empty.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).sourceTitle),'Explorer check');
        await fresh.close();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS Retina arrows/role directions, first-entry focus, pane resize, dropdown aliases, six tabs, source provenance, paired palettes, compact density, correspondence and snap restoration'+(process.env.TYPEDB_TEST_CONNECTION ? '; live empty Query startup, loaded relations, primary/secondary carets, history and Explorer folds' : ''));
} finally {await browser.close();server.closeViewers();server.closeAllConnections();await new Promise(r=>server.close(r));}
