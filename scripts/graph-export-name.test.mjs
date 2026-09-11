import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const file = new URL('../src/framework/util/graph-export-name.ts', import.meta.url);
const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace('"./graph-query"', JSON.stringify(new URL('../src/framework/util/graph-query.ts', import.meta.url).href));
const { graphExportBaseName } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const types = [{label:'scene',kind:'entityType'}, {label:'take',kind:'entityType'},
    {label:'scene-take',kind:'relationType'}, {label:'title',kind:'attributeType'}];

test('export names use distinct entity and relation names in query order, ignoring literals/comments/variables', () => {
    assert.equal(graphExportBaseName('match $take isa scene, has title "take"; # take\n scene-take (scene: $take); $other isa! scene;', types), 'scene-scene-take');
    assert.equal(graphExportBaseName('match $t isa take; $s isa scene; scene-take (scene: $s, take: $t);', types), 'take-scene-scene-take');
});

test('schema, attribute-only and dynamically typed queries get useful fallback names', () => {
    assert.equal(graphExportBaseName('match $type label scene-take;', types), 'scene-take');
    assert.equal(graphExportBaseName('match $a isa title;', types), 'title');
    assert.equal(graphExportBaseName('match $item isa! $type;', types, [types[0]]), 'scene');
    assert.equal(graphExportBaseName('', [], []), 'graph');
});

test('names remain filename-safe and bounded in bytes, including Unicode', () => {
    const label = '日本語'.repeat(40);
    const result = graphExportBaseName('', [], [{label,kind:'entityType'}]);
    assert.ok(Buffer.byteLength(result) <= 160);
    assert.ok(result.length > 0);
    assert.equal(graphExportBaseName('', [], [{label:'../../a/b',kind:'entityType'}]), 'a-b');
});
