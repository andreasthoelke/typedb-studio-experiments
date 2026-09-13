import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const file = new URL('../src/framework/util/graph-snap.ts', import.meta.url);
const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace('"./graph-presets"', JSON.stringify(new URL('../src/framework/util/graph-presets.ts', import.meta.url).href));
const { parseGraphSnap } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const snap = () => ({
 format:'typedb-studio-graph-snap',version:1,createdAt:'2026-09-12T00:00:00Z',query:'captured query',expansionQueries:['expansion'],schemaMode:false,
 graph:{attributes:{elementSelection:{active:true,nodes:['n']}},nodes:[{key:'n',attributes:{x:12,y:-2,size:40,width:40,height:30,type:'ellipse',label:'saved label',color:'#ffffff',borderColor:'#112233',metadata:{concept:{kind:'entity'},defaultLabel:'label',hoverLabel:'label'}}}],edges:[]},
 style:{name:'Snapshot',description:'',kindStyles:{},typeStyles:{},edgeLabelColors:{},colorEdgesByConstraint:false,labelsVisible:true,showHoverLabel:true,degreeScaling:false,background:{type:'solid',color1:'#ffffff',color2:'#000000',gradientAngle:0}},
 view:{camera:{x:.4,y:.6,ratio:.8,angle:0},bbox:{x:[0,100],y:[0,100]},viewport:{width:800,height:600},searchTerm:'',finderMatches:null,selectedNode:null,selectedNeighbors:[],highlightedEdges:[],highlightedTypes:[],highlightedKinds:[]},
 labels:{attributes:[['iid',[['title',['saved title']]]]],overrides:[['thing','title']]},
});
test('snaps preserve expanded graph, labels, geometry and explicit selection through JSON',()=>{
 const original=snap();assert.deepEqual(parseGraphSnap(JSON.stringify(original)),original);
});
test('invalid or future snaps are rejected before rendering',()=>{
 for(const change of [s=>s.version=2,s=>s.graph.nodes[0].attributes.x=null,s=>s.view.camera.ratio=0,
  s=>s.graph.nodes.push(structuredClone(s.graph.nodes[0])),s=>s.graph.attributes.elementSelection.nodes=['missing'],
  s=>s.graph.edges=[{key:'e',source:'n',target:'missing',attributes:{type:'line',color:'#000000',size:1}}],
  s=>s.style.background.color1='bad',s=>s.labels.attributes=[['id','bad']],s=>s.view.finderMatches=['missing']]) {
  const value=snap();change(value);assert.throws(()=>parseGraphSnap(JSON.stringify(value)));
 }
 assert.throws(()=>parseGraphSnap('{"__proto__":{}}'));
});


import { MultiGraph } from 'graphology';
import { rememberWorkingContext, restoreWorkingContext } from '../src/framework/util/graph-working-context.ts';

test('working subsets restore topology and original positions, preserve additions and do not nest', () => {
 const graph = new MultiGraph();
 const original = snap();
 graph.import(original.graph);
 graph.addNode('title', {...structuredClone(original.graph.nodes[0].attributes), x:100});
 graph.addEdgeWithKey('owns', 'n', 'title', {type:'line', color:'#112233', size:1});
 rememberWorkingContext(graph, original.view);
 graph.dropNode('title');
 graph.setNodeAttribute('n', 'x', 800);
 graph.addNode('new', {...structuredClone(original.graph.nodes[0].attributes), x:500});
 graph.addEdgeWithKey('new-edge', 'n', 'new', {type:'line', color:'#112233', size:1});
 rememberWorkingContext(graph, {...original.view, camera:{...original.view.camera, ratio:4}});
 assert.equal(graph.getAttribute('workingContext').nodes.length, 2, 'repeated reductions keep one original context');
 const reduced = {...original, graph:graph.export()};
 const restored = new MultiGraph();
 restored.import(parseGraphSnap(JSON.stringify(reduced)).graph);
 assert.equal(restored.hasNode('title'), false, 'excluded nodes are not in the graph used by the force layout');
 const context = restoreWorkingContext(restored);
 assert.deepEqual(context.camera, original.view.camera);
 assert.equal(restored.getNodeAttribute('n','x'),12);
 assert.equal(restored.getNodeAttribute('new','x'),500);
 assert.deepEqual(restored.edges().sort(),['new-edge','owns']);
 assert.equal(restored.hasAttribute('workingContext'),false);
 assert.equal(graph.hasNode('title'),false,'restoration must not mutate its source snap');
});

test('invalid parked context is rejected before it can later enter the renderer', () => {
 const value=snap();
 value.graph.attributes.workingContext={nodes:structuredClone(value.graph.nodes),edges:[],camera:value.view.camera,bbox:value.view.bbox};
 value.graph.attributes.workingContext.nodes[0].attributes.x=null;
 assert.throws(()=>parseGraphSnap(JSON.stringify(value)));
});
