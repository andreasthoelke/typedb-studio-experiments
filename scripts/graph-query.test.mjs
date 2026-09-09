import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareGraphQuery } from '../src/framework/util/graph-query.ts';

const types = {
    person: { kind: 'entityType', playedRoles: [{}] },
    isolated: { kind: 'entityType', playedRoles: [] },
    friendship: { kind: 'relationType', relatedRoles: [{}] },
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
