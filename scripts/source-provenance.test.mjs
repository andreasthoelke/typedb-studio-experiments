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
const exec = promisify(execFile);
test('source heading extracts title and contiguous comments', () => {
    assert.deepEqual(sourceHeading('# ─ 6f · Fill the slots\n# Keep the identity\n# when moving.\nmatch'), {title:'6f · Fill the slots',comment:'Keep the identity\nwhen moving.'});
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
});
