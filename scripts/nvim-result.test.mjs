import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createViewerServer } from './viewer-server.mjs';

test('Neovim paragraph adapter displays a shared result and switches views', {timeout:15000}, async t => {
    const requests = [];
    const server = createViewerServer({runExecutor:async request => {
        requests.push(request);
        if (request.query.includes('unavailable')) throw new Error('Simulated bridge failure after dispatch');
        return {...request,id:request.runId,execution:{kind:'write',status:'success'},lines:['test · write · committed','$name │ $n','──────┼───','Ann   │ 0'],
            response:{ok:{answerType:'conceptRows',answers:[{data:{name:{kind:'value',value:'Ann',valueType:'string'}}}]}}};
    }});
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    const root = await mkdtemp(join(tmpdir(),'studio-nvim-result-'));
    t.after(async () => {server.closeViewers();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});});
    const script = join(root,'test.lua');
    await writeFile(script, String.raw`
vim.g.mapleader = ' '
vim.api.nvim_buf_set_name(0, vim.env.STUDIO_TEST_ROOT .. '/source.tql')
_G.Tdb_graph = dofile(vim.env.STUDIO_TEST_REPO .. '/contrib/nvim/typedb_graph.lua')
_G.Tdb_graph.setup({url=vim.env.STUDIO_TEST_URL,mapping=false})
_G.Tdb_graph.mirror = function() error('Completed run must not be mirrored') end
vim.g.typedb_active_schema = 'test'
vim.g.data_refreshes = 0
vim.cmd([[
function! Tdb_withTransactionLines(lines)
  return ['transaction write test'] + a:lines + ['', 'commit']
endfunction
function! Tdb_update_ShowCurrentSchemaFile()
  throw 'Unexpected schema refresh'
endfunction
function! Tdb_update_ShowCurrentDataFile()
  let g:data_refreshes += 1
endfunction
function! Tdb_showLines(lines)
  let buf = nvim_create_buf(v:false, v:true)
  call nvim_buf_set_lines(buf, 0, -1, v:false, a:lines)
  let g:floatWin_win = nvim_open_win(buf, v:false, {'relative':'editor','row':1,'col':1,'width':65,'height':8})
endfunction
]])
assert(vim.fn.Tdb_runStructuredQueryShow({'insert $p isa person, has name "Ann";'}) == 1)
assert(vim.g.data_refreshes == 1)
local win = vim.g.floatWin_win
local buf = vim.api.nvim_win_get_buf(win)
assert(vim.bo[buf].syntax == '')
assert(vim.wo[win].wrap == false)
assert(vim.b[buf].tdb_result.execution.status == 'success')
vim.api.nvim_set_current_win(win)
local function press(keys) vim.api.nvim_feedkeys(keys,'xt',false) end
vim.api.nvim_win_set_cursor(win,{4,0})
press('I')
assert(vim.deep_equal(vim.api.nvim_win_get_cursor(win),{4,10}), vim.inspect(vim.api.nvim_win_get_cursor(win)))
press('Y')
assert(vim.deep_equal(vim.api.nvim_win_get_cursor(win),{4,0}))
press('gr')
assert(vim.bo[buf].syntax == 'json')
local raw = table.concat(vim.api.nvim_buf_get_lines(buf,0,-1,false),'\n')
assert(vim.json.decode(raw).response.ok.answers[1].data.name.value == 'Ann')
press('gq')
assert(vim.api.nvim_buf_get_lines(buf,0,1,false)[1] == '# Executed statement')
press('gt')
assert(vim.api.nvim_buf_get_lines(buf,0,1,false)[1] == 'test · write · committed')
local inspection = {query='match $x isa person;', database='test', instances={{type='person',attributes={name='日本 | café'}}}}
local inspectionLines = {'test · person', '', '| name        | iid |', '|-------------|-----|', '| 日本 | café | abc |'}
_G.Tdb_graph.attach_result(win,inspection,inspectionLines)
press('gt')
vim.api.nvim_win_set_cursor(win,{5,2})
press('I')
assert(vim.deep_equal(vim.api.nvim_win_get_cursor(win),{5,19}), vim.inspect(vim.api.nvim_win_get_cursor(win)))
press('Y')
assert(vim.deep_equal(vim.api.nvim_win_get_cursor(win),{5,2}))
press('gr')
local inspected = vim.json.decode(table.concat(vim.api.nvim_buf_get_lines(buf,0,-1,false),'\n'))
assert(inspected.instances[1].attributes.name == '日本 | café')
press('gq')
assert(vim.api.nvim_buf_get_lines(buf,1,2,false)[1] == inspection.query)

assert(vim.fn.Tdb_runStructuredQueryShow({'database delete test;'}) == 1)
assert(vim.g.tdb_last_graph_execution.status == 'error')
assert(vim.fn.Tdb_runStructuredQueryShow({'match $x isa unavailable;'}) == 1)
assert(vim.g.tdb_last_graph_execution.status == 'unknown')
vim.g.typedb_structured_results = false
assert(vim.fn.Tdb_runStructuredQueryShow({'insert $p isa person;'}) == 0)
vim.cmd('qa!')
`);
    const child = spawn(process.env.NVIM_PATH || 'nvim',['--headless','-u','NONE','-l',script],{env:{...process.env,
        STUDIO_TEST_ROOT:root,STUDIO_TEST_REPO:process.cwd(),STUDIO_TEST_URL:'http://localhost:'+server.address().port}});
    let output=''; child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    t.after(()=>{if(child.exitCode===null)child.kill();});
    const [code] = await once(child,'exit'); assert.equal(code,0,output);
    assert.equal(requests.length,2); assert.equal(requests[0].database,'test');
    assert.equal(requests[0].query,'insert $p isa person, has name "Ann";');
});
