import test from 'node:test';
import assert from 'node:assert/strict';
import { graphShortcut } from '../src/framework/util/graph-shortcuts.ts';
const key = (name, extra={}) => ({key:name,ctrlKey:false,metaKey:false,altKey:false,isComposing:false,defaultPrevented:false,repeat:false,...extra});
test('graph shortcut map includes navigation, live view, saving, finder and help',()=>{
 for(const [name,action] of [['Enter','focus'],['r','relayout'],['h','previous'],['l','next'],['Backspace','live'],['s','snap'],['/','find'],['?','help']]) assert.equal(graphShortcut(key(name)),action);
 for(const name of ['Delete','Escape','H','L','j']) assert.equal(graphShortcut(key(name)),null);
});
test('browser chords, composition, consumed events and held keys cannot trigger graph actions',()=>{
 for(const flag of ['ctrlKey','metaKey','altKey','isComposing','defaultPrevented','repeat']) assert.equal(graphShortcut(key('s',{[flag]:true})),null);
});
