import assert from 'node:assert/strict';

/** `<c-w>` pane navigation on the shared canvas surface.
 *
 *  The standalone surface registers graph/explorer/panel but neither of the
 *  page-level panes, so this covers the motions, the chord's ownership of the
 *  following key, and the edge escalation. The tool-window and query-editor
 *  panes are only reachable on the live routes; see the handoff's manual list.
 *
 *  Directions are derived from the live rects rather than written down,
 *  because the customise check docks the side panel before this runs: the
 *  panel is beside the Explorer in one dock and below it in the other. A
 *  hardcoded `j` here would be testing the previous check's dock choice.
 *  Deriving them is the assertion that matters anyway — that the motion
 *  follows where the pane actually is.
 *
 *  `escalated` collects the directions the bridge was asked to hand to the
 *  window manager, so the check can assert a real edge motion left the page
 *  instead of silently doing nothing. */
export async function checkPaneFocus(page, escalated, label) {
    // The static `tsPane` attribute stays in the DOM, so it names the pane
    // without reaching into the component.
    const active = () => page.evaluate(() => document.querySelector('.pane-active')?.getAttribute('tsPane') ?? null);
    const chord = async key => { await page.keyboard.press('Control+w'); await page.keyboard.press(key); };
    const geometry = async () => Object.fromEntries(await page.evaluate(() =>
        [...document.querySelectorAll('[tsPane]')].map(element => {
            const rect = element.getBoundingClientRect();
            return [element.getAttribute('tsPane'), { left: rect.left, top: rect.top, width: rect.width, height: rect.height }];
        })));

    const panes = await geometry();
    for (const id of ['graph', 'explorer', 'panel']) assert.ok(panes[id], `${label}: the ${id} pane is registered`);
    const centre = rect => [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const towards = (from, to) => {
        const [fx, fy] = centre(panes[from]), [tx, ty] = centre(panes[to]);
        return Math.abs(tx - fx) >= Math.abs(ty - fy) ? (tx > fx ? 'l' : 'h') : (ty > fy ? 'j' : 'k');
    };

    // The graph owns the keyboard at rest; entering the Explorer must hand it over.
    await page.evaluate(() => window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser?.endNavigation());
    await chord('e');
    assert.equal(await active(), 'explorer', `${label}: Ctrl+w e focuses the Explorer`);
    assert.ok(await page.evaluate(() => document.querySelector('.explorer-pane')?.contains(document.activeElement)),
        `${label}: focus really lands inside the Explorer, which is what Vimium scrolls`);

    await chord(towards('explorer', 'panel'));
    assert.equal(await active(), 'panel', `${label}: a motion towards the tabbed panel reaches it in either dock`);
    await chord(towards('panel', 'explorer'));
    assert.equal(await active(), 'explorer', `${label}: and back again`);
    await chord(towards('explorer', 'graph'));
    assert.equal(await active(), 'graph', `${label}: a motion towards the graph reaches it`);

    // Vim's own chord history, within the page.
    await chord('p');
    assert.equal(await active(), 'explorer', `${label}: Ctrl+w p returns to the previous pane`);

    // The key after the prefix belongs to the chord, never to the graph. If
    // the canvas saw these motion keys it would move the camera.
    const camera = () => page.evaluate(() => {
        const visualiser = window.ng.getComponent(document.querySelector('ts-graph-canvas')).visualiser;
        return visualiser ? { ...visualiser.sigma.getCamera().getState() } : null;
    });
    const before = await camera();
    await chord('g');
    assert.equal(await active(), 'graph', `${label}: Ctrl+w g returns to the graph`);
    assert.deepEqual(await camera(), before, `${label}: a chord key never reaches the graph's own shortcuts`);

    // An unknown key ends the chord rather than falling through to the graph.
    // Deliberately `n` and not `x`: Vimium binds x to removeTab, and x is not
    // in the site's pass-through list, so probing with it closes the tab
    // before any assertion runs. Any key used here must be one Vimium passes.
    await page.keyboard.press('Control+w');
    await page.keyboard.press('n');
    assert.equal(await active(), 'graph', `${label}: an unknown chord key changes nothing`);
    assert.deepEqual(await camera(), before, `${label}: including a cancelled chord`);

    // H and L never resolve to a pane: they are window level by definition, so
    // they escalate from wherever the cursor happens to be.
    const farFrom = escalated.length;
    await chord('H');
    await chord('L');
    for (let attempt = 0; attempt < 40 && escalated.length < farFrom + 2; attempt++) await page.waitForTimeout(50);
    assert.deepEqual(escalated.slice(farFrom), ['far-west', 'far-east'],
        `${label}: Ctrl+w H/L cross to the outermost window without touching panes`);
    assert.equal(await active(), 'graph', `${label}: and leave the page's own focus where it was`);

    // Past the outermost pane there is nothing left on the page, which is the
    // case that must reach the window manager instead of doing nothing.
    const outermost = Object.entries(panes).sort((a, b) =>
        (b[1].left + b[1].width) - (a[1].left + a[1].width))[0][0];
    const escalations = escalated.length;
    await chord(outermost === 'graph' ? 'g' : outermost === 'explorer' ? 'e' : 'b');
    await chord('l');
    // The escalation is a fire-and-forget POST; give it a moment to arrive.
    for (let attempt = 0; attempt < 40 && escalated.length === escalations; attempt++) await page.waitForTimeout(50);
    assert.deepEqual(escalated.slice(escalations), ['east'],
        `${label}: a motion past the ${outermost} pane is handed east to the window manager`);

    console.log(`PASS ${label}: Ctrl+w pane motions, direct jumps, chord ownership and edge escalation`);
}
