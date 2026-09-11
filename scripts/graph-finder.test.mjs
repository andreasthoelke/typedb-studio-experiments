import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzyGraphMatches } from '../src/framework/util/graph-finder.ts';
const entries=['motivation','mental-state','scene-take','Café: S1 title'].map(label=>({id:label,label,text:label,detail:'type',nodes:[label]}));
test('finder supports ordered fuzzy letters, values, whitespace and accents',()=>{
 assert.deepEqual(fuzzyGraphMatches(entries,'sc tk').map(e=>e.label),['scene-take']);
 assert.deepEqual(fuzzyGraphMatches(entries,'s1').map(e=>e.label),['Café: S1 title']);
 assert.deepEqual(fuzzyGraphMatches(entries,'cafe').map(e=>e.label),['Café: S1 title']);
 assert.deepEqual(fuzzyGraphMatches(entries,'zz'),[]);
 assert.equal(fuzzyGraphMatches(entries,'').length,4);
});

import { GraphElementSelection } from '../src/framework/util/graph-element-selection.ts';

test('node, type and kind controls share one set, including partial groups', () => {
 const selection = new GraphElementSelection();
 const motivation = ['m1', 'm2'];
 selection.toggle(['m1']);
 assert.equal(selection.status(motivation), 'partial');
 selection.toggle(motivation);
 assert.equal(selection.status(motivation), 'all');
 selection.toggle(['m2']);
 assert.equal(selection.status(motivation), 'partial');
 selection.set(motivation, false);
 assert.equal(selection.status(motivation), 'none');
 assert.equal(selection.active, true);
});

test('All then exclude and None then include use the same selection', () => {
 const selection = new GraphElementSelection();
 selection.replace(['m1', 'm2', 'goal']);
 selection.toggle(['m1', 'm2']);
 assert.deepEqual([...selection.nodes], ['goal']);
 selection.replace([]);
 assert.equal(selection.active, true, 'None explicitly selects no nodes');
 selection.toggle(['m1']);
 assert.deepEqual([...selection.nodes], ['m1']);
 selection.clear();
 assert.equal(selection.active, false, 'Clear restores normal highlighting');
 assert.equal(selection.nodes.size, 0);
});

test('selection snapshots survive renderer remounts without sharing mutable state', () => {
 let saved;
 const selection = new GraphElementSelection(undefined, state => saved = state);
 selection.toggle(['m1']);
 const restored = new GraphElementSelection(JSON.parse(JSON.stringify(saved)));
 assert.equal(restored.active, true);
 assert.deepEqual([...restored.nodes], ['m1']);
 restored.toggle(['m2']);
 assert.deepEqual([...selection.nodes], ['m1']);
 assert.deepEqual(saved.nodes, ['m1']);
 assert.equal(new GraphElementSelection().active, false, 'new results start fresh');
 assert.equal(restored.status([]), 'none');
});
