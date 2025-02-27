local M = {}

function M.rebase_pending_edits(pending_edits)
  -- the start of the edit. Since nothing above this point was edited, this coordinate will be the same in pre and
  -- post-edit systems.
  local firstline_0idx = math.huge

  -- the end line of the edit in the pre-edit coordinate system
  local lastline_0idx_excl = -1

  -- the end line of the edit in the post-edit coordinate system
  local new_lastline_0idx_excl = -1

  for _, edit in ipairs(pending_edits) do
    firstline_0idx = math.min(firstline_0idx, edit.firstline_0idx)
    -- lastline should be in the coordinate system of the initial file (before *any* edits have been applied)
    -- new_lastline - lastline is the line adjustment of the edits we've seen so far, so edit.lastline should be
    -- reversed by this much.
    lastline_0idx_excl = math.max(lastline_0idx_excl, edit.lastline_0idx_excl - (new_lastline_0idx_excl - lastline_0idx_excl))

    -- new_lastline and edit.firstline_0idx are in the same coordinate system (all previous edits having been applied)
    if (new_lastline_0idx_excl > edit.firstline_0idx) then
      -- after this edit, new_lastline should move if the edit is before it
      new_lastline_0idx_excl = new_lastline_0idx_excl + (edit.new_lastline_0idx_excl - edit.lastline_0idx_excl)
    end
    new_lastline_0idx_excl = math.max(new_lastline_0idx_excl, edit.new_lastline_0idx_excl)
  end

  return {
    firstline_0idx = firstline_0idx,
    lastline_0idx_excl = lastline_0idx_excl,
    new_lastline_0idx_excl = new_lastline_0idx_excl
  }
end

return M
