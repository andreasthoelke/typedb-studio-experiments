import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('window geometry ignores recency/overlap and far moves need only one focus operation', async t => {
 const root=await mkdtemp(join(tmpdir(),'studio-window-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'test.lua');
 await writeFile(path, String.raw`
local focused, windows, calls
local function window(id,x,y,w,h)
 return {id=function() return id end, frame=function() return {x=x,y=y,w=w,h=h} end,
 isStandard=function() return true end, isVisible=function() return true end,
 focus=function(self) table.insert(calls,id); return self end}
end
local schema=window(1,0,0,700,1000)
local query=window(2,650,0,700,1000) -- overlapping: frontmost used to promote the farther one
local nvim=window(3,1300,0,700,1000)
windows={schema,nvim,query};focused=nvim;calls={}
hs={window={focusedWindow=function() return focused end,orderedWindows=function() return windows end}}
local panes=dofile(vim.env.STUDIO_REPO..'/contrib/hammerspoon/typedb_panes.lua')
assert(panes.target(nvim,windows,'west')==query)
windows={query,schema,nvim};assert(panes.target(nvim,windows,'west')==query)
panes.focus('west');assert(vim.deep_equal(calls,{2}))
-- Mock delayed OS focus: focusedWindow has deliberately not changed yet.
calls={};focused=schema;panes.focus('far-east');assert(vim.deep_equal(calls,{3}))
focused=nvim;calls={};panes.focus('west');assert(vim.deep_equal(calls,{2}))
focused=query;calls={};panes.focus('previous');assert(vim.deep_equal(calls,{3}))
focused=schema;calls={};panes.focus('west');assert(#calls==0)
assert(panes.target(nvim,windows,'far-west')==schema)
vim.cmd('qa!')
`);
 const child=spawn('nvim',['--headless','-u','NONE','-l',path],{env:{...process.env,STUDIO_REPO:process.cwd()}});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const [code]=await once(child,'exit');assert.equal(code,0,output);
});
