import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createViewerServer } from './viewer-server.mjs';
import { sourceHeading } from '../src/framework/util/graph-source.ts';
import { snapTitleBase, splitPlainHeading, titledSnapLabel } from '../src/framework/util/graph-title.mjs';
const exec = promisify(execFile);
test('source heading extracts title and contiguous comments', () => {
    assert.deepEqual(sourceHeading('# ─ 6f · Fill the slots\n# Keep the identity\n# when moving.\nmatch'), {title:'6f · Fill the slots',comment:'Keep the identity\nwhen moving.'});
    assert.equal(sourceHeading('define\n# ─ 9a ─ Override entity + attachment. ───────\nattribute pos-x value double;').title, '9a ─ Override entity + attachment.');
});
const plainCases = [
    ['1. Four things we can point at in the painting. These ids are shared by both readings.', '1. Four things we can point at in the painting', 'These ids are shared by both readings.'],
    ['2. The source is a retained public-domain image, not an authority.', '2. The source is a retained public-domain image', 'not an authority.'],
    ['The artwork vocabulary: two figures, two motifs', 'The artwork vocabulary', 'two figures, two motifs'],
    ['Artwork tour — two readings of one painting.', 'Artwork tour', 'two readings of one painting.'],
    ['6a. Which mental states exist? Expect two.', '6a. Which mental states exist?', 'Expect two.'],
    ['Shared foundation (reused unchanged)', 'Shared foundation (reused unchanged)', ''],
    ['Version 1.2 is kept', 'Version 1.2 is kept', ''],
];
test('plain headings split the leading words from the comment', () => {
    for (const [line, title, comment] of plainCases) assert.deepEqual(splitPlainHeading(line), {title, comment}, line);
    assert.deepEqual(sourceHeading('# 4. An alternative interpretation. Accepted within its Take.\n# Second line.\nmatch\n  $x isa oak;'),
        {title:'4. An alternative interpretation', comment:'Accepted within its Take.\nSecond line.'});
    assert.deepEqual(sourceHeading('define\n# ═══\n# Shared foundation\nattribute origin value string;'), {title:'Shared foundation', comment:''});
    assert.deepEqual(sourceHeading('match $x isa oak;'), {title:'', comment:''});
});
test('Neovim capture reads plain paragraph headers like the browser', {timeout:15000}, async t => {
    const dir = await mkdtemp(join(tmpdir(),'studio-plain-')), script = join(dir,'capture.lua');
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const module = join(process.cwd(),'contrib/nvim/typedb_graph.lua');
    await writeFile(script, `local m = dofile(${JSON.stringify(module)})
local out = {}
for _, case in ipairs(vim.json.decode(${JSON.stringify(JSON.stringify(plainCases))})) do
  local title, comment = m.split_heading(case[1]); table.insert(out, { title, comment })
end
vim.api.nvim_buf_set_name(0, ${JSON.stringify(join(dir,'tour.tql'))})
vim.api.nvim_buf_set_lines(0, 0, -1, false, { '# Intro, not this one.', '', '# 3. One shared reading: the figures attend.', '# Keep going.', 'match', '  $x isa oak;', '' })
vim.api.nvim_win_set_cursor(0, { 5, 0 })
table.insert(out, m.source_location('# 3. One shared reading: the figures attend.\\n# Keep going.\\nmatch\\n  $x isa oak;'))
table.insert(out, m.source_location('match\\n  $x isa oak;'))
io.stdout:write(vim.json.encode(out))`);
    const {stdout} = await exec('/opt/homebrew/bin/nvim',['--headless','-u','NONE','-n','-l',script]);
    const out = JSON.parse(stdout);
    assert.deepEqual(out.slice(0, plainCases.length), plainCases.map(([, title, comment]) => [title, comment]));
    for (const location of out.slice(plainCases.length)) {
        assert.equal(location.title, '3. One shared reading');
        assert.equal(location.comment, 'the figures attend.\nKeep going.');
        assert.equal(location.line, 3);
        assert.equal(location.anchor, '# 3. One shared reading: the figures attend.');
    }
});
test('titled snaps use four-character words, a bounded length and a single-digit index', () => {
    assert.equal(snapTitleBase('8d · Read the pattern bindings.'), '8d-read-the-patt-bind');
    assert.equal(snapTitleBase('9a ─ Override entity + attachment. ─────'), '9a-over-enti-atta');
    const long = snapTitleBase('Extraordinarily many considerable words describing the pattern roles and scenes');
    assert.ok(long.length <= 28 && long.startsWith('extr-many-cons'), long);
    assert.equal(snapTitleBase('── ──'), '');
    assert.equal(titledSnapLabel('8d-read-the-patt-bind-0.snap.json', '8d · Read the pattern bindings.'), '8d read the patt bind 0');
    assert.equal(titledSnapLabel('motivation-00.snap.json', '8d · Read the pattern bindings.'), null);
});
test('source jump locates a moved header safely in a real isolated Neovim', {timeout:15000}, async t => {
    const dir = await mkdtemp(join(tmpdir(),'studio-source-')), socket = join(dir,'nvim.sock'), file = join(dir,"tour's % file.tql");
    const anchor = '# ─ 6f · Fill the slots';
    await writeFile(file, `# inserted above\n\n${anchor}\n# Keep the identity\nmatch\n`);
    const nvim = spawn('/opt/homebrew/bin/nvim',['--headless','-u','NONE','-n','--listen',socket], {stdio:'ignore'});
    const server = createViewerServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(async()=>{nvim.kill();server.closeAllConnections();server.close();await rm(dir,{recursive:true,force:true});});
    for(let i=0;i<100;i++){try{await access(socket);break;}catch{await new Promise(r=>setTimeout(r,20));}}
    const sourceLocation = {path:file,line:1,anchor,title:'6f · Fill the slots',comment:'Keep the identity',query:'match',server:socket};
    const response=await fetch(`http://localhost:${server.address().port}/api/viewer/source`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceLocation})});
    assert.equal(response.status,200,await response.text());
    const result=await exec('/opt/homebrew/bin/nvim',['--server',socket,'--remote-expr',`json_encode([expand('%:p'),line('.')])`]);
    assert.deepEqual(JSON.parse(result.stdout),[file,3]);
    const module=join(process.cwd(),'contrib/nvim/typedb_graph.lua');
    const lua=`(function() local m=dofile(${JSON.stringify(module)}); return vim.json.encode(m.source_location('match')) end)()`;
    const captured=await exec('/opt/homebrew/bin/nvim',['--server',socket,'--remote-expr',`luaeval('${lua.replaceAll("'","''")}')`]);
    assert.equal(JSON.parse(captured.stdout).title,'6f · Fill the slots');
    assert.equal(JSON.parse(captured.stdout).line,3);
    // The schema runner prepends a bare define line that is not in the buffer.
    const defined=`(function() local m=dofile(${JSON.stringify(module)}); return vim.json.encode(m.source_location('define\\n${anchor}\\n# Keep the identity\\nmatch')) end)()`;
    const withDefine=await exec('/opt/homebrew/bin/nvim',['--server',socket,'--remote-expr',`luaeval('${defined.replaceAll("'","''")}')`]);
    assert.equal(JSON.parse(withDefine.stdout).title,'6f · Fill the slots');
});
