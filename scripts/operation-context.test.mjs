import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// Resolve the one runtime import for Node's TS stripping, without changing Angular's module settings.
const file = new URL('../src/framework/util/operation-context.ts', import.meta.url);
const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace('"./graph-query"', JSON.stringify(new URL('../src/framework/util/graph-query.ts', import.meta.url).href));
const { prepareOperationContext, prepareSchemaContext } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const attr = label => ({ kind:'attributeType', label, subtypes:[] });
const sceneId=attr('scene-id'), title=attr('title'), takeId=attr('take-id');
const sceneRole={kind:'roleType',label:'scene-take:scene'}, takeRole={kind:'roleType',label:'scene-take:take'};
const scene={kind:'entityType',label:'scene',ownedAttributes:[sceneId,title],playedRoles:[sceneRole],subtypes:[]};
const take={kind:'entityType',label:'take',ownedAttributes:[takeId,title],playedRoles:[takeRole],subtypes:[]};
const relation={kind:'relationType',label:'scene-take',ownedAttributes:[],playedRoles:[],relatedRoles:[sceneRole,takeRole],subtypes:[]};
const schema={entities:{scene,take},relations:{'scene-take':relation},attributes:{'scene-id':sceneId,'take-id':takeId,title}};
const options={neighbours:true};
const source='match $t isa take, has take-id "T1"; insert $s isa scene, has scene-id "S1", has title "New title"; scene-take (scene: $s, take: $t);';

test('write success and failure produce reads with literal identity context, never replay a mutation',()=>{
 for(const status of ['success','error']) {
  const result=prepareOperationContext(source,{kind:'write',status},options,schema);
  assert.equal(result.schemaMode,false);
  assert.ok(result.query.includes('$item isa scene, has scene-id "S1"'));
  assert.ok(result.query.includes('$item isa take, has take-id "T1"'));
  assert.ok(result.query.includes('$item isa scene-take'));
  assert.ok(!result.query.includes('insert'));
  assert.ok(!result.query.includes('New title'));
  assert.ok(result.query.includes('links'));
 }
});

test('schema operations focus declared types and include schema connections',()=>{
 const result=prepareSchemaContext('define relation scene-take relates scene; entity scene owns scene-id;',options,schema);
 assert.equal(result.schemaMode,true);
 assert.ok(result.query.includes('$type label scene;'));
 assert.ok(result.query.includes('$type label scene-take;'));
 assert.ok(result.query.includes('$type owns $attribute'));
 assert.ok(!result.query.includes('define'));
 assert.ok(!result.query.includes('isa'));
 const bare=prepareSchemaContext('entity scene owns scene-id;',{neighbours:false},schema);
 assert.equal(bare.query,'match\n{ $type label scene; };');
});

test('errors tolerate broken source boundaries and only refer to known schema types',()=>{
 const result=prepareOperationContext('match $s isa scene; insert unknown (thing: $s; "scene-take', {kind:'write',status:'error'}, {neighbours:false},schema);
 assert.equal(result.query,'match\n{ $item isa scene; };');
 assert.throws(()=>prepareSchemaContext('# entity scene\ndefine entity unknown @doc("scene");',options,schema),/No referenced types/);
});

test('comments and quoted stage names cannot introduce executable statements',()=>{
 const result=prepareOperationContext('insert $s isa scene, has title "insert; delete $s; # scene-take"; # entity take', {kind:'write',status:'error'}, {neighbours:false},schema);
 assert.equal(result.query,'match\n{ $item isa scene, has title "insert; delete $s; # scene-take"; };');
});

test('menu changes regenerate context without losing source filters',()=>{
 const result=prepareOperationContext(source,{kind:'write',status:'success'},{neighbours:false,seedVariable:'$s'},schema);
 assert.equal(result.query,'match\n{ $item isa scene, has scene-id "S1"; };');
 assert.throws(()=>prepareOperationContext(source,{kind:'write',status:'success'},{...options,seedVariable:'$missing'},schema),/seed variable/);
});
