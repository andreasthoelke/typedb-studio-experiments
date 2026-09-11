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
