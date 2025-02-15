package.path = package.path .. ";./lua/?.lua"
local rebase_pending_edits = require('magenta.buffer_snapshots').rebase_pending_edits

local function assert_equal(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s\nexpected: %s\nactual: %s", message or "assertion failed", expected, actual))
  end
end

local function test_single_edit()
  local result = rebase_pending_edits({{
    firstline = 5,
    lastline = 10,
    new_lastline = 12
  }})
  assert_equal(result.firstline, 5, "firstline should be 5")
  assert_equal(result.lastline, 10, "lastline should be 10")
  assert_equal(result.new_lastline, 12, "new_lastline should be 12")
  print("Single edit test passed")
end

local function test_multiple_edits()
  local result = rebase_pending_edits({
    {
      firstline = 5,
      lastline = 7,
      new_lastline = 8
    },
    {
      firstline = 10,
      lastline = 12,
      new_lastline = 15
    }
  })
  assert_equal(result.firstline, 5, "firstline should be 5")
  assert_equal(result.lastline, 11, "lastline should be 11") -- 12 - (15-12) to account for first edit
  assert_equal(result.new_lastline, 15, "new_lastline should be 15")
  print("Multiple edits test passed")
end

local function test_growing_edits()
  local result = rebase_pending_edits({
    {
      firstline = 5,
      lastline = 5,
      new_lastline = 6 -- insert a line
    },
    {
      firstline = 5,
      lastline = 5,
      new_lastline = 6 -- insert another line
    }
  })
  assert_equal(result.firstline, 5, "firstline should be 5")
  assert_equal(result.lastline, 5, "lastline should be 5 since we just inserted into that single line in the original file")
  assert_equal(result.new_lastline, 7, "new_lastline should be 7 (inserted two lines)")
  print("growing edits passed")
end

local function test_shrinking_edits()
  local result = rebase_pending_edits({
    {
      firstline = 12,
      lastline = 15,
      new_lastline = 18
    },
    {
      firstline = 5,
      lastline = 10,
      new_lastline = 8  -- deleted 2 lines
    },
  })
  assert_equal(result.firstline, 5, "firstline should be 5")
  assert_equal(result.lastline, 15, "lastline should be 15")
  assert_equal(result.new_lastline, 16, "new_lastline should be 16") -- 18 from the first edit -2 from the second edit
  print("shrinking edits test")
end

local function test_overlapping_edits()
  local result = rebase_pending_edits({
    {
      firstline = 5,
      lastline = 10,
      new_lastline = 12
    },
    {
      firstline = 8,
      lastline = 15,
      new_lastline = 14
    }
  })
  assert_equal(result.firstline, 5, "firstline should be 5")
  assert_equal(result.lastline, 13, "lastline should be 13") -- adjusted for overlap
  assert_equal(result.new_lastline, 14, "new_lastline should be 14")
  print("Overlapping edits test passed")
end

local function test_empty_edits()
  local result = rebase_pending_edits({
    {
      firstline = 5,
      lastline = 5,
      new_lastline = 5
    },
    {
      firstline = 10,
      lastline = 10,
      new_lastline = 10
    }
  })
  assert_equal(result.firstline, 5, "firstline should be 5")
  assert_equal(result.lastline, 10, "lastline should be 10")
  assert_equal(result.new_lastline, 10, "new_lastline should be 10")
  print("Empty edits test passed")
end

local function test_deletion_edits()
  local result = rebase_pending_edits({
    {
      firstline = 5,
      lastline = 5,
      new_lastline = 10
    },
    {
      firstline = 5,
      lastline = 10,
      new_lastline = 5
    }
  })
  assert_equal(result.firstline, 5, "firstline should be 5")
  assert_equal(result.lastline, 5, "lastline should be 5")
  assert_equal(result.new_lastline, 5, "new_lastline should be 5")
  print("Empty edits test passed")
end


-- Run tests
test_single_edit()
test_multiple_edits()
test_growing_edits()
test_shrinking_edits()
test_overlapping_edits()
test_empty_edits()
test_deletion_edits()
print("All tests passed!")

