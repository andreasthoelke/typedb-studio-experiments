-- Neovim 0.10+. Load with dofile('/path/to/typedb-studio/contrib/nvim/typedb_graph.lua').setup()
local M = {}
local config = { url = 'http://127.0.0.1:1430', limit = 1000, mapping = '<leader>tg' }

function M.send(query, database)
  if not query:find('%S') then
    vim.notify('TypeDB graph: no query selected', vim.log.levels.WARN)
    return
  end
  database = database or vim.b.typedb_database or vim.g.typedb_database
  local body = { query = query, limit = config.limit }
  if database and database ~= '' then body.database = database end
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
        vim.notify(response.viewers == 0
          and 'TypeDB graph: queued. Use :TypeDBGraphOpen to open the viewer.'
          or 'TypeDB graph: sent. Query results appear in the browser.')
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
    vim.ui.open(config.url .. '/viewer')
  end, { desc = 'Open the local TypeDB graph viewer', force = true })
  if config.mapping then
    vim.keymap.set('x', config.mapping, M.visual, { desc = 'TypeDB: graph selection' })
  end
end

return M
