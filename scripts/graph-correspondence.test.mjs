import test from 'node:test';
import assert from 'node:assert/strict';
import { isaRelatives, correspondsToType } from '../src/framework/util/graph-correspondence.ts';

const type = (label, supertype) => ({ label, supertype, subtypes: [] });
const intent = type('stage-intent'), stages = type('stages', intent), conflict = type('conflict-stage', stages), depiction = type('depiction', intent);
intent.subtypes.push(stages, depiction); stages.subtypes.push(conflict);
const schema = { entities: {}, relations: { 'stage-intent': intent, stages, 'conflict-stage': conflict, depiction }, attributes: {} };

test('cross-view carets use the isa closure: subtypes for instances, supertypes for types', () => {
    assert.deepEqual(isaRelatives('stage-intent', schema, 'down'), ['stage-intent', 'stages', 'depiction', 'conflict-stage']);
    assert.deepEqual(isaRelatives('conflict-stage', schema, 'up'), ['conflict-stage', 'stages', 'stage-intent']);
    assert.deepEqual(isaRelatives('unknown', schema, 'down'), ['unknown']);
    assert.deepEqual(isaRelatives('stages', null, 'up'), ['stages']);
    assert.ok(correspondsToType({ kind: 'relation', type: { label: 'stages' } }, 'stages', false));
    assert.ok(!correspondsToType({ kind: 'relationType', label: 'stages' }, 'stages', false));
});
