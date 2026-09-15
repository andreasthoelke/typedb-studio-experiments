import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiGraph } from 'graphology';
import { edgeRoleLabel, edgeDisplayLabel, edgeStyleKey, inheritedEdgeStyle, parallelEdgeGeometry,
    unresolvedRolePairs, resolveRoleEdges } from '../src/framework/util/graph-edge.ts';

const relation = { kind: 'relation', iid: '0x123', type: { label: 'composition' } };
const player = { kind: 'entity', iid: '0x456', type: { label: 'depiction' } };
const link = role => ({ label: 'links', size: 2, type: 'line', metadata: { answerIndex: 0,
    dataEdge: { tag: 'links', relation, player, role: role ? { kind: 'roleType', label: role } : { kind: 'unavailable' } } } });

test('role labels survive label restoration and retain full identity for styling', () => {
    for (const role of ['host', 'composition:host']) {
        assert.equal(edgeRoleLabel(link(role)), 'composition:host');
        assert.equal(edgeDisplayLabel(link(role)), 'host');
        assert.equal(edgeStyleKey(link(role)), 'composition:host');
    }
    assert.equal(edgeRoleLabel(link('base:host')), 'base:host', 'preserve returned inherited role scope');
    assert.equal(edgeStyleKey(link()), 'links');
    assert.equal(edgeDisplayLabel(link()), 'links', 'never guess an unavailable role');
    assert.equal(edgeDisplayLabel({ label: 'assign[$x]', metadata: { dataEdge: { tag: 'expression' } } }), 'assign[$x]');
    assert.equal(edgeDisplayLabel({ label: '', metadata: { defaultLabel: 'arg[$x]', dataEdge: { tag: 'expression' } } }), 'arg[$x]');
    assert.equal(edgeStyleKey({ label: 'has' }), 'has', 'legacy edges without metadata remain supported');
});

test('role properties inherit independently from links then all edges, with isolated scopes', () => {
    const colors = { links: '#222222', 'composition:host': '#00ff00' };
    assert.equal(inheritedEdgeStyle(colors, 'composition:host', '#111111'), '#00ff00');
    assert.equal(inheritedEdgeStyle(colors, 'depiction-slot:host', '#111111'), '#222222');
    assert.equal(inheritedEdgeStyle(colors, 'has', '#111111'), '#111111');
    assert.equal(inheritedEdgeStyle({ links: 'dotted' }, 'composition:host', 'solid'), 'dotted');
    assert.equal(inheritedEdgeStyle({ links: 2, 'composition:host': 1 }, 'composition:host', 3), 1);
    delete colors['composition:host'];
    assert.equal(inheritedEdgeStyle(colors, 'composition:host', '#111111'), '#222222');
    delete colors.links;
    assert.equal(inheritedEdgeStyle(colors, 'composition:host', '#111111'), '#111111');
});

test('parallel lanes are symmetric and separated even when edge direction reverses', () => {
    assert.deepEqual(parallelEdgeGeometry(0, 1, 'a', 'b', false), { type: 'line', curvature: .25 });
    assert.equal(parallelEdgeGeometry(0, 1, 'a', 'b', true).type, 'curved');
    assert.deepEqual([0, 1].map(i => parallelEdgeGeometry(i, 2, 'a', 'b', false).curvature), [-.25, .25]);
    // Same signed curvature in reverse direction describes the opposite physical side.
    assert.equal(parallelEdgeGeometry(1, 2, 'b', 'a', false).curvature, -.25);
    assert.equal(parallelEdgeGeometry(1, 3, 'a', 'b', true).type, 'line', 'zero curvature uses the stable straight shader');
});

test('resolving an anonymous link preserves nodes and expands distinct roles without duplicates', () => {
    const graph = new MultiGraph();
    graph.addNode('r', { x: 10, y: 20, metadata: { concept: relation } });
    graph.addNode('p', { x: 30, y: 40, metadata: { concept: player } });
    graph.setAttribute('elementSelection', { active: true, nodes: ['p'] });
    graph.addDirectedEdgeWithKey('unknown', 'r', 'p', link());
    graph.addDirectedEdgeWithKey('known', 'r', 'p', link('composition:host'));
    const nodes = structuredClone(graph.export().nodes), selection = structuredClone(graph.getAttribute('elementSelection'));
    assert.deepEqual(unresolvedRolePairs(graph), [{ relation: relation.iid, player: player.iid }]);
    const rows = ['composition:host', 'composition:slot', 'composition:slot'].map(label => ({ r: relation, p: player, role: { kind: 'roleType', label } }));
    rows.push({ r: relation, p: { ...player, iid: '0x789' }, role: { kind: 'roleType', label: 'composition:child' } });
    assert.equal(resolveRoleEdges(graph, rows), true);
    assert.equal(graph.size, 2);
    assert.deepEqual(graph.edges().map(e => edgeStyleKey(graph.getEdgeAttributes(e))).sort(), ['composition:host', 'composition:slot']);
    assert.deepEqual(graph.export().nodes, nodes);
    assert.deepEqual(graph.getAttribute('elementSelection'), selection);
    assert.deepEqual(unresolvedRolePairs(graph), []);
    assert.equal(resolveRoleEdges(graph, rows), false, 'idempotent');
    graph.addDirectedEdgeWithKey('missing', 'r', 'p', link());
    assert.equal(resolveRoleEdges(graph, []), false);
    assert.ok(graph.hasEdge('missing'), 'an empty lookup keeps the unresolved edge');
});

test('named role lookup uses the returned declaring scope and preserves the query role constraint', () => {
    const graph = new MultiGraph();
    graph.addNode('r', { metadata: { concept: relation } });
    graph.addNode('p', { metadata: { concept: player } });
    graph.addDirectedEdgeWithKey('named', 'r', 'p', link('host'));
    assert.equal(unresolvedRolePairs(graph).length, 1, 'short names need canonical declaring scope');
    const rows = ['base-composition:host', 'base-composition:slot'].map(label => ({ r: relation, p: player, role: { kind: 'roleType', label } }));
    assert.equal(resolveRoleEdges(graph, rows), true);
    assert.equal(graph.size, 1, 'an explicit host constraint must not acquire the player’s other roles');
    assert.equal(edgeRoleLabel(graph.getEdgeAttributes(graph.edges()[0])), 'base-composition:host');
    graph.clearEdges();
    graph.addDirectedEdgeWithKey('r:p:composition:host', 'r', 'p', link('host'));
    assert.equal(resolveRoleEdges(graph, [{ r: relation, p: player, role: { kind: 'roleType', label: 'composition:host' } }]), true);
    assert.equal(graph.size, 1, 'canonical edge key already allocated by the builder');
    assert.deepEqual(unresolvedRolePairs(graph), []);
});
