import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPane, nextPaneInCycle, paneAction, paneCycleOrder, paneEscalation, panePrefix } from '../src/framework/util/pane-focus.ts';

const key = (over = {}) => ({ key: 'w', code: 'KeyW', ctrlKey: false, metaKey: false, altKey: false,
    shiftKey: false, isComposing: false, defaultPrevented: false, repeat: false, ...over });
const pane = (id, left, top, width, height) => ({ id, rect: { left, top, width, height } });

/** The query route as it actually renders: the tool window down the left, the
 *  editor above, and the graph beside the side panel below it. */
const queryRoute = () => [
    pane('tool', 0, 0, 300, 900),
    pane('query', 300, 0, 1300, 300),
    pane('graph', 300, 300, 900, 600),
    pane('explorer', 1200, 300, 400, 300),
    pane('panel', 1200, 600, 400, 300),
];

test('Ctrl-w is the prefix, and only Ctrl-w', () => {
    assert.equal(panePrefix(key({ ctrlKey: true })), true);
    assert.equal(panePrefix(key({ ctrlKey: true, shiftKey: true })), true, 'Vim ignores Shift on the prefix');
    assert.equal(panePrefix(key({ ctrlKey: true, key: 'ẇ', code: 'KeyW' })), true, 'Layout-shifted key, physical W');
    assert.equal(panePrefix(key()), false, 'Plain w types a w');
    assert.equal(panePrefix(key({ metaKey: true, ctrlKey: true })), false, 'Cmd-W still closes the tab');
    assert.equal(panePrefix(key({ ctrlKey: true, altKey: true })), false);
    assert.equal(panePrefix(key({ ctrlKey: true, repeat: true })), false, 'Held Ctrl-w must not re-arm');
    assert.equal(panePrefix(key({ ctrlKey: true, defaultPrevented: true })), false);
});

test('the key after the prefix is a motion, a jump, or a cancel', () => {
    assert.equal(paneAction(key({ key: 'h' })), 'left');
    assert.equal(paneAction(key({ key: 'j' })), 'down');
    assert.equal(paneAction(key({ key: 'k' })), 'up');
    assert.equal(paneAction(key({ key: 'l' })), 'right');
    assert.equal(paneAction(key({ key: 'l', ctrlKey: true })), 'right', 'Vim accepts <c-w><c-l> too');
    assert.equal(paneAction(key({ key: 'H', shiftKey: true })), 'farLeft', 'Shifted motions go as far as they can');
    assert.equal(paneAction(key({ key: 'L', shiftKey: true })), 'farRight');
    assert.equal(paneAction(key({ key: 'p' })), 'previous');
    assert.equal(paneAction(key({ key: 'w' })), 'cycle');
    assert.equal(paneAction(key({ key: 'g' })), 'jump:graph');
    assert.equal(paneAction(key({ key: 'e' })), 'jump:explorer');
    assert.equal(paneAction(key({ key: 'b' })), 'jump:panel');
    assert.equal(paneAction(key({ key: 't' })), 'jump:tool');
    assert.equal(paneAction(key({ key: 'q' })), 'jump:query');
    assert.equal(paneAction(key({ key: 'Escape' })), 'cancel');
    assert.equal(paneAction(key({ key: 'x' })), 'cancel', 'An unknown key ends the chord, never falls through');
    assert.equal(paneAction(key({ key: 'Control', ctrlKey: true })), null, 'A bare modifier is not the chord yet');
    assert.equal(paneAction(key({ key: 'Shift', shiftKey: true })), null);
    assert.equal(paneAction(key({ key: 'h', metaKey: true })), null, 'Browser chords stay with the browser');
    assert.equal(paneAction(key({ key: 'h', altKey: true })), null);
});

test('motions follow the live rects of the query route', () => {
    const panes = queryRoute();
    assert.equal(nextPane(panes, 'graph', 'left'), 'tool');
    assert.equal(nextPane(panes, 'graph', 'right'), 'explorer', 'The upper neighbour, not the lower one');
    assert.equal(nextPane(panes, 'graph', 'up'), 'query');
    assert.equal(nextPane(panes, 'explorer', 'down'), 'panel');
    assert.equal(nextPane(panes, 'panel', 'up'), 'explorer');
    assert.equal(nextPane(panes, 'panel', 'left'), 'graph');
    assert.equal(nextPane(panes, 'query', 'down'), 'graph', 'Shares most of the editor\'s bottom edge; the narrow Explorer does not');
    assert.equal(nextPane(panes, 'tool', 'right'), 'graph', 'Same reason: the graph abuts most of the tool window\'s right edge');
});

test('an edge motion has no pane, which is what escalates to the window manager', () => {
    const panes = queryRoute();
    assert.equal(nextPane(panes, 'tool', 'left'), null, 'Left of the tool window is the schema browser window');
    assert.equal(nextPane(panes, 'explorer', 'right'), null, 'Right of the side panel is Neovim');
    assert.equal(nextPane(panes, 'panel', 'right'), null);
    assert.equal(nextPane(panes, 'query', 'up'), null);
    assert.equal(nextPane(panes, 'panel', 'down'), null);
    assert.equal(nextPane(panes, 'missing', 'left'), null, 'An unregistered origin never guesses');
    assert.deepEqual(paneEscalation, { left: 'west', right: 'east', up: 'north', down: 'south' });
});

test('H and L are window level, so they never resolve to a pane', () => {
    // No pane lookup happens for these: the service escalates them directly,
    // because `h`/`l` already walk the panes and the page's right edge is
    // shared by the full-width editor and the narrow side panel.
    assert.equal(paneAction(key({ key: 'H', shiftKey: true })), 'farLeft');
    assert.equal(paneAction(key({ key: 'L', shiftKey: true })), 'farRight');
    assert.equal(paneAction(key({ key: 'h' })), 'left', 'Unshifted stays pane level');
    assert.equal(paneAction(key({ key: 'l' })), 'right');
});

test('the schema route registers fewer panes and its edges move outwards', () => {
    // No query editor pane, and the side panel docked below the graph.
    const panes = [
        pane('tool', 0, 0, 300, 900),
        pane('graph', 300, 0, 1300, 600),
        pane('explorer', 300, 600, 650, 300),
        pane('panel', 950, 600, 650, 300),
    ];
    assert.equal(nextPane(panes, 'graph', 'up'), null, 'Nothing above once the editor pane is absent');
    assert.equal(nextPane(panes, 'graph', 'down'), 'explorer', 'Docking below changes the answer with no layout table');
    assert.equal(nextPane(panes, 'explorer', 'right'), 'panel');
    assert.equal(nextPane(panes, 'panel', 'right'), null);
});

test('the cycle is reading order regardless of registration order', () => {
    const panes = queryRoute();
    assert.deepEqual(paneCycleOrder([...panes].reverse()), ['tool', 'query', 'graph', 'explorer', 'panel']);
    assert.equal(nextPaneInCycle(panes, 'tool'), 'query');
    assert.equal(nextPaneInCycle(panes, 'panel'), 'tool', 'Wraps');
    assert.equal(nextPaneInCycle(panes, null), 'tool', 'No origin yet starts at the first pane');
    assert.equal(nextPaneInCycle(panes, 'missing'), 'tool');
    assert.equal(nextPaneInCycle([], 'graph'), null);
});
