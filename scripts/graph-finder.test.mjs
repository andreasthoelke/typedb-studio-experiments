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

test('Shift-click neighborhoods preserve overlap and the previously inspected group', () => {
 const selection = new GraphElementSelection();
 selection.toggleNeighborhood('b', ['shared','b1'], ['a',['a','shared','a1']]);
 assert.deepEqual([...selection.nodes].sort(), ['a','a1','b','b1','shared']);
 selection.toggleNeighborhood('a', ['shared','a1']);
 assert.deepEqual([...selection.nodes].sort(), ['b','b1','shared']);
 selection.toggleNeighborhood('b', ['shared','b1']);
 assert.equal(selection.nodes.size, 0);
 assert.equal(selection.active, true, 'deselecting every group selects None; Clear restores ordinary highlighting');
});

test('neighborhood groups survive snaps and preserve independently selected nodes', () => {
 let saved;
 const selection = new GraphElementSelection(undefined, value => saved = value);
 selection.set(['shared','independent'], true);
 selection.toggleNeighborhood('a', ['shared']);
 const restored = new GraphElementSelection(JSON.parse(JSON.stringify(saved)));
 restored.toggleNeighborhood('a', ['shared']);
 assert.deepEqual([...restored.nodes].sort(), ['independent','shared']);
 assert.deepEqual([...selection.nodes].sort(), ['a','independent','shared']);
 restored.set(['a'], true); // Finder/type chips establish a new base.
 restored.toggleNeighborhood('a', ['neighbor']);
 restored.toggleNeighborhood('a', ['neighbor']);
 assert.deepEqual([...restored.nodes].sort(), ['a','independent','shared']);
 restored.clear();
 restored.toggleNeighborhood('z', []);
 assert.deepEqual([...restored.nodes], ['z']);
});


test('exact node edits override original and overlapping neighborhoods, including after a snap', () => {
 let saved;
 const selection = new GraphElementSelection(undefined, state => saved = state);
 selection.toggleSingle('title', ['scene', 'title']);
 assert.deepEqual([...selection.nodes], ['scene'], 'can subtract from ordinary inspection');
 selection.toggleNeighborhood('depiction', ['title', 'scene']);
 assert.equal(selection.nodes.has('title'), false, 'a later group cannot undo the exact exclusion');
 selection.toggleSingle('scene');
 assert.equal(selection.nodes.has('scene'), false, 'can subtract an original base node shared by a group');
 const restored = new GraphElementSelection(JSON.parse(JSON.stringify(saved)));
 restored.toggleNeighborhood('slot', ['scene', 'title']);
 assert.deepEqual([...restored.nodes].sort(), ['depiction', 'slot']);
 restored.toggleSingle('title');
 assert.equal(restored.nodes.has('title'), true, 'exact toggle re-adds just that node');
 restored.toggleSingle('title');
 assert.equal(restored.nodes.has('title'), false);
 restored.replace(['title']);
 assert.deepEqual([...restored.nodes], ['title'], 'All/None/type/finder edits deliberately establish a new selection');
});


test('new Explorer nodes join an active selection without discarding exclusions or groups', () => {
 const selection=new GraphElementSelection();
 selection.toggleNeighborhood('scene',['title']);selection.toggleSingle('title');
 selection.includeAddedNodes(['depiction']);
 assert.deepEqual([...selection.nodes].sort(),['depiction','scene']);
 selection.toggleNeighborhood('scene',['title']);
 assert.deepEqual([...selection.nodes],['depiction']);
 selection.toggleNeighborhood('slot',['title']);
 assert.equal(selection.nodes.has('title'),false);
 selection.clear();selection.includeAddedNodes(['title']);
 assert.equal(selection.active,false,'ordinary inspection continues to handle expansion highlighting');
});
