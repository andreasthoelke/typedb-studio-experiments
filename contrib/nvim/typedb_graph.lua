-- Neovim 0.10+. The user's TypeDB plugin loads this module automatically.
local M = {}
local config = {
  url = 'http://localhost:1430', limit = 1000, mapping = '<leader>tg',
  repo = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h'),
}
local starting = false
local waiting = {}
local sequence = 0
local startGeneration = 0

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
  waiting = {}
  if vim.g.TypeDBStudioTermID then
    vim.fn.jobstop(vim.g.TypeDBStudioTermID)
    vim.g.TypeDBStudioTermID = nil
  end
end

function M.mirror(query, database)
  if vim.g.typedb_graph_auto == false or vim.g.typedb_graph_auto == 0 then return end
  M.send(query, database, { quiet = true })
end

function M.send(query, database, options)
  options = options or {}
  if not query:find('%S') then
    vim.notify('TypeDB graph: no query selected', vim.log.levels.WARN)
    return
  end
  database = database or vim.b.typedb_database or vim.g.typedb_database or vim.g.typedb_active_schema
  local body = { query = query, limit = config.limit }
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

function M.setup(options)
  config = vim.tbl_extend('force', config, options or {})
  config.url = config.url:gsub('/+$', '')
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
