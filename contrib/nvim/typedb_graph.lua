-- Neovim 0.10+. The user's TypeDB plugin loads this module automatically.
local M = {}
local config = {
  url = 'http://localhost:1430', limit = 1000, mapping = '<leader>tg', control_prefix = '\\',
  repo = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h'),
}
local starting = false
local waiting = {}
local sequence = 0
local runSequence = 0
local startGeneration = 0
local projectTempDirectory
local navigationQueue = {}
local navigationSending = false

local function sendNavigation(path, body, quiet)
  table.insert(navigationQueue, { path = path, body = body, quiet = quiet })
  if navigationSending then return end
  local function nextRequest()
    local item = table.remove(navigationQueue, 1)
    if not item then navigationSending = false; return end
    navigationSending = true
    vim.system({ 'curl', '--silent', '--show-error', '--fail-with-body', '--max-time', '3',
      '-H', 'Content-Type: application/json', '--data-binary', '@-', config.url .. item.path },
      { stdin = vim.json.encode(item.body), text = true }, function(result)
        vim.schedule(function()
          if result.code ~= 0 and not item.quiet then
            vim.notify('TypeDB viewer: restart the updated bridge (:TypeDBGraphStop, then :TypeDBGraphStart).', vim.log.levels.WARN)
          end
          nextRequest()
        end)
      end)
  end
  nextRequest()
end

local function notifyError(message)
  vim.notify('TypeDB Studio: ' .. message, vim.log.levels.WARN)
end

local function health(callback)
  vim.system({ 'curl', '--silent', '--fail', '--max-time', '1', config.url .. '/api/viewer/health' },
    { text = true }, function(result)
      vim.schedule(function()
        local ok, response = pcall(vim.json.decode, result.stdout or '')
        callback(result.code == 0 and ok and type(response) == 'table' and response.service == 'typedb-studio-bridge')
      end)
    end)
end

local function finishStart(ok)
  starting = false
  local callbacks = waiting
  waiting = {}
  for _, callback in ipairs(callbacks) do callback(ok) end
end

function M.ensure_running(callback)
  callback = callback or function() end
  table.insert(waiting, callback)
  if starting then return end
  starting = true
  startGeneration = startGeneration + 1
  local generation = startGeneration
  health(function(running)
    if generation ~= startGeneration then return end
    if running then finishStart(true); return end
    local node = config.node or '/opt/homebrew/opt/node@22/bin/node'
    if vim.fn.executable(node) == 0 then node = vim.fn.exepath('node') end
    if node == '' or vim.fn.filereadable(config.repo .. '/scripts/viewer-server.mjs') == 0 then
      notifyError('Cannot find Node or the Studio bridge. Check the configured repo path.')
      finishStart(false)
      return
    end
    local existing = vim.g.TypeDBStudioTermID
    if not existing or vim.fn.jobwait({ existing }, 0)[1] ~= -1 then
      local buffer = vim.api.nvim_create_buf(false, true)
      vim.g.TypeDBStudioBuf = buffer
      vim.api.nvim_buf_set_name(buffer, 'TypeDB Studio (' .. buffer .. ')')
      vim.api.nvim_buf_call(buffer, function()
        vim.g.TypeDBStudioTermID = vim.fn.termopen({ node, config.repo .. '/scripts/viewer-server.mjs', '--dev' }, {
          cwd = config.repo,
          env = { TYPEDB_VIEWER_PORT = config.url:match(':(%d+)$') or '1430' },
          on_exit = function(job)
            vim.schedule(function()
              if vim.g.TypeDBStudioTermID == job then vim.g.TypeDBStudioTermID = nil end
            end)
          end,
        })
      end)
    end
    local attempts = 0
    local function poll()
      health(function(ready)
        if generation ~= startGeneration then return end
        if ready then finishStart(true); return end
        attempts = attempts + 1
        if attempts >= 30 then
          notifyError('Bridge did not start. Use :TypeDBGraphLog to see its terminal output.')
          finishStart(false)
        else
          vim.defer_fn(poll, 200)
        end
      end)
    end
    poll()
  end)
end

function M.stop_server()
  startGeneration = startGeneration + 1
  starting = false
  sequence = sequence + 1
  navigationQueue = {}
  waiting = {}
  if vim.g.TypeDBStudioTermID then
    vim.fn.jobstop(vim.g.TypeDBStudioTermID)
    vim.g.TypeDBStudioTermID = nil
  end
end

-- Only normal-mode navigation calls this. Capture the paragraph and cursor now;
-- asynchronous HTTP callbacks must never re-read a different buffer or position.
function M.caret(schemaOnly)
  if not vim.api.nvim_buf_get_name(0):match('%.tqls?$') then return end
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local cursor = vim.api.nvim_win_get_cursor(0)
  local first, last = cursor[1], cursor[1]
  if not lines[first] or not lines[first]:find('%S') then return end
  while first > 1 and lines[first - 1]:find('%S') do first = first - 1 end
  while last < #lines and lines[last + 1]:find('%S') do last = last + 1 end
  local paragraph = {}
  for i = first, last do table.insert(paragraph, lines[i]) end
  -- The two-result form is compatible with Neovim 0.10 and 0.11.
  local _, utf16 = vim.str_utfindex(lines[cursor[1]], cursor[2])
  local filename = vim.fn.expand('%:t')
  local database = vim.b.typedb_database or filename:match('^schema_(.+)%.tql$')
    or filename:match('^data_(.+)%.tql$') or vim.g.typedb_database or vim.g.typedb_active_schema
  local body = { source = table.concat(paragraph, '\n'), line = cursor[1] - first,
    column = utf16, schemaOnly = schemaOnly == true }
  if database and database ~= '' then body.database = database end
  -- A navigation gesture follows an already-running viewer; it doesn't start a
  -- server or open a browser as a side effect of moving around a source file.
  sendNavigation('/api/viewer/caret', body, schemaOnly)
end

function M.control(command)
  if not vim.api.nvim_buf_get_name(0):match('%.tqls?$') then return end
  local filename = vim.fn.expand('%:t')
  local database = vim.b.typedb_database or filename:match('^schema_(.+)%.tql$')
    or filename:match('^data_(.+)%.tql$') or vim.g.typedb_database or vim.g.typedb_active_schema
  local body = { command = command, projectTempDirectory = projectTempDirectory() }
  if database and database ~= '' then body.database = database end
  sendNavigation('/api/viewer/control', body, false)
end

function M.schema_motion(backward)
  local before = vim.api.nvim_win_get_cursor(0)
  local name = backward and 'Tdb_MainStartBindingBackw' or 'Tdb_MainStartBindingForw'
  if vim.fn.exists('*' .. name) == 1 then
    vim.fn[name]()
    if vim.fn.exists('*ScrollOff') == 1 then vim.fn.ScrollOff(backward and 10 or 16) end
  else
    vim.fn.search([=[\v^\s*(entity|relation|attribute|fun)>\s+\zs\S+]=], backward and 'bW' or 'W')
  end
  if not vim.deep_equal(before, vim.api.nvim_win_get_cursor(0)) then M.caret(true) end
end

function M.buffer_maps(buffer)
  buffer = buffer or vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_is_valid(buffer) or not vim.api.nvim_buf_get_name(buffer):match('%.tqls?$') then return end
  vim.keymap.set('n', '<CR>', function() M.caret(false) end, { buffer = buffer, silent = true, desc = 'TypeDB: caret identifier in connected graphs' })
  vim.keymap.set('n', 'geo', function() M.caret(false) end, { buffer = buffer, silent = true, desc = 'TypeDB: open identifier in connected graphs' })
  vim.keymap.set('n', '<C-n>', function() M.schema_motion(false) end, { buffer = buffer, silent = true, desc = 'TypeDB: next binding and schema caret' })
  vim.keymap.set('n', '<C-p>', function() M.schema_motion(true) end, { buffer = buffer, silent = true, desc = 'TypeDB: previous binding and schema caret' })
  -- Changing/disabling the prefix on reload removes only our own old controls.
  for _, map in ipairs(vim.api.nvim_buf_get_keymap(buffer, 'n')) do
    if map.desc and map.desc:find('^TypeDB viewer: ') then vim.keymap.del('n', map.lhs, { buffer = buffer }) end
  end
  if config.control_prefix then
    for suffix, command in pairs({ zz = 'centreCaret', zt = 'caretTop', zb = 'caretBottom', zh = 'caretLeft', zl = 'caretRight',
      ['<C-h>'] = 'panLeft', ['<C-l>'] = 'panRight', ['<C-y>'] = 'panUp', ['<C-e>'] = 'panDown',
      ['<C-k>'] = 'panUp', ['<C-j>'] = 'panDown', ['<C-o>'] = 'back',
      ['+'] = 'zoomIn', ['='] = 'zoomIn', ['-'] = 'zoomOut', ['<CR>'] = 'focus', s = 'snap', r = 'relayout' }) do
      vim.keymap.set('n', config.control_prefix .. suffix, function() M.control(command) end,
        { buffer = buffer, silent = true, desc = 'TypeDB viewer: ' .. command })
    end
  end
end

-- Capture before terminal jobs can change the current buffer. Match the sent
-- text, preferring the occurrence nearest the caret when a snippet repeats.
function M.source_location(query)
  local path = vim.api.nvim_buf_get_name(0)
  if path == '' or vim.bo.buftype ~= '' then return nil end
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  -- The schema runner prepends a bare define/redefine/undefine line that is
  -- not in the buffer; match the first line the user actually wrote.
  local first = ''
  for line in query:gmatch('[^\n]+') do
    local word = vim.trim(line)
    if word ~= '' and word ~= 'define' and word ~= 'redefine' and word ~= 'undefine' then first = line; break end
  end
  local at, distance = nil, math.huge
  for i, line in ipairs(lines) do
    if vim.trim(line) == vim.trim(first) then
      local d = math.abs(i - vim.api.nvim_win_get_cursor(0)[1])
      if d < distance then at, distance = i, d end
    end
  end
  if not at then return nil end
  local header = at
  while header > 1 and (lines[header - 1]:match('^%s*#') or lines[header - 1]:match('^%s*$')) do header = header - 1 end
  while header < at and not lines[header]:match('^%s*# ─ ') do header = header + 1 end
  local title = lines[header]:match('^%s*# ─ (.*)') or ''
  local comments = {}
  if title ~= '' then
    for i = header + 1, #lines do
      local comment = lines[i]:match('^%s*#%s?(.*)')
      if not comment then break end
      table.insert(comments, comment)
    end
  end
  return { path = path, line = header, anchor = lines[header], title = title,
    comment = table.concat(comments, '\n'), query = query, server = vim.v.servername }
end

function M.mirror(query, database, execution)
  if vim.g.typedb_graph_auto == false or vim.g.typedb_graph_auto == 0 then return end
  M.send(query, database, { quiet = true, execution = execution })
end

-- Synchronous to fit the existing Vimscript runner/refresh lifecycle. Only a
-- preflight failure can return nil and permit the legacy console path.
function M.run(query, database)
  if vim.g.typedb_structured_results == false or vim.g.typedb_structured_results == 0 then return nil end
  local temp = projectTempDirectory()
  local sourceLocation = M.source_location(query)
  local ready
  M.ensure_running(function(ok) ready = ok end)
  vim.wait(8000, function() return ready ~= nil end, 20)
  if not ready then return nil end
  local check = vim.system({ 'curl', '--silent', '--fail', '--max-time', '2', config.url .. '/api/viewer/health' }, {text=true}):wait()
  local ok, healthResult = pcall(vim.json.decode, check.stdout or '')
  if check.code ~= 0 or not ok or not healthResult.structuredRuns then
    notifyError('Structured runner unavailable; using the console. Restart the bridge when convenient to enable tables.')
    return nil
  end
  -- LuaJIT tostring switches large clock values to scientific notation, which
  -- is invalid in bridge IDs. Pad short uptimes and distinguish repeated ticks.
  runSequence = runSequence + 1
  local runId = string.format('nvim-%016.0f-%d-%d', vim.uv.hrtime(), vim.fn.getpid(), runSequence)
  local body = { sourceLocation = sourceLocation, runId = runId, query = query, database = database, limit = config.limit, projectTempDirectory = temp,
    publish = vim.g.typedb_graph_auto ~= false and vim.g.typedb_graph_auto ~= 0 }
  local result = vim.system({ 'curl', '--silent', '--show-error', '--max-time', '75', '--write-out', '\n%{http_code}',
    '-H', 'Content-Type: application/json', '--data-binary', '@-', config.url .. '/api/viewer/run' },
    { stdin = vim.json.encode(body), text = true }):wait()
  local status = tonumber((result.stdout or ''):match('\n(%d%d%d)$'))
  local payload = (result.stdout or ''):gsub('\n%d%d%d$', '')
  local decoded, response = pcall(vim.json.decode, payload)
  if result.code == 0 and decoded and type(response) == 'table' and response.execution and response.lines then return response end
  -- The POST may already have committed. Never run the console after this point.
  local message = result.code == 0 and decoded and type(response) == 'table' and response.error
    or 'Bridge response lost. The statement may have committed; inspect current data before running it again.'
  local rejected = result.code == 0 and (status == 400 or status == 403 or status == 404 or status == 413 or status == 415)
  return { id = runId, query = query, database = database,
    execution = { kind = 'read', status = rejected and 'error' or 'unknown', error = message },
    lines = { rejected and 'TypeDB request rejected before execution' or 'TypeDB result unavailable', message,
      'Request: ' .. runId, 'No automatic retry was made.' } }
end

-- Buffer-local view switches keep each float tied to its own completed run.
function M.attach_result(window, result, tableLines)
  tableLines = tableLines or result.lines
  if not vim.api.nvim_win_is_valid(window) then return end
  local buffer = vim.api.nvim_win_get_buf(window)
  vim.wo[window].wrap = false
  vim.b[buffer].tdb_result = result
  local function show(lines, syntax)
    if not vim.api.nvim_buf_is_valid(buffer) then return end
    vim.bo[buffer].modifiable = true
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
    vim.bo[buffer].syntax = syntax
    vim.bo[buffer].modifiable = false
    if vim.api.nvim_win_is_valid(window) then vim.api.nvim_win_set_cursor(window, {1, 0}) end
  end
  local function map(keys, callback, options)
    options.nowait = true
    vim.keymap.set('n', keys, callback, options)
    vim.keymap.set('n', '<leader><leader>' .. keys:sub(2), callback, options)
  end
  map('gt', function() show(tableLines, '') end, {buffer=buffer, silent=true, desc='TypeDB table/result'})
  map('gr', function()
    local raw = vim.deepcopy(result); raw.lines = nil
    -- vim.inspect is not JSON; use the decoder/encoder without changing values.
    local encoded = vim.json.encode(raw)
    local pretty = encoded
    if vim.fn.executable('python3') == 1 then
      local formatted = vim.fn.system({'python3', '-m', 'json.tool', '--no-ensure-ascii'}, encoded)
      if vim.v.shell_error == 0 then pretty = formatted end
    end
    show(vim.split(pretty, '\n', {trimempty=true}), 'json')
  end, {buffer=buffer, silent=true, desc='TypeDB raw JSON'})
  map('gq', function()
    local query = '# Executed statement\n' .. result.query
    if result.graph and result.graph.source == 'context' then query = query .. '\n\n# ' .. result.graph.note .. '\n' .. result.graph.query end
    show(vim.split(query, '\n'), 'typeql')
  end, {buffer=buffer, silent=true, desc='TypeDB executed/context queries'})
  -- Boundaries come from the table's divider, not from values containing pipes.
  local function column(direction)
    local win = vim.api.nvim_get_current_win()
    if vim.api.nvim_win_get_buf(win) ~= buffer or vim.bo[buffer].syntax == 'json' then return end
    local cursor = vim.api.nvim_win_get_cursor(win)
    local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
    local divider
    for row = math.min(cursor[1] + 1, #lines), 1, -1 do
      local line = lines[row]
      local residue = line:gsub('─', ''):gsub('┼', ''):gsub('[|%-%s]', '')
      if residue == '' and (line:find('┼', 1, true) or line:find('|', 1, true)) then divider = line; break end
      if row < cursor[1] and line == '' then break end
    end
    if not divider then return end
    local starts = { divider:sub(1, 1) == '|' and 2 or 0 }
    local separator = divider:find('┼', 1, true) and '┼' or '|'
    local from = 1
    while true do
      local at, last = divider:find(separator, from, true)
      if not at then break end
      if at > 1 and last < #divider then table.insert(starts, vim.fn.strdisplaywidth(divider:sub(1, last)) + 1) end
      from = last + 1
    end
    local line = lines[cursor[1]]
    local current = vim.fn.strdisplaywidth(line:sub(1, cursor[2]))
    local index = 0
    for i, start in ipairs(starts) do if start <= current then index = i end end
    local destination = starts[math.max(1, math.min(#starts, index + direction))]
    local byte = 0
    for i = 0, vim.fn.strchars(line) do
      local prefix = vim.fn.strcharpart(line, 0, i)
      byte = #prefix
      if vim.fn.strdisplaywidth(prefix) >= destination then break end
    end
    vim.api.nvim_win_set_cursor(win, {cursor[1], math.min(byte, math.max(0, #line - 1))})
  end
  vim.keymap.set('n', 'I', function() column(1) end, {buffer=buffer, silent=true, desc='Next result column'})
  vim.keymap.set('n', 'Y', function() column(-1) end, {buffer=buffer, silent=true, desc='Previous result column'})
  vim.bo[buffer].syntax = ''
end

-- Resolve before starting the bridge: termopen and result floats can change buffers.
projectTempDirectory = function()
  local override = vim.b.typedb_graph_temp_dir or config.temp_dir
  if override then return vim.fn.fnamemodify(vim.fn.expand(override), ':p'):gsub('/+$', '') end
  local source = vim.api.nvim_buf_get_name(0)
  local dir = source ~= '' and vim.bo.buftype == '' and vim.fn.fnamemodify(source, ':p:h') or vim.fn.getcwd()
  while dir and dir ~= '' do
    if vim.fn.fnamemodify(dir, ':t') == 'temp' then return dir end
    if vim.fn.isdirectory(dir .. '/temp') == 1 then return dir .. '/temp' end
    if vim.fn.isdirectory(dir .. '/.git') == 1 or vim.fn.filereadable(dir .. '/.git') == 1 then return dir .. '/temp' end
    local parent = vim.fn.fnamemodify(dir, ':h')
    if parent == dir then break end
    dir = parent
  end
  return vim.fn.getcwd() .. '/temp'
end

function M.send(query, database, options)
  options = options or {}
  if not query:find('%S') then
    vim.notify('TypeDB graph: no query selected', vim.log.levels.WARN)
    return
  end
  local filename = vim.fn.expand('%:t')
  local panelDatabase = filename:match('^schema_(.+)%.tql$') or filename:match('^data_(.+)%.tql$')
  database = database or vim.b.typedb_database or panelDatabase or vim.g.typedb_database or vim.g.typedb_active_schema
  local body = { sourceLocation = M.source_location(query), query = query, limit = config.limit, execution = options.execution, projectTempDirectory = projectTempDirectory() }
  if database and database ~= '' then body.database = database end
  sequence = sequence + 1
  local requestSequence = sequence
  M.ensure_running(function(ready)
    if not ready or requestSequence ~= sequence then return end
    -- argv + stdin preserve quotes, $, Unicode and newlines without shell interpolation.
    vim.system({ 'curl', '--silent', '--show-error', '--fail-with-body', '--max-time', '10',
      '-H', 'Content-Type: application/json', '--data-binary', '@-', config.url .. '/api/viewer/query' },
      { stdin = vim.json.encode(body), text = true }, function(result)
        vim.schedule(function()
          if result.code ~= 0 then
            vim.notify('TypeDB graph: ' .. (result.stderr or '') .. (result.stdout or ''), vim.log.levels.ERROR)
            return
          end
          local ok, response = pcall(vim.json.decode, result.stdout)
          if not ok or type(response) ~= 'table' or not response.id then
            vim.notify('TypeDB graph: unexpected bridge response', vim.log.levels.ERROR)
            return
          end
          if options.execution and response.executionContext ~= true then
            notifyError("Restart the Studio bridge to enable operation context (:TypeDBGraphStop, then :TypeDBGraphStart).")
            return
          end
          if response.projectSnapshots ~= true then
            notifyError("Restart the Studio bridge to save snapshots in the project (:TypeDBGraphStop, then :TypeDBGraphStart).")
            return
          end
          if options.quiet then return end
          vim.notify(response.viewers == 0
            and 'TypeDB graph: queued. Use :TypeDBGraphOpen to open the viewer.'
            or 'TypeDB graph: sent. Query results appear in the browser.')
        end)
      end)
  end)
end

function M.visual()
  local lines = vim.fn.getregion(vim.fn.getpos('v'), vim.fn.getpos('.'), {
    type = vim.fn.mode(), exclusive = vim.o.selection == 'exclusive',
  })
  M.send(table.concat(lines, '\n'))
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'n', false)
end

--- Vim's own `wincmd` first; only a motion that changed nothing is an edge,
--- and an edge is handed to the window manager through the bridge. This is the
--- rule vim-tmux-navigator uses between Vim and tmux, applied between Neovim
--- and the browser windows instead. Hammerspoon resolves the direction
--- geometrically, so this knows nothing about where the browser sits.
local windowDirections = { h = 'west', l = 'east', k = 'north', j = 'south' }
-- Shifted motions go as far as they can. Note these replace Vim's own
-- <c-w>H/L, which *move* a window to the far left/right; `:wincmd H` still
-- does that.
local farDirections = { H = 'far-west', L = 'far-east' }
-- Set when Neovim regains focus from another application, cleared as soon as
-- the cursor moves between Neovim's own windows. <c-w>p follows one merged
-- timeline across Neovim and the browser: whichever happened last wins.
local enteredFromOutside = false

local function escalate(direction)
  sendNavigation('/api/viewer/focus', { direction = direction }, true)
end

function M.window_motion(key)
  local before = vim.api.nvim_get_current_win()
  vim.cmd('wincmd ' .. key)
  if vim.api.nvim_get_current_win() ~= before then return end
  escalate(windowDirections[key])
end

-- Window level, not split level: these always cross to the leftmost or
-- rightmost window on screen. <c-w>h/l already walk Neovim's own splits.
function M.window_far(key)
  escalate(farDirections[key])
end

function M.window_previous()
  if enteredFromOutside then
    enteredFromOutside = false
    escalate('previous')
    return
  end
  vim.cmd('wincmd p')
end

function M.window_maps()
  local group = vim.api.nvim_create_augroup('TypeDBStudioWindowFocus', { clear = true })
  vim.api.nvim_create_autocmd('FocusGained', {
    group = group, callback = function() enteredFromOutside = true end,
  })
  vim.api.nvim_create_autocmd('WinEnter', {
    group = group, callback = function() enteredFromOutside = false end,
  })
  for key, direction in pairs(windowDirections) do
    local describe = 'TypeDB viewer: window ' .. direction .. ', escalating at the edge'
    vim.keymap.set('n', '<C-w>' .. key, function() M.window_motion(key) end, { silent = true, desc = describe })
    vim.keymap.set('n', '<C-w><C-' .. key .. '>', function() M.window_motion(key) end, { silent = true, desc = describe })
  end
  for key, far in pairs(farDirections) do
    vim.keymap.set('n', '<C-w>' .. key, function() M.window_far(key) end,
      { silent = true, desc = 'TypeDB viewer: ' .. far:gsub('%-', ' ') .. ' window, crossing applications' })
  end
  vim.keymap.set('n', '<C-w>p', M.window_previous,
    { silent = true, desc = 'TypeDB viewer: previous window, or the application we came from' })
  vim.keymap.set('n', '<C-w><C-p>', M.window_previous,
    { silent = true, desc = 'TypeDB viewer: previous window, or the application we came from' })
end

function M.setup(options)
  vim.cmd.source(vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h') .. '/typedb_result.vim')
  config = vim.tbl_extend('force', config, options or {})
  config.url = config.url:gsub('/+$', '')
  -- Off by default: these are the only global (non buffer-local) maps this
  -- plugin would own, and they replace motions the user may already have
  -- bound. Opt in with setup({ window_navigation = true }).
  if config.window_navigation then M.window_maps() end
  local group = vim.api.nvim_create_augroup('TypeDBStudioCaret', { clear = true })
  vim.api.nvim_create_autocmd({ 'BufEnter', 'FileType' }, {
    group = group, callback = function(args)
      -- Run after existing filetype maps so the user's TypeDB motions stay the
      -- underlying jump implementation, regardless of plugin load order.
      vim.schedule(function() M.buffer_maps(args.buf) end)
    end,
  })
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do M.buffer_maps(buffer) end
  vim.api.nvim_create_user_command('TypeDBGraphCaret', function() M.caret(false) end,
    { desc = 'Focus identifier under/right of cursor in connected graph views', force = true })
  vim.api.nvim_create_user_command('TypeDBGraph', function(args)
    local first = args.range > 0 and args.line1 - 1 or 0
    local last = args.range > 0 and args.line2 or -1
    M.send(table.concat(vim.api.nvim_buf_get_lines(0, first, last, false), '\n'),
      args.args ~= '' and args.args or nil)
  end, { range = true, nargs = '?', desc = 'Graph this buffer or line range, optionally in a named database', force = true })
  vim.api.nvim_create_user_command('TypeDBGraphOpen', function()
    M.ensure_running(function(ready)
      if ready then vim.ui.open(config.url .. '/query?nvim=1') end
    end)
  end, { desc = 'Open the local TypeDB graph viewer', force = true })
  vim.api.nvim_create_user_command('TypeDBGraphStart', function() M.ensure_running() end, { force = true })
  vim.api.nvim_create_user_command('TypeDBGraphStop', M.stop_server, { force = true })
  vim.api.nvim_create_user_command('TypeDBGraphLog', function()
    local buffer = vim.g.TypeDBStudioBuf
    if buffer and vim.api.nvim_buf_is_valid(buffer) then
      vim.cmd('sbuffer ' .. buffer)
    else
      vim.notify('The Studio bridge was not started by this Neovim session.')
    end
  end, { force = true })
  if config.mapping then
    vim.keymap.set('x', config.mapping, M.visual, { desc = 'TypeDB: graph selection' })
  end
end

return M
