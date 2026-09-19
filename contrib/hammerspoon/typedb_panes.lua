-- Cross-window `<c-w>` navigation for the local TypeDB Studio viewer.
--
-- Load it from ~/.config/hammerspoon/init.lua:
--
--     package.path = package.path .. ';/path/to/typedb-studio/contrib/hammerspoon/?.lua'
--     require('typedb_panes')
--
-- It defines one global, `typedbFocusWindow(direction)`. Two callers use it:
--
--   * Neovim, when a `wincmd h/j/k/l` changed no window (see
--     contrib/nvim/typedb_graph.lua), and
--   * the browser, when a `<c-w>` motion found no pane in that direction
--     (POST /api/viewer/focus, handled in scripts/viewer-server.mjs).
--
-- Both escalate only at their own edge, so Hammerspoon never sees a motion
-- that the surface could have handled itself. Directions are resolved
-- geometrically: nothing here knows that the user's screen happens to be
-- schema window, query window, terminal from left to right, and rearranging
-- them needs no change.
--
-- Without this file the bridge falls back to inline Lua doing the same thing,
-- which is the same behaviour minus the `previous` history below.

local M = {}

-- Where `previous` returns to. Recorded per escalation rather than from a
-- window filter: a filter would also record every ordinary click and mission
-- control switch, which makes `<c-w>p` unpredictable. This way `previous`
-- means exactly "back where that motion came from", as it does in Vim. The
-- cost is that arriving somewhere by clicking leaves `previous` pointing at
-- the last *motion's* origin.
local origin = nil

local cardinal = {
    west = 'focusWindowWest', east = 'focusWindowEast',
    north = 'focusWindowNorth', south = 'focusWindowSouth',
}

-- A `far-` motion repeats the step until nothing lies further that way, so one
-- keypress crosses the whole screen. Bounded so a window manager that keeps
-- reporting a move cannot spin.
local maxFarSteps = 8

function M.focus(direction)
    local current = hs.window.focusedWindow()
    if direction == 'previous' then
        -- Swap, so a second `<c-w>p` comes back again.
        if origin and origin:isStandard() then
            local returning = origin
            origin = current
            returning:focus()
        end
        return
    end
    local far = direction:match('^far%-(.+)$')
    local method = cardinal[far or direction]
    if not method or not current then return end
    local moved = false
    for _ = 1, far and maxFarSteps or 1 do
        local before = hs.window.focusedWindow()
        if not before then break end
        -- strict: only windows genuinely in that direction, so a motion off
        -- the edge of the screen does nothing rather than wrapping around.
        before[method](before, nil, true, true)
        local after = hs.window.focusedWindow()
        if not after or after:id() == before:id() then break end
        moved = true
    end
    if moved then origin = current end
end

typedbFocusWindow = M.focus

return M
