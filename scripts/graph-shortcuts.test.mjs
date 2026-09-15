import test from 'node:test';
import assert from 'node:assert/strict';
import { graphShortcut } from '../src/framework/util/graph-shortcuts.ts';
const key = (name, extra = {}) => ({key:name,code:'',ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,isComposing:false,defaultPrevented:false,repeat:false,...extra});
test('graph commands, modal movement and Space snap sequences are distinct', () => {
    for (const [name,action] of [['+','zoomIn'],['=','zoomIn'],['-','zoomOut'],['Enter','focus'],['r','relayout'],['Backspace','live'],['s','snap'],['/','find'],['?','help'],['c','caret'],[',','hintLeader'],['f','hints'],['d','deleteLeader'],['Escape','clear'],[' ','leader']]) assert.equal(graphShortcut(key(name)),action);
    for (const [name,action] of [['h','left'],['l','right'],['j','down'],['k','up'],['n','downLeft'],['o','upRight'],['y','upLeft'],['.','downRight']]) {
        assert.equal(graphShortcut(key(name)),null);
        for (const mode of ['caret']) assert.equal(graphShortcut(key(name),mode),action);
    }
    for (const mode of ['normal','caret']) {
        assert.equal(graphShortcut(key('h'),mode,'space'),'previous');
        assert.equal(graphShortcut(key('l'),mode,'space'),'next');
        assert.equal(graphShortcut(key('d'),mode,'space'),'cancelLeader');
        assert.equal(graphShortcut(key('Escape'),mode,'space'),'clear');
    }
});
test('Ctrl camera/reset allowlist preserves other browser modifiers and composition', () => {
    for (const [name,action] of [['e','panDown'],['y','panUp'],['h','panLeft'],['l','panRight'],['o','back'],['[','clear']]) {
        assert.equal(graphShortcut(key(name,{ctrlKey:true})),action);
        assert.equal(graphShortcut(key(name,{ctrlKey:true,shiftKey:true})),null);
        for(const flag of ['metaKey','altKey','isComposing','defaultPrevented']) assert.equal(graphShortcut(key(name,{ctrlKey:true,[flag]:true})),null);
    }
    for (const name of ['d','r','s','+','-','c','v']) assert.equal(graphShortcut(key(name,{ctrlKey:true})),null);
    for (const flag of ['metaKey','altKey','isComposing','defaultPrevented']) assert.equal(graphShortcut(key('s',{[flag]:true})),null);
});
test('motion/camera keys repeat but deletion, modes, saves and snap sequences never do', () => {
    for (const name of ['h','j','k','l','n','o','y','.','+','-']) assert.ok(graphShortcut(key(name,{repeat:true}),'caret'));
    assert.equal(graphShortcut(key('e',{ctrlKey:true,repeat:true})),'panDown');
    assert.equal(graphShortcut(key('o',{ctrlKey:true,repeat:true}),'caret'),'back');
    for (const name of ['c','v','d','s','r',' ','Enter','Backspace','Escape']) assert.equal(graphShortcut(key(name,{repeat:true}),'caret'),null);
    assert.equal(graphShortcut(key('l',{repeat:true}),'caret','space'),null);
});
test('Shift directions nudge; Ctrl-Shift adds; original Ctrl pan/history maps return',()=>{
    for(const [name,action] of [['h','left'],['j','down'],['k','up'],['l','right'],['n','downLeft'],['o','upRight'],['y','upLeft'],['.','downRight']]) {
        assert.equal(graphShortcut(key(name,{shiftKey:true}),'caret'),`nudge:${action}`);
        assert.equal(graphShortcut(key(name,{shiftKey:true,repeat:true}),'caret'),`nudge:${action}`);
        assert.equal(graphShortcut(key(name,{shiftKey:true,ctrlKey:true}),'caret'),action);
        assert.equal(graphShortcut(key(name,{shiftKey:true}),'normal'),null);
        for(const flag of ['metaKey','isComposing','defaultPrevented'])
            assert.equal(graphShortcut(key(name,{shiftKey:true,[flag]:true}),'caret'),null);
    }
    assert.equal(graphShortcut(key('>',{shiftKey:true,ctrlKey:true}),'caret'),'downRight');
    assert.equal(graphShortcut(key('g'),'caret'),'historyLeader');
    assert.equal(graphShortcut(key(';'),'caret','g'),'back');
});

test('modifier motions support Shift and the macOS Option character fallback', () => {
    for (const [name,code,alt,action] of [['H','KeyH','˙','left'],['J','KeyJ','∆','down'],['K','KeyK','˚','up'],['L','KeyL','¬','right'],
        ['N','KeyN','˜','downLeft'],['O','KeyO','ø','upRight'],['Y','KeyY','¥','upLeft'],['>','Period','≥','downRight']]) {
        assert.equal(graphShortcut(key(name,{code,shiftKey:true}),'caret'),`nudge:${action}`);
        assert.equal(graphShortcut(key(alt,{code,altKey:true}),'caret'),action);
        assert.equal(graphShortcut(key(alt,{code,altKey:true}),'normal'),null);
        for(const flag of ['metaKey','isComposing','defaultPrevented']) {
            assert.equal(graphShortcut(key(name,{code,shiftKey:true,[flag]:true}),'caret'),null);
        }
    }
    assert.equal(graphShortcut(key('>',{code:'Period'}),'caret'),null,'Unmodified punctuation remains layout-aware');
    assert.equal(graphShortcut(key('>',{code:'Period',shiftKey:true}),'normal'),null);
    assert.equal(graphShortcut(key('v'),'caret'),null);
    assert.equal(graphShortcut(key('f'),'normal','comma'),'hints');
    assert.equal(graphShortcut(key('d'),'caret','comma'),'cancelLeader');
});

test('zz centres the caret with an independent prefix and does not repeat', () => {
    assert.equal(graphShortcut(key('z')),'centreLeader');
    for (const mode of ['normal','caret']) {
        assert.equal(graphShortcut(key('z'),mode,'z'),'centreCaret');
        for(const [keyName,action] of [['t','caretTop'],['b','caretBottom'],['h','caretLeft'],['l','caretRight']]) {
            assert.equal(graphShortcut(key(keyName),mode,'z'),action);
            assert.equal(graphShortcut(key(keyName,{repeat:true}),mode,'z'),null);
        }
        assert.equal(graphShortcut(key('Escape'),mode,'z'),'clear');
        assert.equal(graphShortcut(key('z',{repeat:true}),mode,'z'),null);
    }
});

test('deletion waits for dd or d Enter; cancellation and repeats never delete', () => {
    for (const mode of ['normal','caret']) {
        assert.equal(graphShortcut(key('d'),mode),'deleteLeader');
        assert.equal(graphShortcut(key('d'),mode,'d'),'removeCaret');
        assert.equal(graphShortcut(key('Enter'),mode,'d'),'remove');
        for (const name of ['Escape','l','s']) assert.equal(graphShortcut(key(name),mode,'d'),'cancelLeader');
        assert.equal(graphShortcut(key('[',{ctrlKey:true}),mode,'d'),'cancelLeader');
        for (const name of ['d','Enter']) assert.equal(graphShortcut(key(name,{repeat:true}),mode,'d'),null);
        assert.equal(graphShortcut(key('D',{shiftKey:true}),mode,'d'),null);
    }
});
