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
-- Without this file the bridge falls back to Hammerspoon's built-in directional
-- focus, without the `previous` history or single-operation far motions below.

local M = {}

-- Where `previous` returns to. Recorded per escalation rather than from a
-- window filter: a filter would also record every ordinary click and mission
-- control switch, which makes `<c-w>p` unpredictable. This way `previous`
-- means exactly "back where that motion came from", as it does in Vim. The
-- cost is that arriving somewhere by clicking leaves `previous` pointing at
-- the last *motion's* origin.
local origin = nil

-- Rank by geometry only. Hammerspoon's frontmost=true option can promote a
-- farther Chrome window when it slightly overlaps its nearer sibling.
local axes = { west = {-1, 0}, east = {1, 0}, north = {0, -1}, south = {0, 1} }
function M.target(current, windows, direction)
    local far = direction:match('^far%-(.+)$')
    local axis = axes[far or direction]
    if not axis then return nil end
    local f = current:frame()
    local cx, cy = f.x + f.w / 2, f.y + f.h / 2
    local best, bestScore, bestForward
    for _, window in ipairs(windows) do
        if window:id() ~= current:id() and window:isStandard() and window:isVisible() then
            local r = window:frame()
            local dx, dy = r.x + r.w / 2 - cx, r.y + r.h / 2 - cy
            local forward = dx * axis[1] + dy * axis[2]
            local lateral = math.abs(dx * axis[2] - dy * axis[1])
            if forward > lateral then
                local score = math.sqrt(dx * dx + dy * dy) + lateral
                local better = not best or (far and forward > bestForward)
                    or ((not far or forward == bestForward) and (score < bestScore
                        or (score == bestScore and window:id() < best:id())))
                if better then best, bestScore, bestForward = window, score, forward end
            end
        end
    end
    return best
end

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
    if not current then return end
    local target = M.target(current, hs.window.orderedWindows(), direction)
    if target then
        origin = current
        -- One focus operation even for far motions; OS focus updates need not
        -- be synchronous, so do not repeatedly read focusedWindow in a loop.
        target:focus()
    end
end

typedbFocusWindow = M.focus

return M
