import type { Nvim } from "../../nvim/nvim-node/index.ts";
import { pollUntil } from "../../utils/async.ts";

export class CompletionsInteraction {
  constructor(private nvim: Nvim) {}

  /**
   * Check if blink.cmp is available
   */
  async isAvailable(): Promise<boolean> {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local ok = pcall(require, 'blink.cmp')
      return ok
      `,
      [],
    ])) as boolean;
  }

  /**
   * Check whether the magenta blink.cmp source provider is registered
   */
  async getSetupInfo(): Promise<{
    has_sources: boolean;
    has_magenta_provider: boolean;
  }> {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local config = require('blink.cmp.config')
      local providers = config.sources.providers or {}
      local has_sources = false
      for _ in pairs(providers) do
        has_sources = true
        break
      end
      return {
        has_sources = has_sources,
        has_magenta_provider = providers.magenta ~= nil
      }
      `,
      [],
    ])) as { has_sources: boolean; has_magenta_provider: boolean };
  }

  /**
   * Check if the blink.cmp completion menu is visible
   */
  async isVisible(): Promise<boolean> {
    return (await this.nvim.call("nvim_exec_lua", [
      `return require('blink.cmp').is_menu_visible()`,
      [],
    ])) as boolean;
  }

  /**
   * Get all completion entries
   */
  async getEntries(): Promise<Array<{ word: string; kind?: number }>> {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local items = require('blink.cmp').get_items() or {}
      local result = {}
      for _, item in ipairs(items) do
        table.insert(result, {
          word = item.label,
          kind = item.kind
        })
      end
      return result
      `,
      [],
    ])) as Array<{ word: string; kind?: number }>;
  }

  /**
   * Get the currently selected completion entry
   */
  async getSelectedEntry(): Promise<
    { word: string; kind?: number } | undefined
  > {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local selected = require('blink.cmp').get_selected_item()
      return selected and {
        word = selected.label,
        kind = selected.kind
      } or nil
      `,
      [],
    ])) as { word: string; kind?: number } | undefined;
  }

  /**
   * Manually trigger completion
   */
  async trigger(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [`require('blink.cmp').show()`, []]);
  }

  /**
   * Accept/confirm the current completion
   */
  async accept(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [
      `require('blink.cmp').select_and_accept()`,
      [],
    ]);
  }

  /**
   * Navigate to next completion item
   */
  async selectNext(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [
      `require('blink.cmp').select_next()`,
      [],
    ]);
  }

  /**
   * Navigate to previous completion item
   */
  async selectPrev(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [
      `require('blink.cmp').select_prev()`,
      [],
    ]);
  }

  /**
   * Close/abort completion menu
   */
  async close(): Promise<void> {
    await this.nvim.call("nvim_exec_lua", [`require('blink.cmp').hide()`, []]);
  }

  /**
   * Get debug information about blink.cmp state
   */
  async getDebugInfo(): Promise<{
    mode: string;
    cmp_visible: boolean;
    cursor_pos: [number, number];
    buffer_lines: string[];
    entries_count: number;
  }> {
    return (await this.nvim.call("nvim_exec_lua", [
      `
      local blink = require('blink.cmp')
      return {
        mode = vim.fn.mode(),
        cmp_visible = blink.is_menu_visible(),
        cursor_pos = vim.api.nvim_win_get_cursor(0),
        buffer_lines = vim.api.nvim_buf_get_lines(0, 0, -1, false),
        entries_count = #(blink.get_items() or {})
      }
      `,
      [],
    ])) as {
      mode: string;
      cmp_visible: boolean;
      cursor_pos: [number, number];
      buffer_lines: string[];
      entries_count: number;
    };
  }

  /**
   * Wait for completion menu to become visible
   */
  async waitForVisible(timeout: number = 3000): Promise<void> {
    await pollUntil(
      async () => {
        const visible = await this.isVisible();
        if (!visible) {
          const debug = await this.getDebugInfo();
          throw new Error(
            `blink.cmp completion menu not visible yet. Debug: ${JSON.stringify(debug)}`,
          );
        }
        return true;
      },
      { timeout },
    );
  }

  /**
   * Wait for completion menu to close/become invisible
   */
  async waitForInvisible(timeout: number = 3000): Promise<void> {
    await pollUntil(
      async () => {
        const visible = await this.isVisible();
        if (visible) {
          throw new Error("Completion menu should be closed");
        }
        return true;
      },
      { timeout },
    );
  }

  /**
   * Wait for a completion entry containing the specified substring to appear
   */
  async waitForCompletionContaining(
    substring: string,
    timeout: number = 5000,
  ): Promise<Array<{ word: string; kind?: number }>> {
    return await pollUntil(
      async () => {
        const entries = await this.getEntries();
        const entryWords = entries.map((e) => e.word);

        const hasSubstring = entryWords.some((word) =>
          word.includes(substring),
        );
        if (!hasSubstring) {
          throw new Error(
            `No completion entry containing "${substring}" found yet. Current entries: ${JSON.stringify(entryWords)}`,
          );
        }

        return entries;
      },
      { timeout },
    );
  }
}
