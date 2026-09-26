import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** UI preferences and caret style following on the current temporary working graph. */
export async function checkGraphCustomise(page, label) {
    const tab=page.locator('ts-graph-side-panel-customise-tab');
    const open=async()=>{await page.getByRole('tab',{name:'Customise',exact:true}).click();await tab.waitFor();};
    const section=name=>tab.getByRole('button',{name,exact:true});
    const expanded=async()=>Promise.all(['Settings','Kinds','Types','Edges'].map(name=>section(name).getAttribute('aria-expanded')));
    await open();
    await checkLineThickness(page,tab,section,label);
    // Deliberately choose a mix that differs from the defaults.
    for (const [name,wanted] of [['Settings',false],['Kinds',false],['Types',true],['Edges',false]]) {
        if((await section(name).getAttribute('aria-expanded'))!==String(wanted)) await section(name).click();
    }
    const choices=await expanded();
    const target=await page.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        const key=v.graph.nodes().find(key=>{
            const a=v.graph.getNodeAttributes(key);return !a.viewHidden&&a.metadata?.concept&&(a.metadata.concept.type?.label||a.metadata.concept.label);
        });
        v.endNavigation();
        const data=v.sigma.getNodeDisplayData(key);
        v.sigma.getCamera().setState({x:data.x,y:data.y,ratio:1});v.sigma.refresh();window.ng.applyChanges(c);
        const concept=v.graph.getNodeAttribute(key,'metadata').concept;
        const p=v.sigma.graphToViewport(v.graph.getNodeAttributes(key)),r=v.sigma.getContainer().getBoundingClientRect();
        return {type:concept.type?.label??concept.label,x:r.x+p.x,y:r.y+p.y};
    });
    await page.mouse.click(target.x,target.y);
    await page.waitForFunction(type=>document.querySelector('.style-row.caret-style')?.getAttribute('data-type-label')===type,target.type);
    assert.deepEqual(await expanded(),choices);
    await page.getByRole('tab',{name:'Elements',exact:true}).click();await open();
    assert.deepEqual(await expanded(),choices,'Section expansion survives tab destruction');
    await page.screenshot({path:join(tmpdir(),`studio-customise-${label.replaceAll(' ','-')}.png`)});
    // Collapsing Types remains an explicit choice even as the caret moves.
    await section('Types').click();
    await page.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        const current=v.navigation.caret;
        const key=v.graph.nodes().find(k=>k!==current&&!v.graph.getNodeAttribute(k,'viewHidden'));
        if(key) v.pointCaret(key);window.ng.applyChanges(c);
    });
    assert.equal(await section('Types').getAttribute('aria-expanded'),'false');
    await tab.getByRole('button',{name:'Show style row',exact:true}).click();
    assert.equal(await section('Types').getAttribute('aria-expanded'),'true');
    assert.equal(await tab.locator('.caret-style').count(),1);
    // Render a caret style outside the manually filtered/capped list without erasing that filter.
    await page.evaluate(()=>{
        const t=window.ng.getComponent(document.querySelector('ts-graph-side-panel-customise-tab'));
        t.typeFilter='a-filter-that-matches-nothing';t.recomputeDisplayedTypes();window.ng.applyChanges(t);
    });
    assert.equal(await tab.locator('.caret-style').count(),1);
    const beforeStyles=await page.evaluate(()=>localStorage.getItem('typedb-studio-graph-styles'));
    await section('Settings').click();await section('Settings').click();
    assert.equal(await page.evaluate(()=>localStorage.getItem('typedb-studio-graph-styles')),beforeStyles,'UI expansion never saves a captured preset as global styles');
    // Dock rebuilds the component tree and renderer; persisted choices survive.
    await page.locator('.dock-kebab').click();
    const menu=page.getByRole('menuitem',{name:'Dock to bottom',exact:true});
    const dockBottom=await menu.count()>0;
    await (dockBottom?menu:page.getByRole('menuitem',{name:'Dock to right',exact:true})).click();
    await open();assert.deepEqual(await expanded(),choices,'Section expansion survives docking');
    await page.getByRole('tab',{name:'Elements',exact:true}).click();
    if(label==='saved preview') {
        const fresh=await page.context().newPage();
        try {
            await fresh.goto(new URL('/snap',page.url()).href);
            for(const reload of [false,true]) {
                if(reload) await fresh.reload();
                await fresh.waitForSelector('ts-graph-canvas');
                await fresh.getByRole('tab',{name:'Customise',exact:true}).click();
                const freshTab=fresh.locator('ts-graph-side-panel-customise-tab');
                const values=await Promise.all(['Settings','Kinds','Types','Edges'].map(name=>freshTab.getByRole('button',{name,exact:true}).getAttribute('aria-expanded')));
                assert.deepEqual(values,choices,'Expansion survives a fresh page and full reload');
            }
        } finally { await fresh.close();await page.bringToFront(); }
    }
    console.log(`PASS ${label}: Customize expansion persistence, caret style highlighting/reveal, filter reachability, preset isolation and docking`);
}

async function checkLineThickness(page,tab,section,label) {
    const saved=await page.evaluate(()=>{
        const t=window.ng.getComponent(document.querySelector('ts-graph-side-panel-customise-tab'));
        const v=t.visualiser;v.stopLayout();
        window.thicknessBefore={preset:t.styleService.capturePreset(),nodes:v.graph.nodes().map(key=>({key,attributes:structuredClone(v.graph.getNodeAttributes(key))})),
            camera:v.sigma.getCamera().getState(),bbox:v.sigma.getCustomBBox(),selection:{active:v.elementSelection.active,nodes:[...v.elementSelection.nodes]}};
        const row=t.discoveredTypes[0];
        return {kind:row.kind,type:row.typeLabel};
    });
    for(const name of ['Kinds','Types','Edges']) if((await section(name).getAttribute('aria-expanded'))!=='true') await section(name).click();
    const typeInput=tab.getByRole('spinbutton',{name:'Outline thickness for '+saved.type,exact:true});
    await typeInput.fill('3');await typeInput.press('Tab');
    const allEdges=tab.getByRole('spinbutton',{name:'Default edge thickness',exact:true});
    await allEdges.fill('2.5');await allEdges.press('Tab');
    const tag=await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-side-panel-customise-tab')).edgeLabels[0]);
    if(tag) {
        const edge=tab.getByRole('spinbutton',{name:'Edge thickness for '+tag.displayLabel,exact:true});
        await edge.fill('4');await edge.press('Tab');
    }
    assert.equal(await page.evaluate(({kind,type,tag})=>{
        const t=window.ng.getComponent(document.querySelector('ts-graph-side-panel-customise-tab')),v=t.visualiser,s=t.styleService;
        if(s.getNodeLineThickness(kind,type)!==3||s.getEdgeLineThickness()!==2.5||(tag&&s.getEdgeLineThickness(tag)!==4))return false;
        const preset=s.capturePreset();s.applyCapturedPreset(preset);
        v.graph.forEachNode((key,a)=>{
            const c=a.metadata.concept;
            if((c.type?.label??c.label)===type&&v.sigma.getSetting('nodeReducer')(key,a).lineThickness!==3)throw new Error('Outline reducer lost thickness');
        });
        v.graph.forEachEdge((key,a)=>{
            const expected=s.getEdgeLineThickness(a.metadata?.dataEdge?.tag??a.label);
            if(v.sigma.getSetting('edgeReducer')(key,a).size!==a.size*expected)throw new Error('Edge reducer lost thickness');
        });
        return s.getNodeLineThickness(kind,type)===3;
    },{...saved,tag:tag?.tag}),true,'Thickness survives capture/restore and reaches rendering');
    await typeInput.fill('');await typeInput.press('Tab');
    assert.equal(await page.evaluate(({kind,type})=>{
        const s=window.ng.getComponent(document.querySelector('ts-graph-side-panel-customise-tab')).styleService;
        return s.getNodeLineThickness(kind,type)===s.getNodeLineThickness(kind)&&s.typeStyles[type]?.lineThickness===undefined;
    },saved),true,'Blank type thickness inherits the kind');
    // Render all four outline programs at a visibly different thickness.
    await typeInput.fill('4');await typeInput.press('Tab');
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        const keys=v.graph.nodes().slice(0,4);
        for(const key of v.graph.nodes()) v.graph.setNodeAttribute(key,'viewHidden',!keys.includes(key));
        for(const [i,shape] of ['ellipse','rounded-rect','diamond','hexagon'].entries()) if(keys[i])
            v.graph.mergeNodeAttributes(keys[i],{type:shape,x:i*200,y:0});
        v.elementSelection.replace(keys);v.sigma.setCustomBBox({x:[-100,700],y:[-150,150]});
        v.sigma.refresh();v.sigma.getCamera().setState({x:.5,y:.5,ratio:1.5,angle:0});
    });
    await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().isAnimated());
    await page.screenshot({path:join(tmpdir(),`studio-line-thickness-${label.replaceAll(' ','-')}.png`)});
    await page.evaluate(()=>{
        const t=window.ng.getComponent(document.querySelector('ts-graph-side-panel-customise-tab')),v=t.visualiser,b=window.thicknessBefore;
        t.styleService.applyCapturedPreset(b.preset,true);
        for(const n of b.nodes) v.graph.replaceNodeAttributes(n.key,n.attributes);
        if(b.selection.active)v.elementSelection.replace(b.selection.nodes);else v.elementSelection.clear();
        v.sigma.setCustomBBox(b.bbox);v.sigma.refresh();v.sigma.getCamera().setState(b.camera);
        v.sigma.refresh();t.typeFilter='';t.recomputeDisplayedTypes();window.ng.applyChanges(t);
    });
}
