local M = {}

function M.rebase_pending_edits(pending_edits)
  -- the start of the edit. Since nothing above this point was edited, this coordinate will be the same in pre and
  -- post-edit systems.
  local acc_firstline_0idx = math.huge

  -- the end line of the edit in the pre-edit coordinate system
  local acc_lastline_0idx_excl = -1

  -- the end line of the edit in the post-edit coordinate system
  local acc_new_lastline_0idx_excl = -1

  for _, edit in ipairs(pending_edits) do
    -- everything above firstline should be unchanged, so we can compare these directly.
    acc_firstline_0idx = math.min(acc_firstline_0idx, edit.firstline_0idx)

    -- we want to see where in the original file the current edit ends.
    -- To do this we need to reverse the lastline for the current edit through all the
    -- edits so far
    --
    -- if the current edit is above previous edits, the max should select the previous edit,
    -- so applying the delta shouldn't matter.
    --
    -- if the current edit is below the previous edits, applying the delta is appropriate
    acc_lastline_0idx_excl = math.max(acc_lastline_0idx_excl, edit.lastline_0idx_excl - (acc_new_lastline_0idx_excl - acc_lastline_0idx_excl))

    -- new_lastline and edit.firstline_0idx are in the same coordinate system (all previous edits having been applied)
    if (acc_new_lastline_0idx_excl > edit.firstline_0idx) then
      -- this edit moves the previous new_lastline
      acc_new_lastline_0idx_excl = acc_new_lastline_0idx_excl + (edit.new_lastline_0idx_excl - edit.lastline_0idx_excl)
    end

    -- now acc_new_lastline has been updated to the post-current-edit coordinate system,
    -- so we can compare it with the edit's lastline
    acc_new_lastline_0idx_excl = math.max(acc_new_lastline_0idx_excl, edit.new_lastline_0idx_excl)
  end

  return {
    firstline_0idx = acc_firstline_0idx,
    lastline_0idx_excl = acc_lastline_0idx_excl,
    new_lastline_0idx_excl = acc_new_lastline_0idx_excl
  }
end

return M
