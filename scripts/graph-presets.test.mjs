import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGraphPresets, exportGraphPresets, mergeGraphPresets } from '../src/framework/util/graph-presets.ts';
const inkText = readFileSync(new URL('../contrib/graph-presets/munsell-ink.json', import.meta.url), 'utf8');
const paperText = readFileSync(new URL('../contrib/graph-presets/munsell-paper.json', import.meta.url), 'utf8');

test('portable presets round-trip with backgrounds and all appearance options', () => {
    const presets = [...parseGraphPresets(inkText), ...parseGraphPresets(paperText)];
    assert.deepEqual(parseGraphPresets(exportGraphPresets(presets)), presets);
    assert.deepEqual(parseGraphPresets(JSON.stringify(presets[0])), [presets[0]]);
    assert.deepEqual(parseGraphPresets(JSON.stringify(presets)), presets);
    assert.equal(presets[0].background.color1, '#121416');
    assert.equal(presets[1].background.color1, '#E3E6E9');
});

test('duplicate imports preserve existing styles and get unique names', () => {
    const existing = parseGraphPresets(inkText);
    const incoming = [existing[0], { ...existing[0], name: 'Munsell Ink (2)' }];
    const merged = mergeGraphPresets(existing, incoming);
    assert.deepEqual(merged.map(p => p.name), ['Munsell Ink', 'Munsell Ink (2)', 'Munsell Ink (2) (2)']);
    merged[1].kindStyles.entity.color = '#000000';
    assert.notEqual(existing[0].kindStyles.entity.color, '#000000');
    assert.notEqual(merged[0].kindStyles.entity.color, '#000000');
});

test('rejects malformed or unsafe imports before a collection can be merged', () => {
    const valid = parseGraphPresets(inkText)[0];
    const invalids = [null, [], {}, { format: 'other', version: 1, presets: [valid] },
        { format: 'typedb-studio-graph-presets', version: 2, presets: [valid] },
        { ...valid, fillOpacity: 10 }, { ...valid, kindStyles: { entity: { shape: 'script' } } },
        { ...valid, kindStyles: { entity: { color: 'url(https://example.com)' } } },
        { ...valid, background: { ...valid.background, color1: 'red);background:url(x)' } },
        { ...valid, labelsVisible: 'true' }, { ...valid, name: '' },
        { ...valid, typeStyles: JSON.parse('{"__proto__":{"color":"#ffffff"}}') },
        [valid, { ...valid, degreeScaling: null }]];
    for (const input of invalids) assert.throws(() => parseGraphPresets(JSON.stringify(input)));
    assert.throws(() => parseGraphPresets('x'.repeat(1024 * 1024 + 1)));
});


test('dash styles round-trip at kind, type, default-edge and per-edge scopes', () => {
 const preset=parseGraphPresets(inkText)[0];
 preset.kindStyles.entity.lineStyle='dotted';
 preset.typeStyles.scene={lineStyle:'long-dash'};
 preset.defaultEdgeLineStyle='short-dash';
 preset.edgeLineStyles={owns:'dash-dot',links:'solid','composition:host':'dotted'};
 preset.edgeLabelColors['composition:host']='#2468ac';
 preset.kindStyles.entity.lineThickness=1.5;
 preset.typeStyles.scene.lineThickness=3;
 preset.defaultEdgeLineThickness=0.5;
 preset.edgeLineThicknesses={owns:4,'composition:host':2.5};
 assert.deepEqual(parseGraphPresets(exportGraphPresets([preset])),[preset]);
 for(const invalid of [{...preset,defaultEdgeLineStyle:'invalid'},
   {...preset,edgeLineStyles:{owns:[1,2]}}, {...preset,typeStyles:{scene:{lineStyle:'bad'}}},
   {...preset,defaultEdgeLineThickness:0}, {...preset,edgeLineThicknesses:{owns:20}},
   {...preset,typeStyles:{scene:{lineThickness:-1}}}]) {
  assert.throws(()=>parseGraphPresets(JSON.stringify(invalid)));
 }
});

// Structural edits cross palette boundaries; colours do not.
const { shareThemeStructure, initialThemePair } = await import('../src/framework/util/graph-theme-pair.ts');
test('paired themes share geometry, semantic outlines and role arrows while retaining colours', () => {
    const light = structuredClone(initialThemePair.light), dark = structuredClone(initialThemePair.dark);
    light.kindStyles.entity.width = 123;
    light.typeStyles.goal.lineThickness = 2;
    light.roleArrows = { 'motivation:driver': 'relation', 'motivation:target': 'player' };
    const paired = shareThemeStructure(light, dark);
    assert.equal(paired.kindStyles.entity.width, 123);
    assert.equal(paired.kindStyles.entity.color, dark.kindStyles.entity.color);
    assert.equal(paired.typeStyles.goal.lineThickness, 2);
    assert.equal(paired.typeStyles.goal.color, dark.typeStyles.goal.color);
    assert.deepEqual(paired.roleArrows, light.roleArrows);
    assert.equal(paired.background.color1, dark.background.color1);
    assert.equal(paired.kindStyles.entity.lineStyle, 'solid');
    assert.equal(paired.kindStyles.entityType.lineStyle, 'dotted');
    assert.equal(paired.typeStyles.goal.lineStyle, undefined);
    assert.deepEqual(parseGraphPresets(exportGraphPresets([paired]))[0], paired);
});
