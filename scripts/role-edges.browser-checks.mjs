import assert from 'node:assert/strict';

/** Real read-only resolution of omitted role variables in an existing Query graph. */
export async function checkRoleEdges(page, database) {
    await page.bringToFront();
    const origin = new URL(page.url()).origin;
    await page.evaluate(() => { window.ng.getComponent(document.querySelector('ts-query-page')).bridge.neighbours = false; });
    for (const [type, expected] of [['motivation', ['driver', 'target']], ['composition', ['child', 'host', 'slot']]]) {
        const source = `match $r isa ${type}; $r links ($p); limit 12;`;
        const response = await page.request.post(origin + '/api/viewer/query', { data: { database, query: source } });
        const { id } = await response.json();
        await page.waitForFunction(({ id, expected }) => {
            const c = window.ng.getComponent(document.querySelector('ts-query-page'));
            const v = c.state.graphOutput?.visualiser;
            if (c.bridge.lastRequest?.id !== id || c.bridge.pending || c.bridge.busy || !v?.graph.size) return false;
            const links = v.graph.edges().map(e => v.graph.getEdgeAttributes(e)).filter(a => a.metadata?.dataEdge?.tag === 'links');
            return links.length && links.every(a => a.metadata.dataEdge.role?.kind === 'roleType')
                && expected.every(label => links.some(a => a.label === label));
        }, { id, expected });
        const result = await page.evaluate(() => {
            const c = window.ng.getComponent(document.querySelector('ts-query-page')), v = c.state.graphOutput.visualiser;
            v.stopLayout(); v.restoreLabels();
            return { kinds: v.graph.nodes().map(n => v.graph.getNodeAttribute(n, 'metadata').concept.kind),
                roles: v.graph.edges().map(e => v.graph.getEdgeAttributes(e)).filter(a => a.metadata?.dataEdge?.tag === 'links').map(a => a.metadata.dataEdge.role.label),
                labels: v.graph.edges().map(e => v.sigma.getEdgeDisplayData(e).label) };
        });
        assert.ok(result.kinds.every(k => k === 'entity' || k === 'relation'), 'lookup never adds role-type or attribute nodes');
        for (const role of expected) {
            assert.ok(result.roles.includes(`${type}:${role}`));
            assert.ok(result.labels.includes(role));
        }
        assert.ok(!result.labels.includes('links'), 'restoration keeps resolved labels');
    }
    console.log('PASS live motivation/composition role lookup for anonymous links, no extra nodes, scoped metadata and persistent labels');
}
