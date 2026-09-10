import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareGraphQuery, findGraphContextSeed, isGraphContextRelationCompatible } from '../src/framework/util/graph-query.ts';

const types = {
    person: { kind: 'entityType', playedRoles: [{ label: 'friendship:friend' }] },
    isolated: { kind: 'entityType', playedRoles: [] },
    friendship: { kind: 'relationType', relatedRoles: [{ label: 'friendship:friend' }] },
    name: { kind: 'attributeType' },
};
const prepare = (source, options = {}) => prepareGraphQuery(source,
    { neighbours: false, ...options }, label => types[label]);

test('removes only the terminal fetch, preserving strings, comments, limits and selection', () => {
    const base = 'match $x isa person, has name "fetch \\" }"; # fetch in a comment\nlimit 12;\nselect $x;';
    const source = `${base}\nfetch { "nested": [ match $p isa person; fetch { "name": $p.name }; ] };`;
    assert.equal(prepare(source).query, base);
    assert.equal(prepare('match $fetch isa person; select $fetch;').query, 'match $fetch isa person; select $fetch;');
    assert.equal(prepare('match $x isa person; # fetch should stay here').query, 'match $x isa person; # fetch should stay here');
});

test('one-hop context uses fresh variables and keeps the original seed pipeline', () => {
    const source = 'match $x isa person; $nvim_player isa person; limit 5; select $x; fetch { "x": $x.* };';
    const result = prepare(source, { neighbours: true, relationTypes: ['friendship'] });
    assert.ok(result.query.startsWith('match $x isa person; $nvim_player isa person; limit 5; select $x;'));
    assert.match(result.query, /try \{/);
    assert.match(result.query, /\$nvim_relation links \(\$x\)/);
    assert.match(result.query, /\$nvim_relation isa friendship/);
    assert.match(result.query, /links \(\$nvim_player_\)/);
});

test('relation seeds expand role players, while unlinked and aggregate seeds are left intact', () => {
    assert.match(prepare('match $r isa friendship;', { neighbours: true }).query, /\$r links \(\$nvim_player\)/);
    for (const source of ['match $x isa isolated;', 'match $x isa person; reduce $n = count;',
        'match $x isa person; select $other;', 'match $a isa name;']) {
        assert.equal(prepare(source, { neighbours: true }).query, source);
    }
});

test('does not infer seeds local to a nested scope and validates explicit context settings', () => {
    const source = 'match $x isa person; not { $local isa person; }; select $x;';
    assert.equal(prepare(source, { neighbours: true, seedVariable: '$local' }).query, source);
    assert.throws(() => prepare(source, { neighbours: true, seedVariable: '$x; insert' }));
    assert.throws(() => prepare(source, { neighbours: true, relationTypes: ['unknown'] }));
    assert.throws(() => prepare(source, { neighbours: true, relationTypes: ['friendship; delete'] }));
});

test('rejects automatic replay of mutations, batches, preambles and malformed boundaries', () => {
    for (const source of ['insert $x isa person;', 'match $x isa person; delete $x;',
        'match $x isa person; end; match $y isa person;', 'define entity person;',
        'with fun f() -> person: match $x isa person; return first $x; match let $x = f();',
        'match $x isa person, has name "unclosed;', 'match { $x isa person;']) {
        assert.throws(() => prepare(source));
    }
});

test('incompatible saved relation filters preserve seed rows instead of generating INF11', () => {
    const schema = {
        'mental-state': { kind: 'entityType', playedRoles: [{ label: 'motivation:driver' }] },
        motivation: { kind: 'relationType', relatedRoles: [{ label: 'motivation:driver' }, { label: 'motivation:target' }] },
        'depiction-slot': { kind: 'relationType', relatedRoles: [{ label: 'depiction-slot:host' }] },
    };
    const lookup = label => schema[label];
    const source = 'match $item isa mental-state; $item isa! $concrete;';
    const filtered = labels => prepareGraphQuery(source, { neighbours: true, relationTypes: labels }, lookup);
    const incompatible = filtered(['depiction-slot']);
    assert.equal(incompatible.query, source);
    assert.match(incompatible.note, /No selected relation types are compatible/);
    const mixed = filtered(['depiction-slot', 'motivation']);
    assert.match(mixed.query, /isa motivation/);
    assert.doesNotMatch(mixed.query, /depiction-slot/);
    assert.match(mixed.note, /Skipped incompatible relation types: depiction-slot/);
    assert.match(filtered([]).query, /\$nvim_relation links \(\$item\)/);
    assert.match(prepareGraphQuery('match $item isa motivation;', {
        neighbours: true, relationTypes: ['depiction-slot'],
    }, lookup).query, /\$item links \(\$nvim_player\)/);
});

test('compatibility respects scoped roles, inherited roles, subtype seeds and exact isa', () => {
    const base = { kind: 'entityType', playedRoles: [{ label: 'base-relation:member' }], subtypes: [] };
    const child = { kind: 'entityType', playedRoles: [{ label: 'child-relation:member' }], supertype: base };
    base.subtypes.push(child);
    const baseRelation = { kind: 'relationType', relatedRoles: [{ label: 'base-relation:member' }] };
    const subRelation = { kind: 'relationType', relatedRoles: [], supertype: baseRelation };
    const childRelation = { kind: 'relationType', relatedRoles: [{ label: 'child-relation:member' }] };
    const abstractRelation = { kind: 'relationType', relatedRoles: [], subtypes: [childRelation] };
    const otherRelation = { kind: 'relationType', relatedRoles: [{ label: 'unrelated:member' }] };
    const schema = { base, child, childRelation };
    const lookup = label => schema[label];
    const seed = text => findGraphContextSeed(text, undefined, lookup);
    assert.equal(isGraphContextRelationCompatible(seed('match $x isa base;'), childRelation), true);
    assert.equal(isGraphContextRelationCompatible(seed('match $x isa! base;'), childRelation), false);
    assert.equal(isGraphContextRelationCompatible(seed('match $x isa! child;'), subRelation), true);
    assert.equal(isGraphContextRelationCompatible(seed('match $x isa base;'), abstractRelation), true);
    assert.equal(isGraphContextRelationCompatible(seed('match $x isa base;'), otherRelation), false);
    assert.equal(findGraphContextSeed('match $x isa base; select $y;', undefined, lookup), undefined);
    assert.equal(findGraphContextSeed('match $x isa base; reduce $n = count;', undefined, lookup), undefined);
    const exactBase = { kind: 'entityType', subtypes: [child] };
    assert.equal(prepareGraphQuery('match $x isa! exactBase;', { neighbours: true }, () => exactBase).query,
        'match $x isa! exactBase;');
});
