import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const file = new URL('../src/framework/util/schema-focus.ts', import.meta.url);
const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
 .replace('"./graph-query"', JSON.stringify(new URL('../src/framework/util/graph-query.ts', import.meta.url).href));
const { schemaFocus } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const attr = label => ({kind:'attributeType',label,subtypes:[]});
const owner = (label, roles=[]) => ({kind:'entityType',label,subtypes:[],ownedAttributes:[],playedRoles:roles.map(label=>({kind:'roleType',label}))});
const relation = (label, roles) => ({...owner(label),kind:'relationType',relatedRoles:roles.map(label=>({kind:'roleType',label}))});
const title=attr('title'), id=attr('scene-id');
const scene=owner('scene',['scene-take:scene']), take=owner('take',['scene-take:take','other:take']);
scene.ownedAttributes=[title,id];
const extra=owner('extra',['other:extra']);
const frame=owner('frame'); scene.supertype=frame; frame.subtypes=[scene];
const rel=relation('scene-take',['scene-take:scene','scene-take:take']), other=relation('other',['other:take','other:extra']);
const schema={entities:{scene,take,extra,frame},relations:{'scene-take':rel,other},attributes:{title,'scene-id':id}};

test('entity context includes role paths, other players, attributes and ancestry without recursively expanding players',()=>{
 const result=schemaFocus('match $item isa scene; $item isa! $concrete;',schema);
 assert.deepEqual(result.seeds,['scene']);
 assert.deepEqual([...result.labels].sort(),['frame','scene','scene-id','scene-take','scene-take:scene','scene-take:take','take','title']);
 assert.equal(result.labels.has('other'),false);
 assert.equal(result.labels.has('extra'),false);
});
test('relation, schema declaration, mutation and malformed sources use known references, ignoring strings/comments/variable names',()=>{
 for(const source of ['match $item isa scene-take;', 'relation scene-take relates scene;', 'insert scene-take (scene: $s, take: $t);']) {
  const result=schemaFocus(source,schema);
  assert.ok(result.labels.has('scene-take:take'));
  assert.ok(result.labels.has('take'));
 }
 assert.deepEqual(schemaFocus('match $extra isa scene, has title "other"; # extra\n',schema).seeds,['scene','title']);
 assert.deepEqual(schemaFocus('match $item isa scene; try {',schema).seeds,['scene']);
 assert.deepEqual(schemaFocus('match $scene isa $type;',schema).seeds,[]);
 assert.deepEqual(schemaFocus('match $x isa missing;',schema).seeds,[]);
});
test('attribute context finds owners and inherited properties remain connected through ancestors',()=>{
 assert.ok(schemaFocus('match $x isa title;',schema).labels.has('scene'));
 const child=owner('child',scene.playedRoles.map(r=>r.label)); child.supertype=scene;child.ownedAttributes=scene.ownedAttributes;scene.subtypes=[child];
 const updated={...schema,entities:{...schema.entities,child}};
 const result=schemaFocus('match $x isa child;',updated);
 for(const label of ['child','scene','frame','scene-take','scene-take:scene','take','title']) assert.ok(result.labels.has(label),label);
});
