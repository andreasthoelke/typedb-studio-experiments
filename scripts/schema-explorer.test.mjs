import assert from 'node:assert/strict';
import test from 'node:test';
import { schemaExplorerSections, schemaExplorerSeeds } from '../src/framework/util/schema-explorer.ts';

const name = { kind: 'attributeType', label: 'name', valueType: 'string', subtypes: [] };
const driver = { kind: 'roleType', label: 'motivation:driver' };
const target = { kind: 'roleType', label: 'motivation:target' };
const state = { kind: 'entityType', label: 'state', subtypes: [], ownedAttributes: [name], playedRoles: [driver, target] };
const subtype = { ...state, label: 'feeling', supertype: state };
state.subtypes = [subtype];
const motivation = { kind: 'relationType', label: 'motivation', subtypes: [], ownedAttributes: [name], playedRoles: [], relatedRoles: [driver, target] };
const schema = { entities: { state, feeling: subtype }, relations: { motivation }, attributes: { name } };
const sections = selected => Object.fromEntries(schemaExplorerSections(schema, selected).map(s => [s.title, s.types.map(t => t.label)]));

test('schema exploration exposes hierarchy and inherited ownership/roles without duplicate relations', () => {
    assert.deepEqual(sections(state), {
        Subtypes: ['feeling'], Attributes: ['name'], 'Plays roles': ['motivation:driver', 'motivation:target'], Relations: ['motivation'],
    });
    assert.deepEqual(sections(subtype), {
        Supertype: ['state'], Attributes: ['name'], 'Plays roles': ['motivation:driver', 'motivation:target'], Relations: ['motivation'],
    });
});

test('attribute owners and scoped role players can be explored in reverse', () => {
    assert.deepEqual(sections(name), { Owners: ['feeling', 'motivation', 'state'] });
    assert.deepEqual(sections(driver), { Relations: ['motivation'], 'Role players': ['feeling', 'state'] });
    assert.deepEqual(sections({ ...driver, label: 'other:driver' }), {});
    assert.deepEqual(sections(motivation), { Attributes: ['name'], 'Relates roles': ['motivation:driver', 'motivation:target'] });
});

test('schema expansion resolves live concepts and maps scoped roles to their relations', () => {
    assert.deepEqual(schemaExplorerSeeds(schema, [driver, target, motivation]), [motivation]);
    assert.deepEqual(schemaExplorerSeeds(schema, [{ ...state, ownedAttributes: [] }, name]), [state, name]);
    assert.deepEqual(schemaExplorerSeeds(schema, [{ ...driver, label: 'other:driver' }, { ...name, label: 'removed' }]), []);
    const inherited = { ...motivation, label: 'special-motivation' };
    const extended = { ...schema, relations: { motivation, 'special-motivation': inherited } };
    assert.deepEqual(schemaExplorerSeeds(extended, [driver]), [motivation, inherited]);
});
