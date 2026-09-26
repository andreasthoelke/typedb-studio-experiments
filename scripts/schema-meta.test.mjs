import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchemaMeta, SchemaDefaults, labelAttributes } from '../src/framework/util/schema-meta.ts';

// Shaped like the server's schema dump, including the annotation traps.
const dump = `define

attribute claim-id @doc("stable id");
attribute claim-id value string;
attribute title value string @meta("graph-label", "ignored: value type");
entity scene @meta("layer", "scenic-core") @meta("graph-label", "title, scene-id"),
  owns scene-id @key,
  owns title,
  plays occurrence-of:subject;
entity scene-draft sub scene;
relation claim @abstract @meta("graph-arrow", "relation"),
  owns claim-id @unique;
relation motivation sub claim @meta("graph-arrow", "none"),
  relates driver @meta("graph-arrow", "player"),
  relates toward;
relation occurrence-of @meta("graph-label", "none"),
  relates occurrence @card(1..1) @meta("graph-arrow", "player"),
  relates subject @meta("graph-arrow", "none") @meta("note", "a \\"quoted\\" value");
fun count_scenes() -> integer: match $s isa scene; return count;
`;
const hierarchy = { entities: {}, relations: {}, attributes: {} };
hierarchy.entities.scene = { label: 'scene' };
hierarchy.entities['scene-draft'] = { label: 'scene-draft', supertype: hierarchy.entities.scene };
hierarchy.relations.claim = { label: 'claim' };
hierarchy.relations.motivation = { label: 'motivation', supertype: hierarchy.relations.claim };
hierarchy.relations['occurrence-of'] = { label: 'occurrence-of' };

test('parses type, relates and identifying annotations from a schema dump', () => {
    const meta = parseSchemaMeta(dump);
    assert.deepEqual(meta.types.scene, { layer: 'scenic-core', 'graph-label': 'title, scene-id' });
    assert.equal(meta.types.title, undefined, 'An annotation after value belongs to the value type');
    assert.equal(meta.types.motivation, undefined, 'An annotation after sub belongs to the subtyping edge');
    assert.deepEqual(meta.roles['occurrence-of:subject'], { 'graph-arrow': 'none', note: 'a "quoted" value' });
    assert.deepEqual(meta.roles['motivation:driver'], { 'graph-arrow': 'player' });
    assert.deepEqual(meta.identifying, { scene: ['scene-id'], claim: ['claim-id'] });
    assert.deepEqual(parseSchemaMeta('define entity "unclosed'), { types: {}, roles: {}, identifying: {} });
});

test('defaults resolve role → relation → supertypes, and labels inherit', () => {
    const defaults = new SchemaDefaults(parseSchemaMeta(dump), hierarchy);
    assert.equal(defaults.arrow('occurrence-of:subject'), 'none');
    assert.equal(defaults.arrow('occurrence-of:occurrence'), 'player');
    assert.equal(defaults.arrow('motivation:driver'), 'player');
    assert.equal(defaults.arrow('motivation:toward'), 'relation', 'Inherited from the abstract claim');
    assert.equal(defaults.arrow('evidence:claimed'), undefined);
    assert.equal(defaults.label('scene-draft'), 'title, scene-id');
    assert.equal(defaults.label('occurrence-of'), 'none');
    assert.deepEqual([...defaults.identifying('scene-draft')], ['scene-id']);
    assert.deepEqual(labelAttributes('title, scene-id'), ['title', 'scene-id']);
    assert.deepEqual(labelAttributes('none'), []);
});
