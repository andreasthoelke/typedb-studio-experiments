import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const file=new URL('../src/framework/util/editor-caret.ts',import.meta.url);
const js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
 .replace('"./graph-query"',JSON.stringify(new URL('../src/framework/util/graph-query.ts',import.meta.url).href));
const {editorCaretTarget,editorIllustrationQuery}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const schema={entities:{},relations:{},attributes:{}};
for(const name of ['take','scene','depiction','slot-def','occurrence','mental-state','goal','café']) schema.entities[name]={kind:'entityType',label:name,subtypes:[],playedRoles:[],ownedAttributes:[]};
for(const name of ['depiction-id','slot-id','occurrence-id','referent-id','title','role-name']) schema.attributes[name]={kind:'attributeType',label:name,subtypes:[]};
schema.relations['occurrence-of']={kind:'relationType',label:'occurrence-of',relatedRoles:[{label:'occurrence-of:occurrence'},{label:'occurrence-of:subject'}]};
schema.relations.composition={kind:'relationType',label:'composition',relatedRoles:['host','slot','child'].map(r=>({label:'composition:'+r}))};
schema.relations['scene-take']={kind:'relationType',label:'scene-take',relatedRoles:['scene','take'].map(r=>({label:'scene-take:'+r}))};
const source=`match
  $d isa depiction, has depiction-id "conflict-stage";
  $sg isa slot-def, has slot-id "conflict-stage/goal";
  $fear isa mental-state, has referent-id "fear";
insert
  $of isa occurrence, has occurrence-id "occ-fear";
  occurrence-of (occurrence: $of, subject: $fear);
  composition (host: $d, slot: $sg, child: $of);`;
const target=(line,column=0,text=source)=>editorCaretTarget({source:text,line,column},schema);

test('Enter resolves a variable and literal attributes while preserving schema/type identity',()=>{
 const t=target(2);
 assert.deepEqual(t.schemaLabels,['slot-def']);assert.equal(t.identifier,'$sg');
 assert.deepEqual(t.instance,{variable:'$sg',typeLabel:'slot-def',attributes:[{label:'slot-id',literal:'"conflict-stage/goal"'}]});
 assert.deepEqual(target(2,4),t,'Cursor inside a variable still targets it');
 assert.deepEqual(target(2,15).schemaLabels,['slot-def']);
 assert.deepEqual(target(2,36).schemaLabels,['slot-id'],'Inside a string focuses its attribute in Schema');
 assert.equal(target(2,36).instance.variable,'$sg');
});
test('anonymous relation lines focus relations; explicit variable positions focus players',()=>{
 const t=target(6);
 assert.deepEqual(t.schemaLabels,['occurrence-of']);assert.equal(t.instance.typeLabel,'occurrence-of');
 assert.deepEqual(t.context.bindings['$of'].attributes,[{label:'occurrence-id',literal:'"occ-fear"'}]);
 const subject=target(6,source.split('\n')[6].indexOf('subject'));
 assert.deepEqual(subject.schemaLabels,['occurrence-of:subject']);
 assert.equal(subject.instance.typeLabel,'mental-state');
 const slot=target(7,source.split('\n')[7].indexOf('$sg'));
 assert.deepEqual(slot.schemaLabels,['slot-def']);assert.equal(slot.instance.attributes[0].literal,'"conflict-stage/goal"');
});
test('schema declarations, scoped roles, Unicode and quoted labels are navigable',()=>{
 assert.deepEqual(target(0,0,'entity depiction, owns depiction-id;').schemaLabels,['depiction']);
 assert.deepEqual(target(0,0,'entity depiction, owns depiction-id;').instance,{typeLabel:'depiction',attributes:[]});
 assert.deepEqual(target(0,18,'entity café, plays occurrence-of:subject;').schemaLabels,['occurrence-of:subject']);
 assert.deepEqual(target(0,0,'entity `café`;').schemaLabels,['café']);
});
test('declaration names cannot inherit role identity from later plays clauses',()=>{
 const declaration='entity take @doc("a reproducible interpretation: which claims are in force") @meta("layer", "scenic-core"),\n  plays scene-take:take;';
 for(const column of [0,7,9]) {
  const t=target(0,column,declaration);
  assert.deepEqual(t.schemaLabels,['take']);assert.equal(t.instance.typeLabel,'take');
 }
 const text='entity take, plays scene-take:take;';
 assert.deepEqual(target(0,0,text).schemaLabels,['take']);
 assert.equal(target(0,0,text).instance.typeLabel,'take');
 for(const column of [text.indexOf('plays'),text.indexOf('scene-take'),text.lastIndexOf('take')]) {
  const t=target(0,column,text);
  assert.deepEqual(t.schemaLabels,['scene-take:take']);assert.equal(t.instance.typeLabel,'scene-take');
 }
 assert.deepEqual(target(0,0,'relation scene-take, relates take;').schemaLabels,['scene-take']);
 assert.deepEqual(target(0,20,'relation scene-take, relates take;').schemaLabels,['scene-take:take']);
});
test('comments, unrelated literals, end of line and missing names do not select another line',()=>{
 for(const [text,line,column] of [['# depiction $d',0,0],['entity missing;',0,0],['"depiction"',0,0],['entity depiction;',0,17],['match\n$d isa depiction;',0,0]]) {
  assert.equal(target(line,column,text),null,text);
 }
});
test('multiline and split has declarations resolve only their owner, not other variables or paragraphs',()=>{
 const text='$of isa occurrence;\n$of has occurrence-id "occ-fear";\n$other isa mental-state, has referent-id "fear";\noccurrence-of (occurrence: $of, subject: $other);';
 assert.deepEqual(target(3,0,text).context.bindings['$of'].attributes,[{label:'occurrence-id',literal:'"occ-fear"'}]);
 assert.equal(target(0,0,'occurrence-of (occurrence: $missing, subject: $unknown);').instance.typeLabel,'occurrence-of');
 const multiline='$d isa depiction,\n  has depiction-id "conflict-stage";';
 assert.deepEqual(target(1,0,multiline).instance.attributes,[{label:'depiction-id',literal:'"conflict-stage"'}]);
});
test('illustrations are bounded reads constrained by all role players, never source writes',()=>{
 const q=editorIllustrationQuery(target(6),schema);
 assert.match(q,/^match \$focus isa occurrence-of;/);
 assert.match(q,/links \(occurrence: \$v1, subject: \$v2\)/);
 assert.match(q,/has occurrence-id "occ-fear"/);assert.match(q,/has referent-id "fear"/);
 assert.ok(q.endsWith('limit 20;'));assert.ok(!q.includes('insert'));
 const bad={...target(6),context:undefined,instance:{typeLabel:'occurrence',attributes:[{label:'occurrence-id',literal:'"ok"; delete $focus;'}]}};
 assert.equal(editorIllustrationQuery(bad,schema),null);
});
test('relation siblings are distinguished by each slot and source variables remain independent',()=>{
 schema.relations['depiction-slot']={kind:'relationType',label:'depiction-slot',relatedRoles:['host','slot'].map(r=>({label:'depiction-slot:'+r}))};
 const text='insert\n$d isa depiction, has depiction-id "conflict-stage";\n$sa isa slot-def, has slot-id "conflict-stage/agent";\n$sg isa slot-def, has slot-id "conflict-stage/goal";\n$sb isa slot-def, has slot-id "conflict-stage/barrier";\ndepiction-slot (host: $d, slot: $sa);\ndepiction-slot (host: $d, slot: $sg);\ndepiction-slot (host: $d, slot: $sb);';
 for(const [index,slot] of ['agent','goal','barrier'].entries()) {
  const t=target(index+5,0,text),q=editorIllustrationQuery(t,schema);
  assert.equal(t.instance.typeLabel,'depiction-slot');assert.ok(q.includes('conflict-stage/'+slot));
  for(const other of ['agent','goal','barrier'].filter(s=>s!==slot)) assert.ok(!q.includes('conflict-stage/'+other));
 }
 assert.equal(target(5,text.split('\n')[5].indexOf('$sa'),text).instance.typeLabel,'slot-def');
});
test('untyped variables acquire connected relation and ownership patterns for illustrative reads',()=>{
 schema.relations['role-binding']={kind:'relationType',label:'role-binding',relatedRoles:['instance','bound'].map(r=>({label:'role-binding:'+r}))};
 const text='match\nrole-binding (instance: $pi, bound: $o), has role-name $rn;\noccurrence-of (occurrence: $o, subject: $r);\n$r has title $who;';
 for(const line of [1,2,3]) {
  const t=target(line,0,text),q=editorIllustrationQuery(t,schema);
  assert.ok(q,q);assert.match(q,/links/);assert.ok(q.endsWith('limit 20;'));
  if(line===3) {assert.match(q,/isa occurrence-of/);assert.match(q,/isa role-binding/);assert.match(q,/has title/);}
 }
});


test('links and tuple roles target the player, inferred schema type and attribute variables stay navigable',()=>{
 schema.attributes.intensity={kind:'attributeType',label:'intensity',subtypes:[]};
 schema.relations.tension={kind:'relationType',label:'tension',relatedRoles:[{label:'tension:pole'}],ownedAttributes:[schema.attributes.intensity],playedRoles:[]};
 schema.entities['mental-state'].playedRoles=[{label:'tension:pole'}];
 schema.entities['mental-state'].ownedAttributes=[schema.attributes.title];
 const text='match\n  $tension isa tension, links (pole: $state), has intensity $intensity;\n  $state has title $name;\nfetch { "state": $name, "intensity": $intensity };';
 for(const word of ['links','pole']) {
  const t=target(1,text.split('\n')[1].indexOf(word),text);
  assert.equal(t.instance.variable,'$state');assert.deepEqual(t.schemaLabels,['tension:pole']);
  assert.match(editorIllustrationQuery(t,schema),/pole: \$focus/);
 }
 const state=target(2,2,text);assert.deepEqual(state.schemaLabels,['mental-state']);
 const intensity=target(1,text.split('\n')[1].indexOf('$intensity'),text);
 assert.equal(intensity.instance.typeLabel,'intensity');assert.deepEqual(intensity.schemaLabels,['intensity']);
 assert.match(editorIllustrationQuery(intensity,schema),/has intensity \$focus/);
});
