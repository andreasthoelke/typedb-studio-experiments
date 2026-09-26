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

import { readFileSync } from 'node:fs';
import ts from 'typescript';
const labelSource = ts.transpileModule(readFileSync(new URL('../src/framework/graph-visualiser/engine/instance-label.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace('"../../util/schema-meta"', JSON.stringify(new URL('../src/framework/util/schema-meta.ts', import.meta.url).href));
const { refreshInstanceLabels } = await import(`data:text/javascript;base64,${Buffer.from(labelSource).toString('base64')}`);

/** Minimal graph: owners with label values held in the display-attribute store. */
function labelGraph(owners) {
    const nodes = new Map(owners.map(([key, type]) => [key, { metadata: { concept: { kind: 'entity', iid: key, type: { label: type } } } }]));
    return {
        nodes,
        forEachNode(fn) { for (const [key, attrs] of nodes) fn(key, attrs); },
        forEachOutNeighbor() {},
        getNodeAttributes(key) { return nodes.get(key); },
        setNodeAttribute(key, name, value) { nodes.get(key)[name] = value; },
    };
}
const storeOf = entries => new Map(entries.map(([iid, attrs]) => [iid, new Map(Object.entries(attrs))]));

test('labels combine several attributes, shorten long values and follow schema defaults', () => {
    const long = 'A very long description that keeps going well beyond anything a node label can show';
    const graph = labelGraph([['s1', 'scene'], ['t1', 'take']]);
    const store = storeOf([['s1', { title: [long], 'scene-id': ['S1'] }], ['t1', { 'take-id': ['T1'], citation: ['x'] }]]);
    // User choice: two attributes, value fragments shortened to 20 characters.
    let chosen = refreshInstanceLabels(graph, store, new Map([['scene', 'title, scene-id']]), { maxLength: 20 });
    assert.equal(graph.nodes.get('s1').label, 'scene: A very long descrip… · S1');
    assert.deepEqual(chosen.get('scene'), ['title', 'scene-id']);
    // Schema @meta("graph-label") applies without a user choice; "none" shows the type only.
    refreshInstanceLabels(graph, store, new Map(), { schemaLabel: type => type === 'scene' ? 'scene-id' : 'none' });
    assert.equal(graph.nodes.get('s1').label, 'scene: S1');
    assert.equal(graph.nodes.get('t1').label, 'take');
    // Heuristic: @key beats an arbitrary attribute; very long values rank lower.
    chosen = refreshInstanceLabels(graph, store, new Map(), { identifying: type => new Set(type === 'take' ? ['take-id'] : []) });
    assert.deepEqual(chosen.get('take'), ['take-id']);
    const described = labelGraph([['d1', 'depiction']]);
    chosen = refreshInstanceLabels(described, storeOf([['d1', { description: [long], code: ['D-1'] }]]), new Map());
    assert.deepEqual(chosen.get('depiction'), ['code'], 'An 80+ character description loses to a code');
    // Multi-valued attributes show three values and a count.
    const tagged = labelGraph([['a1', 'asset']]);
    refreshInstanceLabels(tagged, storeOf([['a1', { name: ['d', 'c', 'b', 'a'] }]]), new Map());
    assert.equal(tagged.nodes.get('a1').label, 'asset: a, b, c +1');
});
