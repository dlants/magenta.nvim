import type { Nvim } from "./nvim-node/index.ts";

/**
 * Highlight group names used by magenta
 */
export const MAGENTA_HIGHLIGHT_GROUPS = {} as const;

/**
 * Initialize all magenta highlight groups within the magenta namespace.
 * This should be called once during plugin initialization.
 */
export async function initializeMagentaHighlightGroups(
  _nvim: Nvim,
): Promise<void> {}

/**
 * Union type of all available highlight groups for type safety.
 * Includes standard Neovim groups, Treesitter groups, LSP semantic tokens, and dynamic groups.
 */
/**
 * All available highlight groups for type safety.
 * Includes standard Neovim groups, Treesitter groups, and LSP semantic tokens.
 */
export const HL_GROUPS = [
  // Standard Neovim highlight groups
  "ErrorMsg",
  "WarningMsg",
  "Directory",
  "String",
  "Comment",
  "Bold",
  "Identifier",
  "Underlined",
  "Normal",
  "Function",
  // Diff highlight groups
  "DiffAdd",
  "DiffDelete",
  "DiffChange",
  "DiffText",
  // Treesitter groups
  "@variable",
  "@function.call",
  "@keyword",
  "@string",
  "@comment",
  "@type",
  "@constant",
  // Treesitter markdown groups
  "@markup.heading.1.markdown",
  "@markup.heading.2.markdown",
  "@markup.heading.3.markdown",
  "@markup.heading.4.markdown",
  "@markup.heading.5.markdown",
  "@markup.heading.6.markdown",
  "@markup.heading.markdown",
  "@markup.strong.markdown",
  "@markup.emphasis.markdown",
  "@markup.strikethrough.markdown",
  "@markup.code.markdown",
  "@markup.raw.markdown",
  "@markup.raw.markdown_inline",
  "@markup.link.markdown",
  "@markup.list.markdown",
  "@markup.quote.markdown",
  // LSP semantic token groups
  "@lsp.type.variable",
  "@lsp.type.function",
  "@lsp.type.keyword",
  "@lsp.type.string",
  "@lsp.type.comment",
  "@lsp.type.type",
  "@lsp.type.constant",
] as const;

/**
 * Union type of all available highlight groups for type safety.
 * Includes both predefined groups and custom highlight groups (strings).
 */
export type HLGroup = (typeof HL_GROUPS)[number];

/**
 * Custom color styling when semantic groups aren't sufficient.
 * Use sparingly to maintain colorscheme compatibility.
 */
export type ColorStyle = {
  fg?: string;
  bg?: string;
};

/**
 * Branded type for tracking extmark IDs from Neovim.
 */
export type ExtmarkId = number & { __extmarkId: true };

/**
 * Comprehensive options for nvim_buf_set_extmark.
 * Covers all available extmark functionality.
 */
export type ExtmarkOptions = {
  // Basic highlighting
  hl_group?: HLGroup | HLGroup[];
  hl_eol?: boolean;
  hl_mode?: "replace" | "combine" | "blend";
  priority?: number;

  // Line-level styling
  line_hl_group?: HLGroup;

  // Sign column
  sign_text?: string;
  sign_hl_group?: HLGroup;

  // Line number styling
  number_hl_group?: HLGroup;

  // Virtual text
  virt_text?: Array<[string, HLGroup]>;
  virt_text_pos?: "overlay" | "eol" | "right_align" | "inline";
  virt_text_win_col?: number;
  virt_text_hide?: boolean;
  virt_text_repeat_linebreak?: boolean;

  // Virtual lines
  virt_lines?: Array<Array<[string, HLGroup]>>;
  virt_lines_above?: boolean;
  virt_lines_leftcol?: boolean;

  // Advanced features
  conceal?: string;
  url?: string;

  // Position control
  right_gravity?: boolean;
  end_right_gravity?: boolean;
  strict?: boolean;

  // Persistence
  undo_restore?: boolean;
  invalidate?: boolean;
  ephemeral?: boolean;
};

/**
 * Compare two ExtmarkOptions objects for equality.
 * Used for efficient diffing during updates to avoid unnecessary extmark operations.
 */
export function extmarkOptionsEqual(
  options1: ExtmarkOptions | undefined,
  options2: ExtmarkOptions | undefined,
): boolean {
  // Both undefined - equal
  if (options1 === undefined && options2 === undefined) {
    return true;
  }

  // One undefined, one defined - not equal
  if (options1 === undefined || options2 === undefined) {
    return false;
  }

  // Compare all relevant properties
  const hlGroupsEqual =
    Array.isArray(options1.hl_group) && Array.isArray(options2.hl_group)
      ? options1.hl_group.length === options2.hl_group.length &&
        options1.hl_group.every((group, i) => group === options2.hl_group![i])
      : options1.hl_group === options2.hl_group;

  // Compare virtual text arrays
  const virtTextEqual =
    (options1.virt_text === undefined && options2.virt_text === undefined) ||
    (Array.isArray(options1.virt_text) &&
      Array.isArray(options2.virt_text) &&
      options1.virt_text.length === options2.virt_text.length &&
      options1.virt_text.every(
        ([text1, hl1], i) =>
          options2.virt_text![i][0] === text1 &&
          options2.virt_text![i][1] === hl1,
      ));

  // Compare virtual lines arrays
  const virtLinesEqual =
    (options1.virt_lines === undefined && options2.virt_lines === undefined) ||
    (Array.isArray(options1.virt_lines) &&
      Array.isArray(options2.virt_lines) &&
      options1.virt_lines.length === options2.virt_lines.length &&
      options1.virt_lines.every(
        (line1, i) =>
          Array.isArray(options2.virt_lines![i]) &&
          line1.length === options2.virt_lines![i].length &&
          line1.every(
            ([text1, hl1], j) =>
              options2.virt_lines![i][j][0] === text1 &&
              options2.virt_lines![i][j][1] === hl1,
          ),
      ));

  return (
    hlGroupsEqual &&
    options1.hl_eol === options2.hl_eol &&
    options1.hl_mode === options2.hl_mode &&
    options1.priority === options2.priority &&
    options1.line_hl_group === options2.line_hl_group &&
    options1.sign_text === options2.sign_text &&
    options1.sign_hl_group === options2.sign_hl_group &&
    options1.number_hl_group === options2.number_hl_group &&
    virtTextEqual &&
    options1.virt_text_pos === options2.virt_text_pos &&
    options1.virt_text_win_col === options2.virt_text_win_col &&
    options1.virt_text_hide === options2.virt_text_hide &&
    options1.virt_text_repeat_linebreak ===
      options2.virt_text_repeat_linebreak &&
    virtLinesEqual &&
    options1.virt_lines_above === options2.virt_lines_above &&
    options1.virt_lines_leftcol === options2.virt_lines_leftcol &&
    options1.conceal === options2.conceal &&
    options1.url === options2.url &&
    options1.right_gravity === options2.right_gravity &&
    options1.end_right_gravity === options2.end_right_gravity &&
    options1.strict === options2.strict &&
    options1.undo_restore === options2.undo_restore &&
    options1.invalidate === options2.invalidate &&
    options1.ephemeral === options2.ephemeral
  );
}
