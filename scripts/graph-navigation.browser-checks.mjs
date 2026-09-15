import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Shared checks for real Query, Schema and offline-preview canvases. Changes
 * only the temporary browser's working graph; never issues database writes. */
export async function checkGraphNavigation(page, label) {
    await page.bringToFront();
    const keys=await page.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        v.stopLayout();v.restoreContext();v.clearGraphSelection();
        const keys=v.graph.nodes().slice(0,4);
        if(keys.length<4) throw new Error('Navigation fixture needs four loaded nodes');
        window.navigationBefore=structuredClone(v.graph.export());
        v.graph.clearEdges();
        v.graph.addEdge(keys[0],keys[2],{type:'line',size:1,color:'#999999',metadata:{}});
        v.graph.addEdge(keys[1],keys[2],{type:'line',size:1,color:'#999999',metadata:{}});
        for(const key of v.graph.nodes()) v.graph.mergeNodeAttributes(key,{viewHidden:!keys.includes(key),viewDimmed:false});
        for(const [index,[x,y]] of [[0,0],[300,10],[620,0],[300,340]].entries()) v.graph.mergeNodeAttributes(keys[index],{x,y});
        const hidden=v.graph.nodes().find(key=>!keys.includes(key));
        if(hidden) v.graph.mergeNodeAttributes(hidden,{x:150,y:0});
        v.sigma.setCustomBBox({x:[-100,720],y:[-100,440]});
        v.sigma.refresh();v.sigma.getCamera().setState({x:.5,y:.5,ratio:1.5,angle:0});
        v.interactionHandler.inspectKeyboardNode(keys[0]);
        document.activeElement?.blur();window.ng.applyChanges(c);
        return keys;
    });
    const state=()=>page.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        return {mode:v.navigation.mode,caret:v.navigation.caret,selected:[...v.elementSelection.nodes],inspected:v.interactionHandler.state.selectedNode,
            camera:v.sigma.getCamera().getState(),order:v.graph.order,active:v.elementSelection.active,leader:c.leaderPending};
    });
    const settle=async()=>{
        await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().isAnimated());
        // Sigma schedules its final projection/render after the animation completes.
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    };
    const click=async (key,modifiers=[])=>{
        await settle();
        const p=await page.evaluate(key=>{
            const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
            const p=v.sigma.graphToViewport(v.graph.getNodeAttributes(key)),r=v.sigma.getContainer().getBoundingClientRect();
            return {x:r.x+p.x,y:r.y+p.y};
        },key);
        for(const mod of modifiers) await page.keyboard.down(mod);
        await page.mouse.click(p.x,p.y);
        for(const mod of modifiers.reverse()) await page.keyboard.up(mod);
    };
    await checkSpatialNavigation(page,keys,state,settle,click);
    // Inspection alone must preserve implicit rendering, including search highlights.
    await page.evaluate(keys=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        const rendering=()=>v.graph.nodes().map(key=>{
            const d=v.sigma.getSetting('nodeReducer')(key,v.graph.getNodeAttributes(key));return [key,d.color,d.label,d.hidden,d.zIndex>0];
        });
        for(const matches of [null,new Set([keys[1]])]) {
            v.finderMatches=matches;const before=JSON.stringify(rendering());
            v.pointCaret(keys[0]);v.pointCaret(keys[2]);
            if(v.elementSelection.active||v.finderMatches!==matches||JSON.stringify(rendering())!==before) throw new Error('Inspection changed implicit highlights');
        }
        v.finderMatches=null;v.elementSelection.replace([keys[0]]);v.endNavigation();
        window.expectedCentre=v.graphHintPoints().sort((a,b)=>{
            const {width,height}=v.sigma.getDimensions();return Math.hypot(a.x-width/2,a.y-height/2)-Math.hypot(b.x-width/2,b.y-height/2);
        })[0].key;
    },keys);
    await page.keyboard.press('c');await settle();
    assert.equal((await state()).mode,'caret');assert.equal((await state()).caret,await page.evaluate(()=>window.expectedCentre));
    assert.deepEqual((await state()).selected,[keys[0]]);
    await click(keys[0]);
    if((await state()).caret!==keys[0]) {
        await page.screenshot({path:join(tmpdir(),'studio-click-debug.png')});
        console.error('click diagnostic',await page.evaluate(()=>{
            const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
            return {camera:v.sigma.getCamera().getState(),dims:v.sigma.getDimensions(),container:v.sigma.getContainer().getBoundingClientRect().toJSON(),points:v.graphHintPoints(),drag:v.interactionHandler.state,attrs:v.graph.nodes().map(key=>[key,v.graph.getNodeAttributes(key).x,v.graph.getNodeAttributes(key).y])};
        }));
    }
    assert.equal((await state()).caret,keys[0]);
    await page.keyboard.press('l');await settle();
    assert.equal((await state()).caret,keys[1],'A nearby layout node wins over a distant direct neighbour');
    await page.keyboard.press('h');await settle();
    assert.equal((await state()).caret,keys[0],'Left uses current geometry');
    await page.keyboard.press('Control+o');await settle();assert.equal((await state()).caret,keys[1]);
    await page.evaluate(keys=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.graph.setNodeAttribute(keys[2],'viewHidden',true);v.pointCaret(keys[0]);
    },keys);
    await page.keyboard.press('l');await settle();
    assert.equal((await state()).caret,keys[1],'Hidden neighbours are skipped in favour of layout fallback');
    await page.evaluate(keys=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.graph.setNodeAttribute(keys[2],'viewHidden',false);v.graph.clearEdges();
        for(const [a,b] of [[0,1],[1,2],[1,3]]) v.graph.addEdge(keys[a],keys[b],{type:'line',size:1,color:'#999999',metadata:{}});
        v.pointCaret(keys[0]);
    },keys);
    await page.keyboard.press('l');await settle();
    assert.equal((await state()).caret,keys[1]);assert.equal((await state()).inspected,keys[1]);
    assert.deepEqual((await state()).selected,[keys[0]],'Plain motion leaves highlights unchanged');
    await page.keyboard.press('Control+Shift+l');await settle();
    assert.equal((await state()).caret,keys[2]);assert.deepEqual((await state()).selected,[keys[0],keys[2]]);
    await page.keyboard.press('h');await settle();
    assert.equal((await state()).caret,keys[1]);assert.deepEqual((await state()).selected,[keys[0],keys[2]],'Plain opposite motion leaves selection unchanged');
    await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'˙',code:'KeyH',altKey:true,bubbles:true,cancelable:true})));
    await settle();assert.equal((await state()).caret,keys[0]);assert.deepEqual((await state()).selected,[keys[2]],'macOS Option-h removes only the destination');
    await click(keys[0],['Shift']);await click(keys[0],['Shift']);
    assert.deepEqual(new Set((await state()).selected),new Set([keys[0],keys[2]]));
    await click(keys[0],['Alt']);await click(keys[0],['Alt']);assert.deepEqual((await state()).selected,[keys[2]]);
    await click(keys[1]);assert.equal((await state()).caret,keys[1]);assert.deepEqual((await state()).selected,[keys[2]]);
    await page.evaluate(keys=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.elementSelection.replace(keys.slice(0,2)),keys);
    assert.equal((await state()).caret,keys[1],'External selection edits preserve the caret');
    await page.keyboard.press('Enter');await settle();
    assert.equal(await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        const {width,height}=v.sigma.getDimensions(), b=v.navigationBounds([...v.elementSelection.nodes]);
        return b.left>=-1&&b.right<=width+1&&b.top>=-1&&b.bottom<=height+1;
    }),true,'Enter fits actual node bodies inside the viewport');
    await page.screenshot({path:join(tmpdir(),`studio-navigation-${label.replaceAll(' ','-')}.png`)});
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        const b=v.navigationBounds([...v.elementSelection.nodes]);
        window.zoomAnchor={x:(b.left+b.right)/2,y:(b.top+b.bottom)/2};
        window.zoomWorld=v.sigma.viewportToGraph(window.zoomAnchor);
    });
    const ratio=(await state()).camera.ratio;
    await page.keyboard.press('+');await settle();
    assert.ok(Math.abs((await state()).camera.ratio-ratio*.7)<1e-6);
    assert.ok(await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser,p=v.sigma.graphToViewport(window.zoomWorld);
        return Math.hypot(p.x-window.zoomAnchor.x,p.y-window.zoomAnchor.y)<.1;
    }),'Selection anchor remains fixed while zooming');
    await page.keyboard.press('-');await settle();
    const selected=(await state()).selected;
    for(const [key,axis,sign] of [['e','y',-1],['y','y',1],['h','x',-1],['l','x',1]]) {
        const before=(await state()).camera;
        await page.keyboard.press(`Control+${key}`);await settle();
        const after=(await state()).camera;
        assert.ok((after[axis]-before[axis])*sign>0,`Ctrl-${key} moves the camera in the intended direction`);
        assert.deepEqual((await state()).selected,selected);
    }
    await checkNudges(page, settle);
    // zz pans to the caret and leaves zoom, rotation, highlights and topology alone.
    const beforeCentre=await state();
    await page.keyboard.press('z');await page.keyboard.press('z');await settle();
    const centred=await state();
    assert.deepEqual(centred.selected,beforeCentre.selected);assert.equal(centred.caret,beforeCentre.caret);
    assert.equal(centred.camera.ratio,beforeCentre.camera.ratio);assert.equal(centred.camera.angle,beforeCentre.camera.angle);
    const centreDiagnostic=await page.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        const p=v.sigma.graphToViewport(v.graph.getNodeAttributes(v.navigation.caret)),d=v.sigma.getDimensions();
        return {p,d,camera:v.sigma.getCamera().getState(),data:v.sigma.getNodeDisplayData(v.navigation.caret),shortcut:c.lastShortcut,leader:c.leaderPending};
    });
    assert.ok(Math.hypot(centreDiagnostic.p.x-centreDiagnostic.d.width/2,centreDiagnostic.p.y-centreDiagnostic.d.height/2)<.1,
        'zz puts the caret in the exact viewport centre: '+JSON.stringify(centreDiagnostic));
    for(const angle of [0,0.55]) {
        await page.evaluate(angle=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().setState({angle}),angle);
        for(const [key,x,y] of [['t',.5,.125],['b',.5,.875],['h',.125,.5],['l',.875,.5],['z',.5,.5]]) {
            const before=await state();
            await page.keyboard.press('z');await page.keyboard.press(key);await settle();
            const p=await page.evaluate(()=>{
                const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
                return {point:v.sigma.graphToViewport(v.graph.getNodeAttributes(v.navigation.caret)),dims:v.sigma.getDimensions()};
            });
            assert.ok(Math.hypot(p.point.x-p.dims.width*x,p.point.y-p.dims.height*y)<.1,`z${key} places the caret at its viewport fraction`);
            const after=await state();assert.equal(after.camera.ratio,before.camera.ratio);assert.equal(after.camera.angle,angle);
            assert.deepEqual(after.selected,before.selected);assert.equal(after.caret,before.caret);
        }
    }
    await page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().setState({angle:0}));
    await checkCaretPicker(page, keys);
    await settle();
    // Hints reach selected and dimmed nodes, preserving highlights unless a final modifier edits them.
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.sigma.setCustomBBox({x:[-100,720],y:[-100,440]});
        v.sigma.refresh();v.sigma.getCamera().setState({x:.5,y:.5,ratio:1.5,angle:0});
    });
    const hints=async()=>{
        await page.keyboard.press(',');await page.keyboard.press('f');
        await page.waitForSelector('.graph-node-hint');
        return page.evaluate(()=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).nodeHints);
    };
    let codes=await hints();assert.equal(codes.length,4);
    assert.ok(codes.every(h=>keys.includes(h.key)),'Hidden nodes have no hints');
    const beforeHints=(await state()).selected;
    await page.keyboard.type(codes.find(h=>h.key===keys[3]).label);await settle();
    assert.equal((await state()).caret,keys[3]);assert.deepEqual((await state()).selected,beforeHints);
    codes=await hints();let target=codes.find(h=>h.key===keys[3]);
    await page.keyboard.type(target.label.slice(0,-1));await page.keyboard.press('Shift+'+target.label.at(-1));await settle();
    assert.ok((await state()).selected.includes(keys[3]));
    codes=await hints();target=codes.find(h=>h.key===keys[3]);
    await page.keyboard.type(target.label.slice(0,-1));await page.keyboard.press('Alt+'+target.label.at(-1));await settle();
    assert.deepEqual((await state()).selected,beforeHints);
    await hints();await page.screenshot({path:join(tmpdir(),`studio-hints-${label.replaceAll(' ','-')}.png`)});
    await page.keyboard.press('Escape');assert.equal(await page.locator('.graph-node-hint').count(),0);assert.deepEqual((await state()).selected,beforeHints);
    await page.keyboard.press('Control+[');
    assert.equal((await state()).mode,'normal');assert.equal((await state()).active,false);assert.equal((await state()).inspected,null);
    await page.keyboard.press('l');assert.equal((await state()).mode,'normal');
    await page.keyboard.press('Space');
    await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).leaderPending);
    await page.keyboard.press('l');assert.equal((await state()).mode,'normal');
    await page.keyboard.press('Space');await page.keyboard.press('d');assert.equal((await state()).order,(await page.evaluate(()=>window.navigationBefore.nodes.length)));
    // Real text focus suppresses every new mapping, including the Ctrl allowlist.
    await page.keyboard.press('/');
    await page.locator('input[aria-label="Find node"]').fill('');
    const beforeInput=await state();
    await page.keyboard.type('cvdhjklnoy. +-');await page.keyboard.press('Control+e');await page.keyboard.press('Control+[');
    assert.equal(await page.locator('input[aria-label="Find node"]').inputValue(),'cvdhjklnoy. +-');
    assert.deepEqual((await state()).camera,beforeInput.camera);assert.equal((await state()).mode,'normal');
    await page.locator('input[aria-label="Find node"]').fill('');
    await page.evaluate(()=>{document.activeElement?.blur();const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;v.interactionHandler.inspectKeyboardNode(v.graph.nodes()[0]);});
    await page.keyboard.press('c');await settle();
    const unselectedOrder=(await state()).order;await page.keyboard.press('d');
    assert.equal((await state()).order,unselectedOrder,'The first d only arms deletion');
    await page.keyboard.press('Enter');assert.equal((await state()).order,unselectedOrder,'d Enter cannot remove a merely inspected node');
    await page.evaluate(keys=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.elementSelection.replace(keys.slice(0,2)),keys);
    // Deleting during an unfinished focus animation must stop at its current
    // camera state rather than drifting to the removed nodes afterward.
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser,remove=v.removeSelectedFromGraph.bind(v);
        v.removeSelectedFromGraph=()=>{window.cameraAtRemoval=v.sigma.getCamera().getState();v.removeSelectedFromGraph=remove;return remove();};
    });
    await page.keyboard.press('Enter');
    const beforeDelete=await state();
    await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'d',repeat:true,bubbles:true,cancelable:true})));
    assert.equal((await state()).order,beforeDelete.order,'Holding d cannot delete more nodes');
    await page.keyboard.press('d');await page.keyboard.press('Enter');
    assert.equal((await state()).order,beforeDelete.order-2);assert.equal((await state()).mode,'caret');
    const removalCamera=await page.evaluate(()=>window.cameraAtRemoval);
    assert.deepEqual((await state()).camera,removalCamera,'Removal preserves the camera');
    await settle();
    assert.deepEqual((await state()).camera,removalCamera,'No old animation survives removal');
    assert.equal(await page.evaluate(keys=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        return keys.every(key=>!v.graph.hasNode(key))&&v.hasWorkingContext;
    },beforeDelete.selected),true);
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        const snap=v.captureSnap('navigation fixture',false);
        if(snap.graph.attributes.navigation) throw new Error('Gesture state leaked into snap');
        if(snap.graph.attributes.elementSelection.nodes.length!==0) throw new Error('Snap lost shared selection');
        v.restoreContext();
    });
    assert.equal((await state()).order,beforeDelete.order);
    await checkCaretDeletion(page,keys,state,settle);
    // Restore original positions/visibility so subsequent lifecycle checks use
    // the original result. Selection is cleared by the real Escape handler.
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        for(const node of window.navigationBefore.nodes) v.graph.replaceNodeAttributes(node.key,node.attributes);
        v.graph.clearEdges();v.graph.import({edges:window.navigationBefore.edges});
        v.sigma.refresh();
    });
    await page.keyboard.press('Escape');
    assert.equal((await state()).caret,null);
    console.log(`PASS ${label}: node-bound row/column progression, all three screenshot regressions, connected diagonal motions and modifiers, Ctrl-o visit history, independent caret/highlights, Shift nudges, Ctrl-Shift/Option motions and Shift/Option clicks, hints, zz, caret picker, inspector, body fit, anchored zoom, Ctrl pan/reset, dd caret and d Enter selection deletion, prefix cancellation/timeout/repeat protection, context restore and transient modes`);
}

async function checkNudges(page, settle) {
    const read=()=>page.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        return {caret:v.navigation.caret,history:[...v.navigation.history],selection:[...v.elementSelection.nodes],
            camera:v.sigma.getCamera().getState(),running:v.isLayoutRunning,
            points:v.graph.nodes().map(key=>({key,...v.sigma.graphToViewport(v.graph.getNodeAttributes(key))})),
            positions:v.graph.nodes().map(key=>({key,x:v.graph.getNodeAttribute(key,'x'),y:v.graph.getNodeAttribute(key,'y')}))};
    });
    const original=await read();
    for(const angle of [0,.55]) for(const ratio of [.7,1.5]) {
        await page.evaluate(({angle,ratio})=>{const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;v.sigma.getCamera().setState({angle,ratio});v.sigma.refresh();},{angle,ratio});
        await settle();
        for(const [key,dx,dy,opposite] of [['h',-1,0,'l'],['j',0,1,'k'],['k',0,-1,'j'],['l',1,0,'h'],
            ['n',-Math.SQRT1_2,Math.SQRT1_2,'o'],['o',Math.SQRT1_2,-Math.SQRT1_2,'n'],
            ['y',-Math.SQRT1_2,-Math.SQRT1_2,'.'],['.',Math.SQRT1_2,Math.SQRT1_2,'y']]) {
            const before=await read();await page.keyboard.press(`Shift+${key}`);await settle();const after=await read();
            for(const field of ['caret','history','selection','camera']) assert.deepEqual(after[field],before[field],`Nudge preserves ${field}`);
            assert.equal(after.running,false);
            const p=before.points.find(p=>p.key===before.caret),q=after.points.find(p=>p.key===before.caret);
            assert.ok(Math.hypot(q.x-p.x-dx*5,q.y-p.y-dy*5)<.01,`Shift-${key} moves five screen pixels at ratio ${ratio}, angle ${angle}`);
            assert.deepEqual(after.positions.filter(p=>p.key!==before.caret),before.positions.filter(p=>p.key!==before.caret),'Only the caret node moves');
            await page.keyboard.press(`Shift+${opposite}`);await settle();
        }
    }
    await page.evaluate(original=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        for(const {key,x,y} of original.positions) v.graph.mergeNodeAttributes(key,{x,y});
        const p=original.positions.find(p=>p.key===original.caret);v.layout.pinNode?.(p.key,p.x,p.y);
        v.sigma.getCamera().setState(original.camera);v.sigma.refresh();
    },original);
    await settle();
}

async function checkSpatialNavigation(page,keys,state,settle,click) {
    // Recreate the supplied screenshot's centres and its motivation connections.
    await page.evaluate(keys=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        window.spatialBefore={nodes:keys.map(key=>({key,attributes:structuredClone(v.graph.getNodeAttributes(key))})),
            edges:v.graph.export().edges,bbox:v.sigma.getCustomBBox(),camera:v.sigma.getCamera().getState()};
        for(const [index,[label,x,y]] of [['evidence',215,-546],['take-includes',202,-352],['goal',118,-179],['motivation',627,-80]].entries())
            v.graph.mergeNodeAttributes(keys[index],{x,y,label});
        v.graph.clearEdges();
        for(const index of [0,1,2]) v.graph.addEdge(keys[3],keys[index],{type:'line',size:1,color:'#999999',metadata:{}});
        v.sigma.setCustomBBox({x:[0,894],y:[-650,0]});v.sigma.refresh();
        v.sigma.getCamera().setState({x:.5,y:.5,ratio:1.5,angle:0});
        v.endNavigation();v.pointCaret(keys[3]);v.elementSelection.replace([keys[2]]);
    },keys);
    const selected=(await state()).selected;
    for(const [key,index] of [['j',0],['k',1],['k',2]]) {
        await page.keyboard.press(key);await settle();
        assert.equal((await state()).caret,keys[index],`Screenshot: ${key} follows the visible layout`);
        assert.equal((await state()).inspected,keys[index]);assert.deepEqual((await state()).selected,selected);
    }
    await page.keyboard.press('Control+o');await settle();assert.equal((await state()).caret,keys[1]);
    await page.keyboard.press('l');await settle();assert.equal((await state()).caret,keys[3],'l from take-includes reaches motivation');
    for(const index of [1,0,3]) {
        await page.keyboard.press('Control+o');await settle();
        assert.equal((await state()).caret,keys[index]);assert.deepEqual((await state()).selected,selected);
    }
    const exhausted=await state(),url=page.url();
    await page.keyboard.press('Control+o');assert.deepEqual(await state(),exhausted);assert.equal(page.url(),url);
    await click(keys[2]);assert.equal((await state()).caret,keys[2]);
    await page.keyboard.press('Control+o');await settle();
    assert.equal((await state()).caret,keys[3],'g; returns from a pointer jump');
    assert.deepEqual((await state()).selected,selected);
    await checkWideSpatialNavigation(page,keys,state,settle);
    await checkDiagonalNavigation(page,keys,state,settle);
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser,b=window.spatialBefore;
        for(const node of b.nodes) v.graph.replaceNodeAttributes(node.key,node.attributes);
        v.graph.clearEdges();v.graph.import({edges:b.edges});v.sigma.setCustomBBox(b.bbox);v.sigma.refresh();
        v.sigma.getCamera().setState(b.camera);v.endNavigation();v.elementSelection.clear();
    });
}

async function checkWideSpatialNavigation(page,keys,state,settle) {
    const extra=await page.evaluate(keys=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.endNavigation();v.graph.clearEdges();
        const extra=[];
        for(let i=0;extra.length<3;i++) {
            const key=`__wide-navigation-${i}`;
            if(v.graph.hasNode(key)) continue;
            v.graph.addNode(key,structuredClone(v.graph.getNodeAttributes(keys[0])));extra.push(key);
        }
        const all=[...keys,...extra];
        const rows=[['Fear',563,130,117,44,'rounded-rect'],['tension',373,484,121,55,'diamond'],
            ['motivation: craving',620,550,166,62,'diamond'],['goal',273,618,96,35,'ellipse'],
            ['motivation: avoidance',190,376,155,62,'diamond'],['take-includes',79,604,79,55,'diamond'],
            ['mental-state',870,369,155,44,'rounded-rect']];
        for(const [index,[label,x,y,width,height,type]] of rows.entries())
            v.graph.mergeNodeAttributes(all[index],{x,y:-y,width,height,type,label,size:Math.max(width,height),viewHidden:false});
        for(const [a,b] of [[0,1],[0,4],[1,6],[2,6],[2,3],[3,4],[4,5]])
            v.graph.addEdge(all[a],all[b],{type:'line',size:1,color:'#999999',metadata:{}});
        v.sigma.setCustomBBox({x:[0,1050],y:[-700,0]});v.sigma.refresh();
        v.sigma.getCamera().setState({x:.5,y:.5,ratio:1.5,angle:0});v.sigma.refresh();
        // Match screenshot body extents as well as centres at this viewport size.
        const a=v.sigma.graphToViewport({x:0,y:0}),b=v.sigma.graphToViewport({x:1,y:0});
        const scale=Math.hypot(b.x-a.x,b.y-a.y)/v.sigma.scaleSize(1);
        for(const key of all) {
            const a=v.graph.getNodeAttributes(key);
            v.graph.mergeNodeAttributes(key,{width:a.width*scale,height:a.height*scale,size:a.size*scale});
        }
        v.sigma.refresh();v.pointCaret(keys[0]);v.elementSelection.replace([keys[3]]);
        return extra;
    },keys);
    for(const index of [1,2,3]) {
        await page.keyboard.press('j');await settle();
        assert.equal((await state()).caret,keys[index],'Wide-node screenshot: j advances Fear → tension → motivation → goal');
        assert.deepEqual((await state()).selected,[keys[3]]);
    }
    await page.screenshot({path:join(tmpdir(),'studio-wide-node-navigation.png')});
    for(const index of [2,1,0]) {
        await page.keyboard.press('Control+o');await settle();assert.equal((await state()).caret,keys[index]);
    }
    await page.evaluate(extra=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        for(const key of extra) v.graph.dropNode(key);
    },extra);
}

async function checkDiagonalNavigation(page,keys,state,settle) {
    const extra=await page.evaluate(keys=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.endNavigation();v.graph.clearEdges();
        const extra=[];
        for(let i=0;extra.length<7;i++) {
            const key=`__diagonal-navigation-${i}`;
            if(v.graph.hasNode(key)) continue;
            v.graph.addNode(key,structuredClone(v.graph.getNodeAttributes(keys[0])));extra.push(key);
        }
        const all=[...keys,...extra];
        const rows=[['stages',481,383,87,60,'diamond'],['depiction: Conflict stage',165,653,112,60,'rounded-rect'],
            ['scene: Approach-avoidance, held',824,154,111,102,'rounded-rect'],['depiction-slot',118,191,87,60,'diamond'],
            ['depiction-slot',695,735,86,60,'diamond'],['left',280,383,40,25,'ellipse'],['right',700,383,40,25,'ellipse'],
            ['above',481,190,40,25,'ellipse'],['below',481,580,40,25,'ellipse'],
            ['near down-left',350,510,25,20,'ellipse'],['near up-right',620,250,25,20,'ellipse']];
        for(const [index,[label,x,y,width,height,type]] of rows.entries())
            v.graph.mergeNodeAttributes(all[index],{x,y:-y,width,height,type,label,size:Math.max(width,height),viewHidden:index>=5});
        for(const [a,b] of [[0,1],[0,2],[1,3],[1,4]])
            v.graph.addEdge(all[a],all[b],{type:'line',size:1,color:'#999999',metadata:{}});
        v.sigma.setCustomBBox({x:[0,1056],y:[-828,0]});v.sigma.refresh();
        v.sigma.getCamera().setState({x:.5,y:.5,ratio:1.5,angle:0});v.sigma.refresh();
        const a=v.sigma.graphToViewport({x:0,y:0}),b=v.sigma.graphToViewport({x:1,y:0});
        const scale=Math.hypot(b.x-a.x,b.y-a.y)/v.sigma.scaleSize(1);
        for(const key of all) {
            const a=v.graph.getNodeAttributes(key);
            v.graph.mergeNodeAttributes(key,{width:a.width*scale,height:a.height*scale,size:a.size*scale});
        }
        v.sigma.refresh();v.pointCaret(keys[0]);v.elementSelection.replace([keys[0]]);
        return extra;
    },keys);
    await settle();await page.screenshot({path:join(tmpdir(),'studio-diagonal-navigation.png')});
    for(const [key,index] of [['h',1],['l',2]]) {
        await page.keyboard.press(key);await settle();assert.equal((await state()).caret,keys[index]);
        await page.keyboard.press('Control+o');await settle();assert.equal((await state()).caret,keys[0]);
    }
    const all=[...keys,...extra];
    await page.evaluate(all=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        for(const key of all) v.graph.setNodeAttribute(key,'viewHidden',false);
        v.sigma.refresh();
    },all);
    for(const [key,index] of [['h',5],['l',6],['k',7],['j',8],['n',1],['o',2],['y',3],['Period',4]]) {
        await page.keyboard.press(key);await settle();
        assert.equal((await state()).caret,all[index],`Stages: ${key} reaches its target despite competing layout nodes`);
        assert.equal((await state()).inspected,all[index]);assert.deepEqual((await state()).selected,[keys[0]]);
        await page.keyboard.press('Control+o');await settle();assert.equal((await state()).caret,keys[0]);
    }
    for(const [key,code,option,index] of [['n','KeyN','Dead',1],['o','KeyO','ø',2],['y','KeyY','¥',3],['Period','Period','≥',4]]) {
        await page.keyboard.press('Control+Shift+'+key);await settle();
        assert.equal((await state()).caret,all[index]);assert.deepEqual((await state()).selected,[keys[0],all[index]]);
        await page.keyboard.press('Control+o');await settle();
        // Native macOS Option characters, including dead-key Option-n and ≥.
        await page.evaluate(({key,code})=>window.dispatchEvent(new KeyboardEvent('keydown',{key,code,altKey:true,bubbles:true,cancelable:true})),{key:option,code});
        await settle();assert.equal((await state()).caret,all[index]);assert.deepEqual((await state()).selected,[keys[0]]);
        await page.keyboard.press('Control+o');await settle();
    }
    await page.evaluate(key=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.graph.setNodeAttribute(key,'viewHidden',true);v.sigma.refresh();
    },keys[1]);
    await page.keyboard.press('n');await settle();
    assert.equal((await state()).caret,all[9],'A hidden diagonal neighbour yields to the available layout target');
    await page.keyboard.press('/');const input=page.getByRole('combobox',{name:'Find node',exact:true});
    await input.fill('');await page.keyboard.type('noy.NOY>');
    assert.equal(await input.inputValue(),'noy.NOY>');assert.equal((await state()).caret,all[9],'Diagonal keys remain text in the picker');
    await page.keyboard.press('Escape');
    await page.evaluate(extra=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        v.endNavigation();for(const key of extra) v.graph.dropNode(key);
    },extra);
}

async function checkCaretDeletion(page,keys,state,settle) {
    await page.evaluate(keys=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        v.pointCaret(keys[0]);v.elementSelection.replace(keys.slice(1,3));window.ng.applyChanges(c);
    },keys);
    const before=await state();
    await page.keyboard.press('d');await page.keyboard.press('Escape');
    assert.deepEqual(await state(),before,'Escape cancels the delete prefix without clearing the caret or selection');
    await page.keyboard.press('d');await page.keyboard.press('Control+[');
    assert.deepEqual(await state(),before);
    await page.keyboard.press('d');
    await page.evaluate(key=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.pointCaret(key),keys[2]);
    await page.keyboard.press('d');
    assert.equal((await state()).order,before.order,'An external caret change cannot redirect a pending dd');
    assert.equal((await state()).leader,null);
    await page.evaluate(key=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.pointCaret(key),keys[0]);
    await page.keyboard.press('d');
    await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).leaderPending);
    assert.deepEqual(await state(),before,'A timed-out d never deletes');
    await page.keyboard.press('d');
    await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'d',repeat:true,bubbles:true,cancelable:true})));
    assert.equal((await state()).order,before.order,'Holding d cannot complete dd');
    await page.keyboard.press('d');await settle();
    const after=await state();
    assert.equal(after.order,before.order-1);assert.deepEqual(after.selected,before.selected,'dd preserves other highlighted nodes');
    assert.deepEqual(after.camera,before.camera);assert.equal(after.caret,keys[1],'Caret continues on a surviving direct neighbour');
    await page.evaluate(()=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        const context=v.graph.getAttribute('workingContext');
        for(const node of context.nodes) if(v.graph.hasNode(node.key)) {
            const a=v.graph.getNodeAttributes(node.key);
            if(a.x!==node.attributes.x||a.y!==node.attributes.y) throw new Error('dd moved a surviving node');
        }
    });
    await page.evaluate(key=>{
        const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        if(v.graph.hasNode(key)||!v.hasWorkingContext) throw new Error('dd did not remove exactly its node into restorable context');
        v.restoreContext();
    },keys[0]);
    assert.equal((await state()).order,before.order);
    await page.keyboard.press('Control+[');const normal=await state();
    await page.keyboard.press('d');await page.keyboard.press('d');
    assert.deepEqual(await state(),normal,'dd without a caret is a no-op');
}

async function checkCaretPicker(page, keys) {
    const input=page.getByRole('combobox',{name:'Find node',exact:true});
    const read=()=>page.evaluate(()=>{
        const c=window.ng.getComponent(document.querySelector('ts-graph-canvas')),v=c.visualiser;
        return {caret:v.navigation.caret,selection:v.graph.getAttribute("elementSelection"),highlighted:v.highlightedNodeKeys(),camera:v.sigma.getCamera().getState(),
            index:c.finderIndex,rows:c.finderResults.map(e=>({key:e.nodes[0],label:e.label})),open:c.finderOpen};
    });
    // Test with and without an explicit selection; neither typing nor clearing
    // nor suggestion navigation should change graph highlighting/inspection.
    for(const explicit of [true,false]) {
        await page.evaluate(({keys,explicit})=>{
            const v=window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
            if(explicit) v.elementSelection.replace([keys[0]]);else v.elementSelection.clear();
        },{keys,explicit});
        const before=await read();
        await page.keyboard.press('/');await input.fill('');
        assert.equal(await page.locator('.finder-options input[type=checkbox]').count(),0);
        const rows=(await read()).rows;assert.equal(rows.length,4,'One suggestion per visible node, no type groups or hidden nodes');
        await page.keyboard.press('Control+n');assert.equal((await read()).index,1);
        await page.keyboard.press('Control+p');assert.equal((await read()).index,0);
        await page.keyboard.press('Control+p');assert.equal((await read()).index,3,'Suggestions wrap backwards');
        assert.equal(await input.evaluate(el=>el===document.activeElement),true,'Input retains typing focus');
        assert.deepEqual((await read()).selection,before.selection);assert.deepEqual((await read()).highlighted,before.highlighted);
        assert.equal((await read()).caret,before.caret,'Suggestion browsing does not move the graph caret');
        await page.keyboard.press('Enter');
        await page.waitForFunction(()=>!window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.sigma.getCamera().isAnimated());
        assert.equal((await read()).caret,rows[3].key);assert.equal((await read()).open,false);
        assert.deepEqual((await read()).selection,before.selection);assert.deepEqual((await read()).highlighted,before.highlighted);
        assert.equal(await input.evaluate(el=>el===document.activeElement),false,'Enter returns graph keyboard control');
        const accepted=await read();
        await page.keyboard.press('/');await input.fill('no-node-matches-this-string');
        assert.equal((await read()).rows.length,0);
        await page.keyboard.press('Enter');assert.equal((await read()).caret,accepted.caret);
        await page.getByRole('button',{name:'Clear node search'}).click();assert.equal((await read()).rows.length,4);
        assert.deepEqual((await read()).selection,accepted.selection);
        await page.keyboard.press(explicit?'Escape':'Control+[');assert.equal((await read()).open,false);assert.equal((await read()).caret,accepted.caret);
    }
    // Acceptance by click is the same operation as Enter.
    await page.keyboard.press('/');await input.fill('');
    const rows=(await read()).rows, beforeClickCaret=(await read()).caret;
    await page.keyboard.press('ArrowDown');assert.equal((await read()).index,1);
    await page.keyboard.press('ArrowUp');assert.equal((await read()).index,0);
    await page.getByRole('option').first().click();
    assert.equal((await read()).caret,rows[0].key);assert.equal((await read()).selection.active,false);
    await page.keyboard.press('Control+o');
    assert.equal((await read()).caret,beforeClickCaret,'g; returns from a search result');
    assert.equal((await read()).selection.active,false);
    await page.evaluate(keys=>window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser.elementSelection.replace(keys.slice(0,2)),keys);
    await page.keyboard.press('/');await input.fill('');
    await page.screenshot({path:join(tmpdir(),'studio-caret-picker.png')});
    await page.keyboard.press('Escape');
}
