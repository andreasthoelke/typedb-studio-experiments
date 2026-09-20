" Adapter for the user's paragraph runner. Loaded by typedb_graph.setup().
" Return 0 only before execution, allowing the existing console path to run.
function! Tdb_runStructuredQueryShow(lines) abort
  if empty(a:lines) | return 0 | endif
  let l:transaction = Tdb_withTransactionLines(copy(a:lines))
  let l:query = join(l:transaction[1:-3], "\n")
  " The legacy runner always prepends its schema mode; explicit commands already have one.
  let l:first = get(filter(copy(a:lines), {_, x -> x !~# '^\s*\(#\|$\)'}), 0, '')
  if l:first =~# '^\s*\(define\|redefine\|undefine\)\>'
    let l:query = join(a:lines, "\n")
  endif
  let l:result = luaeval('_G.Tdb_graph.run(_A.query, _A.database)',
        \ {'query': l:query, 'database': g:typedb_active_schema})
  if type(l:result) != v:t_dict | return 0 | endif
  let g:tdb_last_graph_query = l:result.query
  let g:tdb_last_graph_execution = l:result.execution
  let g:tdb_error = l:result.execution.status !=# 'success'
  let g:isJsonFetch = -1
  " Refreshes are independent reads, based on the bridge's actual classification.
  try
    if l:result.execution.kind ==# 'schema'
      call Tdb_update_ShowCurrentSchemaFile()
    endif
    if l:result.execution.kind ==# 'write' || (l:result.execution.kind ==# 'schema' && l:query =~# '\<undefine\>')
      call Tdb_update_ShowCurrentDataFile()
    endif
  catch
    call extend(l:result.lines, ['', 'Panel refresh failed: ' . v:exception])
  endtry
  call Tdb_showLines(l:result.lines)
  call luaeval('_G.Tdb_graph.attach_result(_A.window, _A.result)', {'window': g:floatWin_win, 'result': l:result})
  return 1
endfunction
