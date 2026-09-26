import test from 'node:test';
import assert from 'node:assert/strict';
import { typeqlLiteral, attributeEditQuery } from '../src/framework/util/attribute-edit.ts';

test('literals follow the attribute value type and reject what does not fit', () => {
    assert.equal(typeqlLiteral('string', 'say "hi"\nnow'), '"say \\"hi\\"\\nnow"');
    assert.equal(typeqlLiteral('integer', ' 42 '), '42');
    assert.equal(typeqlLiteral('double', '3'), '3.0');
    assert.equal(typeqlLiteral('double', '2.5e3'), '2.5e3');
    assert.equal(typeqlLiteral('decimal', '1.25'), '1.25dec');
    assert.equal(typeqlLiteral('boolean', 'TRUE'), 'true');
    assert.equal(typeqlLiteral('datetime', '2024-05-01T10:00:00'), '2024-05-01T10:00:00');
    assert.throws(() => typeqlLiteral('integer', '4.2'), /whole number/);
    assert.throws(() => typeqlLiteral('boolean', 'yes'), /true or false/);
    assert.throws(() => typeqlLiteral('date', '2024-05-01; delete'), /date literal/);
});

test('edits anchor the owner by iid and type and match the old value', () => {
    const base = { ownerIid: '0x1e00', ownerType: 'scene', attribute: 'title', valueType: 'string' };
    assert.equal(attributeEditQuery({ ...base, oldValue: 'Old', newValue: 'New' }),
        'match $x iid 0x1e00, isa scene; $x has title $old; $old == "Old"; delete has $old of $x; insert $x has title "New";');
    assert.equal(attributeEditQuery({ ...base, newValue: 'Added' }), 'match $x iid 0x1e00, isa scene; insert $x has title "Added";');
    assert.equal(attributeEditQuery({ ...base, oldValue: 'Gone' }), 'match $x iid 0x1e00, isa scene; $x has title $old; $old == "Gone"; delete has $old of $x;');
    assert.equal(attributeEditQuery({ ...base, attribute: 'n', valueType: 'integer', oldValue: 3, newValue: '4' }),
        'match $x iid 0x1e00, isa scene; $x has n $old; $old == 3; delete has $old of $x; insert $x has n 4;');
    assert.throws(() => attributeEditQuery({ ...base, ownerIid: 'scene:S1', newValue: 'x' }), /iid/);
});
