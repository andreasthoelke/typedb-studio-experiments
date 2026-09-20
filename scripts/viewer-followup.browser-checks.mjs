import assert from 'node:assert/strict';

/** Runs only against viewer-run.browser's disposable TypeDB database. */
export async function checkFollowups(page, schemaPage, run, database) {
    for (const p of [page, schemaPage]) assert.equal(await p.evaluate(() =>
        window.ng.getComponent(document.querySelector('ts-query-page, ts-schema-page')).graphMaximised), true,
    'Local Query and Schema start maximised');
    const wait = async result => {
        assert.equal(result.execution.status,'success',JSON.stringify(result));
        for (const p of [page, schemaPage]) await p.waitForFunction(id => {
            const c = window.ng.getComponent(document.querySelector('ts-query-page, ts-schema-page'));
            return c.bridge.lastRequest?.id === id && !c.bridge.pending && !c.bridge.busy && !c.bridge.schema.isRefreshing;
        }, result.id);
    };
    // Rebuild a canvas *during* refresh: the old saved graph must not return.
    await schemaPage.evaluate(() => {
        const c = window.ng.getComponent(document.querySelector('ts-schema-page'));
        const original = c.state.initialiseOutput.bind(c.state);
        c.state.initialiseOutput = () => {
            original(); c.onGraphCanvasRebuilt(c.graphCanvasComponents.first.canvasEl);
        };
    });
    await wait(await run('define attribute followup-check, value boolean; entity mental-state, owns followup-check;'));
    assert.ok(await schemaPage.evaluate(() => {
        const v = window.ng.getComponent(document.querySelector('ts-schema-page')).state.visualiser.visualiser;
        return v.graph.nodes().some(k => v.graph.getNodeAttribute(k,'metadata').concept.label === 'followup-check');
    }), 'First schema delivery after a remount contains newly defined types');
    const source = 'match\n  $tension isa tension, links (pole: $state), has intensity $intensity;\n  $state has title $name;\nfetch { "state": $name, "intensity": $intensity };';
    await wait(await run(source));
    const beforeRemount=await page.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-query-page')),g=c.currentRun.graph;
        g.visualiser.reLayout();const nodes=g.visualiser.graph.order,edges=g.visualiser.graph.size,el=g.canvasEl;
        g.detach();g.attach(el);
        return {nodes,edges,afterNodes:g.visualiser.graph.order,afterEdges:g.visualiser.graph.size,running:g.visualiser.layout.isRunning};
    });
    assert.equal(beforeRemount.afterNodes,beforeRemount.nodes);assert.equal(beforeRemount.afterEdges,beforeRemount.edges);
    assert.equal(beforeRemount.running,true,'Query remount resumes an interrupted layout');
    const caret = async (line, word) => {
        const response = await page.request.post(new URL('/api/viewer/caret', page.url()).href,
            {data:{source,line,column:source.split('\n')[line].indexOf(word),database,schemaOnly:false}});
        assert.equal(response.status(),202); const {id} = await response.json();
        const selected = [];
        for (const p of [page,schemaPage]) {
            await p.waitForFunction(id => {
                const b=window.ng.getComponent(document.querySelector('ts-query-page, ts-schema-page')).bridge;
                return b.lastCaretRequest?.id===id && !b.caretRequest && !b.caretBusy;
            },id);
            selected.push(await p.evaluate(() => {
                const c=window.ng.getComponent(document.querySelector('ts-query-page, ts-schema-page'));
                const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
                return {message:c.bridge.caretMessage,concept:v.navigation.caret ? v.graph.getNodeAttribute(v.navigation.caret,'metadata').concept : null};
            }));
        }
        for (const s of selected) assert.match(s.message,/^Caret:/,JSON.stringify({selected,
            schema:await page.evaluate(()=>{const s=window.ng.getComponent(document.querySelector('ts-query-page')).bridge.schema;return {refreshing:s.isRefreshing,entities:Object.keys(s.value$.value.entities),relations:Object.keys(s.value$.value.relations),roles:s.value$.value.relations.tension?.relatedRoles};})}));
        return selected;
    };
    for (const word of ['pole','links']) {
        const [q,s] = await caret(1,word);
        assert.equal(q.concept.type.label,'mental-state'); assert.equal(s.concept.label,'tension:pole');
    }
    const [attribute,type] = await caret(1,'$intensity');
    assert.equal(attribute.concept.kind,'attribute');assert.equal(type.concept.label,'intensity');
    const [player,playerType] = await caret(2,'$state');
    assert.equal(player.concept.type.label,'mental-state');assert.equal(playerType.concept.label,'mental-state');

    // Exercise both real Explorer implementations, not the Snaps scroll container.
    for (const p of [page,schemaPage]) {
        await p.bringToFront();
        await p.keyboard.press('Control+w');await p.keyboard.press('e');
        await p.waitForSelector('.explorer-pane .detail-content');
        const before=await p.evaluate(() => {
            const scroller=document.querySelector('.explorer-pane .detail-content');
            const filler=document.createElement('div');filler.dataset.scrollFixture='true';filler.style.height='2500px';scroller.append(filler);
            const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
            v.stopLayout();v.stopCameraAnimation();scroller.scrollTop=0;
            return {...v.sigma.getCamera().getState()};
        });
        await p.keyboard.press('Control+e');
        assert.ok(await p.locator('.explorer-pane .detail-content').evaluate(el=>el.scrollTop)>0,
            JSON.stringify(await p.evaluate(()=>({active:document.activeElement?.className,panes:[...document.querySelectorAll('.pane-active')].map(e=>e.getAttribute('tsPane')),metrics:[...document.querySelectorAll('.explorer-pane .detail-content')].map(e=>({h:e.clientHeight,scroll:e.scrollHeight,top:e.scrollTop,overflow:getComputedStyle(e).overflowY}))}))));
        await p.keyboard.press('G');
        assert.ok(await p.locator('.explorer-pane .detail-content').evaluate(el=>el.scrollTop+el.clientHeight>=el.scrollHeight-1));
        await p.keyboard.press('g');await p.keyboard.press('g');
        assert.equal(await p.locator('.explorer-pane .detail-content').evaluate(el=>el.scrollTop),0);
        assert.deepEqual(await p.evaluate(()=>({...window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().getState()})),before);
        await p.evaluate(()=>document.querySelectorAll('[data-scroll-fixture]').forEach(el=>el.remove()));
    }
    await page.bringToFront();
    await page.keyboard.press('Control+w');await page.keyboard.press('g');
    const output=()=>page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-query-page')).state.outputTypeControl.value);
    for (const expected of ['raw','log','table','graph']) { await page.keyboard.press('Control+f');assert.equal(await output(),expected); }
    await page.keyboard.press('Control+d');assert.equal(await output(),'table');
    await page.keyboard.press('Control+f');assert.equal(await output(),'graph');
    // Editor tabs are reachable after leaving maximised graph mode.
    await page.evaluate(()=>{const c=window.ng.getComponent(document.querySelector('ts-query-page'));c.graphMaximised=false;c.newQueryTab();window.ng.applyChanges(c);});
    await page.keyboard.press('Control+w');await page.keyboard.press('q');
    const tab=()=>page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-query-page')).queryTabsState.selectedTabIndex$.value);
    const index=await tab();await page.keyboard.press('Control+d');assert.notEqual(await tab(),index);
    await page.keyboard.press('Control+f');assert.equal(await tab(),index);
    console.log('PASS first-delivery schema remount, role/player/attribute caret, real Query/Schema Explorer scrolling, gg/G, output/editor tab cycling and startup maximisation');
}
