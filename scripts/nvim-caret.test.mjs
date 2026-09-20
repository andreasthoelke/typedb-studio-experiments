import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createViewerServer } from './viewer-server.mjs';

test('real Neovim buffer mappings preserve source motions and send paragraph-local caret events', {timeout:15000}, async t=>{
 const server=createViewerServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://localhost:${server.address().port}`;
 const root=await mkdtemp(join(tmpdir(),'studio-nvim-caret-'));
 const abort=new AbortController();
 t.after(async()=>{abort.abort();server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});});
 const response=await fetch(origin+'/api/viewer/events',{signal:abort.signal});
 const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
 const events=[];let buffer='';
 const reading=(async()=>{try {while(true){const {value,done}=await reader.read();if(done)return;buffer+=value;
  let split;while((split=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,split);buffer=buffer.slice(split+2);
   const data=event.split('\n').find(l=>l.startsWith('data: '));if(data){assert.match(event,/event: (caret|control)/);events.push(JSON.parse(data.slice(6)));}}
 }}catch(error){if(!abort.signal.aborted)throw error;}})();
 const script=join(root,'test.lua');
 await writeFile(script,String.raw`
vim.g.mapleader = ' '
vim.api.nvim_buf_set_name(0, vim.env.STUDIO_TEST_ROOT .. '/source.tql')
vim.api.nvim_buf_set_lines(0, 0, -1, false, {
 'entity depiction;', '', 'entity café, owns referent-id;', '',
 '$of isa occurrence, has occurrence-id "occ-fear";',
 'occurrence-of (occurrence: $of, subject: $fear);', '',
 '$x isa café, has referent-id "😀";' })
vim.b.typedb_database = 'navigation-test'
vim.cmd([[
function! Tdb_MainStartBindingForw()
  call cursor(3, 8)
endfunction
function! Tdb_MainStartBindingBackw()
  call cursor(1, 8)
endfunction
function! ScrollOff(n)
  let g:last_scrolloff = a:n
endfunction
]])
local helper = dofile(vim.env.STUDIO_TEST_REPO .. '/contrib/nvim/typedb_graph.lua')
helper.setup({url=vim.env.STUDIO_TEST_URL, mapping=false, control_prefix='<leader>gv'})
vim.api.nvim_win_set_cursor(0, {1, 7})
local function press(key)
 vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(key,true,false,true),'xt',false)
 vim.wait(350, function() return false end, 10)
end
press('<C-n>')
assert(vim.api.nvim_win_get_cursor(0)[1] == 3 and vim.g.last_scrolloff == 16)
press('<C-p>')
assert(vim.api.nvim_win_get_cursor(0)[1] == 1 and vim.g.last_scrolloff == 10)
vim.api.nvim_win_set_cursor(0, {6, 0})
press('<CR>')
assert(vim.deep_equal(vim.api.nvim_win_get_cursor(0), {6,0}), 'Enter moved the source cursor')
vim.api.nvim_win_set_cursor(0, {8, #'$x isa café, has referent-id "😀'})
press('<CR>')
assert(vim.fn.maparg('<CR>','i') == '', 'Insert-mode Enter was overwritten')
press('geo')
local before = vim.api.nvim_win_get_cursor(0)
press('<Space>gvzz')
press('<Space>gv<C-e>')
press('<Space>gvs')
press('<Space>gvr')
assert(vim.deep_equal(vim.api.nvim_win_get_cursor(0), before), 'Viewer controls moved the source cursor')
vim.cmd('enew!')
vim.api.nvim_buf_set_name(0, vim.env.STUDIO_TEST_ROOT .. '/notes.txt')
vim.wait(50, function() return false end)
assert(vim.fn.maparg('<CR>','n') == '', 'Non-TypeQL buffer was remapped')
assert(vim.fn.maparg('geo','n') == '' and vim.fn.maparg('<Space>gvzz','n') == '', 'Viewer mappings leaked to another buffer')
vim.cmd('qa!')
`);
 const child=spawn(process.env.NVIM_PATH||'nvim',['--headless','-u','NONE','-l',script],{env:{...process.env,STUDIO_TEST_ROOT:root,STUDIO_TEST_REPO:process.cwd(),STUDIO_TEST_URL:origin}});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 t.after(()=>{if(child.exitCode===null)child.kill();});
 const [code]=await once(child,'exit');assert.equal(code,0,output);
 abort.abort();await reading;
 assert.equal(events.length,9,JSON.stringify(events));
 assert.deepEqual(events.slice(0,5).map(e=>e.schemaOnly),[true,true,false,false,false]);
 assert.deepEqual(events.slice(5).map(e=>e.command),['centreCaret','panDown','snap','relayout']);
 assert.equal(events[5].database,'navigation-test');assert.ok(events[7].projectTempDirectory.startsWith('/'));
 assert.equal(events[0].source,'entity café, owns referent-id;');assert.equal(events[0].column,7);
 assert.equal(events[2].source,'$of isa occurrence, has occurrence-id "occ-fear";\noccurrence-of (occurrence: $of, subject: $fear);');
 assert.equal(events[2].line,1);assert.equal(events[2].database,'navigation-test');
 assert.equal(events[3].column,'$x isa café, has referent-id "😀'.length,'Lua sends UTF-16, not byte offsets');
});
