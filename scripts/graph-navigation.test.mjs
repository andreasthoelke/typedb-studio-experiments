import test from 'node:test';
import assert from 'node:assert/strict';
import { directionalGraphNode, GraphNavigation, graphNodeHints, graphSelectionEdit } from '../src/framework/util/graph-navigation.ts';
const points = (...rows) => rows.map(([key,x,y]) => ({key,x,y}));
const bodies = (...rows) => rows.map(([key,x,y,halfWidth,halfHeight]) => ({key,x,y,halfWidth,halfHeight}));

test('directional navigation balances alignment/distance with deterministic half-plane fallback', () => {
    const uneven=points(['a',0,0],['b',30,8],['c',300,0],['d',2,-50],['left',-20,0]);
    assert.equal(directionalGraphNode(uneven,'a','right'),'b');
    assert.equal(directionalGraphNode(uneven,'a','up'),'d');
    assert.equal(directionalGraphNode(uneven,'a','left'),'left');
    assert.equal(directionalGraphNode(points(['a',0,0],['b',2,80]),'a','right'),'b');
    const tied=points(['a',0,0],['c',50,10],['b',50,-10],['invalid',Infinity,0],['same',0,0]);
    assert.equal(directionalGraphNode(tied,'a','right'),'b');
    assert.equal(directionalGraphNode([...tied].reverse(),'a','right'),'b');
    assert.equal(directionalGraphNode(tied,'a','left'),null);
    assert.equal(directionalGraphNode(tied,'missing','left'),null);
    assert.equal(directionalGraphNode(uneven.map(p=>({...p,x:p.x*2+80,y:p.y*2-90})),'a','right'),'b');
});

test('screen direction leads and connections are a bounded preference', () => {
    const g=points(['a',0,0],['near',100,0],['edge',120,0],['behind',-5,0],['diagonal',5,200]);
    assert.equal(directionalGraphNode(g,'a','right',new Set(['edge','behind'])),'edge','Comparable direct neighbours get a preference');
    assert.equal(directionalGraphNode(points(['a',0,0],['near',100,0],['edge',200,25]),'a','right',new Set(['edge'])),'edge','Connections outweigh a moderately closer layout node');
    assert.equal(directionalGraphNode(g,'a','right',new Set(['behind','missing'])),'near');
    assert.equal(directionalGraphNode(g,'a','right',new Set(['diagonal'])),'near','A mostly vertical connection is not preferred for right');
    assert.equal(directionalGraphNode(points(['a',0,0],['near',10,0],['edge',200,25]),'a','right',new Set(['edge'])),'near','A distant connection cannot monopolise a direction');
    assert.equal(directionalGraphNode(g,'a','left',new Set(['edge'])),'behind');
});

test('screenshot regression: k from evidence visits take-includes then goal, not the previous motivation', () => {
    // Centres measured from the supplied screenshot, in viewport pixels.
    const g=bodies(['evidence',215,546,80,55],['take-includes',202,352,79,55],['goal',118,179,97,35],['motivation',627,80,158,62]);
    const nav=new GraphNavigation();nav.enter('motivation');
    nav.move('down',g,new Set(['evidence','take-includes','goal']));assert.equal(nav.caret,'evidence');
    nav.move('up',g,new Set(['motivation']));assert.equal(nav.caret,'take-includes');
    nav.move('up',g,new Set(['motivation']));assert.equal(nav.caret,'goal');
    nav.back(g);assert.equal(nav.caret,'take-includes');
    nav.move('right',g,new Set(['motivation']));assert.equal(nav.caret,'motivation','l reaches the rightward connection');
    nav.back(g);assert.equal(nav.caret,'take-includes');
    nav.back(g);assert.equal(nav.caret,'evidence');
    nav.back(g);assert.equal(nav.caret,'motivation');
    assert.equal(nav.back(g),false,'History ends without wrapping');
});

test('wide-node screenshot: j progresses Fear → tension → motivation → goal', () => {
    const g=bodies(['fear',563,130,117,44],['avoidance',190,376,155,62],['tension',373,484,121,55],
        ['motivation',620,550,166,62],['goal',273,618,96,35],['take-includes',79,604,79,55],['other-state',870,369,155,44]);
    const links={fear:new Set(['avoidance','tension']),tension:new Set(['fear','other-state']),motivation:new Set(['goal','other-state'])};
    const nav=new GraphNavigation();nav.enter('fear');
    for(const destination of ['tension','motivation','goal']) {
        nav.move('down',g,links[nav.caret]);assert.equal(nav.caret,destination);
    }
    for(const destination of ['motivation','tension','fear']) {nav.back(g);assert.equal(nav.caret,destination);}
    // Body-based columns work equally as rows and are independent of pan/scale.
    for(const transform of [p=>p,p=>({...p,x:p.x*2+100,y:p.y*2-50,halfWidth:p.halfWidth*2,halfHeight:p.halfHeight*2})]) {
        const horizontal=g.map(transform).map(p=>({...p,x:p.y,y:p.x,halfWidth:p.halfHeight,halfHeight:p.halfWidth}));
        nav.enter('fear');
        for(const destination of ['tension','motivation','goal']) {
            nav.move('right',horizontal,links[nav.caret]);assert.equal(nav.caret,destination);
        }
    }
});

test('overlapping bodies advance by axis position before alignment or connectivity', () => {
    const g=bodies(['a',0,0,80,25],['next',100,60,80,25],['farther',0,100,80,25],['outside',300,10,40,25]);
    assert.equal(directionalGraphNode(g,'a','down',new Set(['farther','outside'])),'next');
    assert.equal(directionalGraphNode(g.filter(p=>p.key!=='next'),'a','down'),'farther');
    assert.equal(directionalGraphNode(g,'a','up'),null);
    assert.equal(directionalGraphNode([...g].reverse(),'a','down'),'next');
});

test('stages screenshot: diagonal motions reach depiction and scene despite surrounding rows and columns', () => {
    const g=bodies(['stages',481,383,87,60],['depiction',165,653,112,60],['scene',824,154,111,102],
        ['upper-slot',118,191,87,60],['lower-slot',695,735,86,60],
        // Additional row/column nodes reproduce four cardinal keys being occupied.
        ['left',280,383,40,25],['right',700,383,40,25],['above',481,190,40,25],['below',481,580,40,25],
        ['near down-left',350,510,25,20],['near up-right',620,250,25,20]);
    const links=new Set(['depiction','scene']);
    for(const direction of ['left','right','up','down']) {
        assert.equal(directionalGraphNode(g,'stages',direction,links),{up:'above',down:'below'}[direction]??direction);
    }
    for(const [direction,expected] of [['downLeft','depiction'],['upRight','scene'],['upLeft','upper-slot'],['downRight','lower-slot']]) {
        const nav=new GraphNavigation();nav.enter('stages');
        nav.move(direction,g,links);assert.equal(nav.caret,expected);
        nav.back(g);assert.equal(nav.caret,'stages');
        assert.equal(directionalGraphNode([...g].reverse(),'stages',direction,links),expected);
        assert.equal(directionalGraphNode(g.map(p=>({...p,x:p.x*2+100,y:p.y*2-50,halfWidth:p.halfWidth*2,halfHeight:p.halfHeight*2})),
            'stages',direction,links),expected);
    }
    // The two direct neighbours are also reachable by cardinal fallback when
    // the surrounding rows/columns are absent, as in the screenshot crop.
    assert.equal(directionalGraphNode(g.slice(0,5),'stages','left',links),'depiction');
    assert.equal(directionalGraphNode(g.slice(0,5),'stages','right',links),'scene');
});

test('diagonals prefer connections only in their quadrant and use layout when none is available', () => {
    for(const [direction,dx,dy] of [['downLeft',-1,1],['upRight',1,-1],['upLeft',-1,-1],['downRight',1,1]]) {
        const g=points(['a',0,0],['near',10*dx,10*dy],['edge',200*dx,250*dy],['axis',0,10*dy],['wrong',-20*dx,20*dy]);
        assert.equal(directionalGraphNode(g,'a',direction,new Set(['edge','axis','wrong'])),'edge');
        assert.equal(directionalGraphNode(g,'a',direction,new Set(['axis','wrong','missing'])),'near');
        assert.equal(directionalGraphNode(g.filter(p=>p.key!=='near'&&p.key!=='edge'),'a',direction,new Set(['axis','wrong'])),null);
        const tie=points(['a',0,0],['c',20*dx,30*dy],['b',30*dx,20*dy]);
        assert.equal(directionalGraphNode(tie,'a',direction,new Set(['b','c'])),'b');
        assert.equal(directionalGraphNode([...tie].reverse(),'a',direction,new Set(['b','c'])),'b');
    }
});

test('opposite motions use current geometry; back independently follows loops and branch history', () => {
    const g=points(['a',0,0],['b',100,0],['c',90,0],['d',100,100]);
    const nav=new GraphNavigation();nav.enter('a');
    nav.move('right',g,new Set(['b']));assert.equal(nav.caret,'b');
    nav.move('left',g);assert.equal(nav.caret,'c','Left no longer forcibly returns to a');
    nav.back(g);assert.equal(nav.caret,'b');
    nav.move('down',g);assert.equal(nav.caret,'d');
    nav.visit('a');nav.visit('a');
    nav.back(g);assert.equal(nav.caret,'d','Repeated clicks on the same node do not fill history');
    nav.back(g);assert.equal(nav.caret,'b');
    nav.back(g);assert.equal(nav.caret,'a','New motions after back replace the abandoned branch');
    assert.equal(nav.back(g),false);
    assert.equal('selected' in nav,false);
});

test('history skips hidden or removed entries, reaches offscreen visits and resets with navigation', () => {
    const g=points(['a',-5000,0],['b',100,0],['c',200,0],['d',300,0]);
    const nav=new GraphNavigation();nav.enter('a');nav.visit('b');nav.visit('c');nav.visit('d');
    nav.back(g.filter(p=>p.key!=='c'));assert.equal(nav.caret,'b');
    nav.back(g);assert.equal(nav.caret,'a');
    nav.back(g.filter(p=>p.key!=='a'));assert.equal(nav.mode,'normal');assert.equal(nav.caret,null);
    nav.enter('b');nav.visit('c');nav.reset();assert.equal(nav.back(g),false);
});

test('long navigation sessions keep the latest 256 visits', () => {
    const g=Array.from({length:300},(_,i)=>({key:String(i),x:i,y:0}));
    const nav=new GraphNavigation();nav.enter('0');
    for(let i=1;i<300;i++) nav.visit(String(i));
    let count=0;while(nav.back(g)) count++;
    assert.equal(count,256);assert.equal(nav.caret,'43');
});

test('hint labels are stable, prefix-free and cover crowded views', () => {
    for (const count of [0,1,49,50,343,344]) {
        const g=Array.from({length:count},(_,i)=>({key:String(i),x:i%7,y:Math.floor(i/7)}));
        const hints=graphNodeHints(g);
        assert.equal(hints.length,count);assert.equal(new Set(hints.map(h=>h.label)).size,count);
        assert.deepEqual(graphNodeHints([...g].reverse()),hints);
        assert.ok(hints.every(h=>h.label.length===(count<=49?2:count<=343?3:4)&&/^[asdhjkl]+$/.test(h.label)));
    }
});

test('selection intent is exact, and Option wins over Shift', () => {
    assert.equal(graphSelectionEdit({shiftKey:false,altKey:false}),'none');
    assert.equal(graphSelectionEdit({shiftKey:true,altKey:false}),'add');
    assert.equal(graphSelectionEdit({shiftKey:false,altKey:true}),'remove');
    assert.equal(graphSelectionEdit({shiftKey:true,altKey:true}),'remove');
});
