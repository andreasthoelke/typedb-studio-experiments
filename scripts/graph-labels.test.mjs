import assert from 'node:assert/strict';
import test from 'node:test';
import { drawClippedNodeLabel } from '../src/framework/graph-visualiser/engine/sigma-label-utils.ts';

const settings = { labelSize: 14, labelFont: 'sans-serif', labelWeight: '400' };

function render(label) {
    const lines = [];
    const operations = [];
    const context = {
        save() {}, restore() {}, translate() {}, scale() {},
        measureText(text) { return { width: text.length * 7 }; },
        fill() { operations.push(this.globalCompositeOperation); },
        clip() { operations.push('clip'); },
        fillText(text) { lines.push(text); operations.push('text'); },
    };
    drawClippedNodeLabel(context, { x: 100, y: 100, size: 40, color: '#eee', label }, settings,
        () => operations.push('body'));
    return { lines, operations };
}

test('long node labels stay readable outside the silhouette', () => {
    const { lines, operations } = render('motivation:\nm-craving-approval-with-a-long-identifier');
    assert.equal(lines[0], 'motivation:');
    assert.ok(lines[1].endsWith('…'));
    assert.ok(lines[1].length * 7 > 80, 'label actually extends past the node width');
    assert.ok(!operations.includes('clip'), 'a shape mask must not cut off wrapped text');
    assert.deepEqual(operations.slice(0, 3), ['body', 'destination-out', 'text'],
        'the node body still hides labels behind it');
});

test('all labels use the wider wrapping area, even when a narrower wrap would fit', () => {
    assert.deepEqual(render('alpha beta pi delta').lines, ['alpha beta pi', 'delta']);
});

test('long identifiers on every line have bounded width', () => {
    const { lines } = render('a-very-long-type-name-before-the-final-line\na-very-long-attribute-value-also-overflows');
    assert.equal(lines.length, 2);
    for (const line of lines) {
        assert.ok(line.length * 7 <= (80 - 6) * 1.5);
        assert.ok(line.endsWith('…'));
    }
});

test('omitting whole lines is indicated with an ellipsis', () => {
    assert.deepEqual(render('one\ntwo\nthree\nfour').lines, ['one', 'two', 'three…']);
});
