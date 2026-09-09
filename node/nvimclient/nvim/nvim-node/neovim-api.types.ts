/* eslint @typescript-eslint/no-invalid-void-type: 0 */

import type { EventsMap } from "./types.ts";

type ui_options = [
  "rgb",
  "ext_cmdline",
  "ext_popupmenu",
  "ext_tabline",
  "ext_wildmenu",
  "ext_messages",
  "ext_linegrid",
  "ext_multigrid",
  "ext_hlstate",
  "ext_termcolors",
];

export type NeovimApi<
  Notifications extends EventsMap = EventsMap,
  Requests extends EventsMap = EventsMap,
> = {
  functions: {
    nvim_get_autocmds: {
      parameters: [opts: Record<string, unknown>];
      return_type: unknown[];
    };
    nvim_create_autocmd: {
      parameters: [event: unknown, opts: Record<string, unknown>];
      return_type: number;
    };
    nvim_del_autocmd: {
      parameters: [id: number];
      return_type: undefined;
    };
    nvim_clear_autocmds: {
      parameters: [opts: Record<string, unknown>];
      return_type: undefined;
    };
    nvim_create_augroup: {
      parameters: [name: string, opts: Record<string, unknown>];
      return_type: number;
    };
    nvim_del_augroup_by_id: {
      parameters: [id: number];
      return_type: undefined;
    };
    nvim_del_augroup_by_name: {
      parameters: [name: string];
      return_type: undefined;
    };
    nvim_exec_autocmds: {
      parameters: [event: unknown, opts: Record<string, unknown>];
      return_type: undefined;
    };
    nvim_buf_line_count: {
      parameters: [buffer: number];
      return_type: number;
    };
    nvim_buf_attach: {
      parameters: [
        buffer: number,
        send_buffer: boolean,
        opts: Record<string, unknown>,
      ];
      return_type: boolean;
    };
    nvim_buf_detach: {
      parameters: [buffer: number];
      return_type: boolean;
    };
    nvim_buf_get_lines: {
      parameters: [
        buffer: number,
        start: number,
        end: number,
        strict_indexing: boolean,
      ];
      return_type: string[];
    };
    nvim_buf_set_lines: {
      parameters: [
        buffer: number,
        start: number,
        end: number,
        strict_indexing: boolean,
        replacement: string[],
      ];
      return_type: undefined;
    };
    nvim_buf_set_text: {
      parameters: [
        buffer: number,
        start_row: number,
        start_col: number,
        end_row: number,
        end_col: number,
        replacement: string[],
      ];
      return_type: undefined;
    };
    nvim_buf_get_text: {
      parameters: [
        buffer: number,
        start_row: number,
        start_col: number,
        end_row: number,
        end_col: number,
        opts: Record<string, unknown>,
      ];
      return_type: string[];
    };
    nvim_buf_get_offset: {
      parameters: [buffer: number, index: number];
      return_type: number;
    };
    nvim_buf_get_var: {
      parameters: [buffer: number, name: string];
      return_type: unknown;
    };
    nvim_buf_get_changedtick: {
      parameters: [buffer: number];
      return_type: number;
    };
    nvim_buf_get_keymap: {
      parameters: [buffer: number, mode: string];
      return_type: Record<string, unknown>[];
    };
    nvim_buf_set_keymap: {
      parameters: [
        buffer: number,
        mode: string,
        lhs: string,
        rhs: string,
        opts: Record<string, unknown>,
      ];
      return_type: undefined;
    };
    nvim_buf_del_keymap: {
      parameters: [buffer: number, mode: string, lhs: string];
      return_type: undefined;
    };
    nvim_buf_set_var: {
      parameters: [buffer: number, name: string, value: unknown];
      return_type: undefined;
    };
    nvim_buf_del_var: {
      parameters: [buffer: number, name: string];
      return_type: undefined;
    };
    nvim_buf_get_name: {
      parameters: [buffer: number];
      return_type: string;
    };
    nvim_buf_set_name: {
      parameters: [buffer: number, name: string];
      return_type: undefined;
    };
    nvim_buf_is_loaded: {
      parameters: [buffer: number];
      return_type: boolean;
    };
    nvim_buf_delete: {
      parameters: [buffer: number, opts: Record<string, unknown>];
      return_type: undefined;
    };
    nvim_buf_is_valid: {
      parameters: [buffer: number];
      return_type: boolean;
    };
    nvim_buf_del_mark: {
      parameters: [buffer: number, name: string];
      return_type: boolean;
    };
    nvim_buf_set_mark: {
      parameters: [
        buffer: number,
        name: string,
        line: number,
        col: number,
        opts: Record<string, unknown>,
      ];
      return_type: boolean;
    };
    nvim_buf_get_mark: {
      parameters: [buffer: number, name: string];
      return_type: [number, number];
    };
    nvim_buf_call: {
      parameters: [buffer: number, fun: unknown];
      return_type: unknown;
    };
    nvim_parse_cmd: {
      parameters: [str: string, opts: Record<string, unknown>];
      return_type: Record<string, unknown>;
    };
    nvim_cmd: {
      parameters: [cmd: Record<string, unknown>, opts: Record<string, unknown>];
      return_type: string;
    };
    nvim_create_user_command: {
      parameters: [
        name: string,
        command: unknown,
        opts: Record<string, unknown>,
      ];
      return_type: undefined;
    };
    nvim_del_user_command: {
      parameters: [name: string];
      return_type: undefined;
    };
    nvim_buf_create_user_command: {
      parameters: [
        buffer: number,
        name: string,
        command: unknown,
        opts: Record<string, unknown>,
      ];
      return_type: undefined;
    };
    nvim_buf_del_user_command: {
      parameters: [buffer: number, name: string];
      return_type: undefined;
    };
    nvim_get_commands: {
      parameters: [opts: Record<string, unknown>];
      return_type: Record<string, unknown>;
    };
    nvim_buf_get_commands: {
      parameters: [buffer: number, opts: Record<string, unknown>];
      return_type: Record<string, unknown>;
    };
    nvim_get_option_info: {
      parameters: [name: string];
      return_type: Record<string, unknown>;
    };
    nvim_create_namespace: {
      parameters: [name: string];
      return_type: number;
    };
    nvim_get_namespaces: {
      parameters: [];
      return_type: Record<string, unknown>;
    };
    nvim_buf_get_extmark_by_id: {
      parameters: [
        buffer: number,
        ns_id: number,
        id: number,
        opts: Record<string, unknown>,
      ];
      return_type: number[];
    };
    nvim_buf_get_extmarks: {
      parameters: [
        buffer: number,
        ns_id: number,
        start: unknown,
        end: unknown,
        opts: Record<string, unknown>,
      ];
      return_type: unknown[];
    };
    nvim_buf_set_extmark: {
      parameters: [
        buffer: number,
        ns_id: number,
        line: number,
        col: number,
        opts: Record<string, unknown>,
      ];
      return_type: number;
    };
    nvim_buf_del_extmark: {
      parameters: [buffer: number, ns_id: number, id: number];
      return_type: boolean;
    };
    nvim_buf_add_highlight: {
      parameters: [
        buffer: number,
        ns_id: number,
        hl_group: string,
        line: number,
        col_start: number,
        col_end: number,
      ];
      return_type: number;
    };
    nvim_buf_clear_namespace: {
      parameters: [
        buffer: number,
        ns_id: number,
        line_start: number,
        line_end: number,
      ];
      return_type: undefined;
    };
    nvim_set_decoration_provider: {
      parameters: [ns_id: number, opts: Record<string, unknown>];
      return_type: undefined;
    };
    nvim_get_option_value: {
      parameters: [name: string, opts: Record<string, unknown>];
      return_type: unknown;
    };
    nvim_set_option_value: {
      parameters: [name: string, value: unknown, opts: Record<string, unknown>];
      return_type: undefined;
    };
    nvim_get_all_options_info: {
      parameters: [];
      return_type: Record<string, unknown>;
    };
    nvim_get_option_info2: {
      parameters: [name: string, opts: Record<string, unknown>];
      return_type: Record<string, unknown>;
    };
    nvim_set_option: {
      parameters: [name: string, value: unknown];
      return_type: undefined;
    };
    nvim_get_option: {
      parameters: [name: string];
      return_type: unknown;
    };
    nvim_buf_get_option: {
      parameters: [buffer: number, name: string];
      return_type: unknown;
    };
    nvim_buf_set_option: {
      parameters: [buffer: number, name: string, value: unknown];
      return_type: undefined;
    };
    nvim_win_get_option: {
      parameters: [window: number, name: string];
      return_type: unknown;
    };
    nvim_win_set_option: {
      parameters: [window: number, name: string, value: unknown];
      return_type: undefined;
    };
    nvim_tabpage_list_wins: {
      parameters: [tabpage: number];
      return_type: number[];
    };
    nvim_tabpage_get_var: {
      parameters: [tabpage: number, name: string];
      return_type: unknown;
    };
    nvim_tabpage_set_var: {
      parameters: [tabpage: number, name: string, value: unknown];
      return_type: undefined;
    };
    nvim_tabpage_del_var: {
      parameters: [tabpage: number, name: string];
      return_type: undefined;
    };
    nvim_tabpage_get_win: {
      parameters: [tabpage: number];
      return_type: number;
    };
    nvim_tabpage_get_number: {
      parameters: [tabpage: number];
      return_type: number;
    };
    nvim_tabpage_is_valid: {
      parameters: [tabpage: number];
      return_type: boolean;
    };
    nvim_ui_attach: {
      parameters: [
        width: number,
        height: number,
        options: Partial<Record<ui_options[number], unknown>>,
      ];
      return_type: undefined;
    };
    nvim_ui_set_focus: {
      parameters: [gained: boolean];
      return_type: undefined;
    };
    nvim_ui_detach: {
      parameters: [];
      return_type: undefined;
    };
    nvim_ui_try_resize: {
      parameters: [width: number, height: number];
      return_type: undefined;
    };
    nvim_ui_set_option: {
      parameters: [name: string, value: unknown];
      return_type: undefined;
    };
    nvim_ui_try_resize_grid: {
      parameters: [grid: number, width: number, height: number];
      return_type: undefined;
    };
    nvim_ui_pum_set_height: {
      parameters: [height: number];
      return_type: undefined;
    };
    nvim_ui_pum_set_bounds: {
      parameters: [width: number, height: number, row: number, col: number];
      return_type: undefined;
    };
    nvim_get_hl_id_by_name: {
      parameters: [name: string];
      return_type: number;
    };
    nvim_get_hl: {
      parameters: [ns_id: number, opts: Record<string, unknown>];
      return_type: Record<string, unknown>;
    };
    nvim_set_hl: {
      parameters: [ns_id: number, name: string, val: Record<string, unknown>];
      return_type: undefined;
    };
    nvim_set_hl_ns: {
      parameters: [ns_id: number];
      return_type: undefined;
    };
    nvim_set_hl_ns_fast: {
      parameters: [ns_id: number];
      return_type: undefined;
    };
    nvim_feedkeys: {
      parameters: [keys: string, mode: string, escape_ks: boolean];
      return_type: undefined;
    };
    nvim_input: {
      parameters: [keys: string];
      return_type: number;
    };
    nvim_input_mouse: {
      parameters: [
        button: string,
        action: string,
        modifier: string,
        grid: number,
        row: number,
        col: number,
      ];
      return_type: undefined;
    };
    nvim_replace_termcodes: {
      parameters: [
        str: string,
        from_part: boolean,
        do_lt: boolean,
        special: boolean,
      ];
      return_type: string;
    };
    nvim_exec_lua: {
      parameters: [code: string, args: unknown[]];
      return_type: unknown;
    };
    nvim_notify: {
      parameters: [
        msg: string,
        log_level: number,
        opts: Record<string, unknown>,
      ];
      return_type: unknown;
    };
    nvim_strwidth: {
      parameters: [text: string];
      return_type: number;
    };
    nvim_list_runtime_paths: {
      parameters: [];
      return_type: string[];
    };
    nvim_get_runtime_file: {
      parameters: [name: string, all: boolean];
      return_type: string[];
    };
    nvim_set_current_dir: {
      parameters: [dir: string];
      return_type: undefined;
    };
    nvim_get_current_line: {
      parameters: [];
      return_type: string;
    };
    nvim_set_current_line: {
      parameters: [line: string];
      return_type: undefined;
    };
    nvim_del_current_line: {
      parameters: [];
      return_type: undefined;
    };
    nvim_get_var: {
      parameters: [name: string];
      return_type: unknown;
    };
    nvim_set_var: {
      parameters: [name: string, value: unknown];
      return_type: undefined;
    };
    nvim_del_var: {
      parameters: [name: string];
      return_type: undefined;
    };
    nvim_get_vvar: {
      parameters: [name: string];
      return_type: unknown;
    };
    nvim_set_vvar: {
      parameters: [name: string, value: unknown];
      return_type: undefined;
    };
    nvim_echo: {
      parameters: [
        chunks: unknown[],
        history: boolean,
        opts: Record<string, unknown>,
      ];
      return_type: undefined;
    };
    nvim_out_write: {
      parameters: [str: string];
      return_type: undefined;
    };
    nvim_err_write: {
      parameters: [str: string];
      return_type: undefined;
    };
    nvim_err_writeln: {
      parameters: [str: string];
      return_type: undefined;
    };
    nvim_list_bufs: {
      parameters: [];
      return_type: number[];
    };
    nvim_get_current_buf: {
      parameters: [];
      return_type: number;
    };
    nvim_set_current_buf: {
      parameters: [buffer: number];
      return_type: undefined;
    };
    nvim_list_wins: {
      parameters: [];
      return_type: number[];
    };
    nvim_get_current_win: {
      parameters: [];
      return_type: number;
    };
    nvim_set_current_win: {
      parameters: [window: number];
      return_type: undefined;
    };
    nvim_create_buf: {
      parameters: [listed: boolean, scratch: boolean];
      return_type: number;
    };
    nvim_open_term: {
      parameters: [buffer: number, opts: Record<string, unknown>];
      return_type: number;
    };
    nvim_chan_send: {
      parameters: [chan: number, data: string];
      return_type: undefined;
    };
    nvim_list_tabpages: {
      parameters: [];
      return_type: number[];
    };
    nvim_get_current_tabpage: {
      parameters: [];
      return_type: number;
    };
    nvim_set_current_tabpage: {
      parameters: [tabpage: number];
      return_type: undefined;
    };
    nvim_paste: {
      parameters: [data: string, crlf: boolean, phase: number];
      return_type: boolean;
    };
    nvim_put: {
      parameters: [
        lines: string[],
        type: string,
        after: boolean,
        follow: boolean,
      ];
      return_type: undefined;
    };
    nvim_subscribe: {
      parameters: [event: string];
      return_type: undefined;
    };
    nvim_unsubscribe: {
      parameters: [event: string];
      return_type: undefined;
    };
    nvim_get_color_by_name: {
      parameters: [name: string];
      return_type: number;
    };
    nvim_get_color_map: {
      parameters: [];
      return_type: Record<string, unknown>;
    };
    nvim_get_context: {
      parameters: [opts: Record<string, unknown>];
      return_type: Record<string, unknown>;
    };
    nvim_load_context: {
      parameters: [dict: Record<string, unknown>];
      return_type: unknown;
    };
    nvim_get_mode: {
      parameters: [];
      return_type: Record<string, unknown>;
    };
    nvim_get_keymap: {
      parameters: [mode: string];
      return_type: Record<string, unknown>[];
    };
    nvim_set_keymap: {
      parameters: [
        mode: string,
        lhs: string,
        rhs: string,
        opts: Record<string, unknown>,
      ];
      return_type: undefined;
    };
    nvim_del_keymap: {
      parameters: [mode: string, lhs: string];
      return_type: undefined;
    };
    nvim_get_api_info: {
      parameters: [];
      return_type: unknown[];
    };
    nvim_set_client_info: {
      parameters: [
        name: string,
        version: Record<string, unknown>,
        type: string,
        methods: Record<string, unknown>,
        attributes: Record<string, unknown>,
      ];
      return_type: undefined;
    };
    nvim_get_chan_info: {
      parameters: [chan: number];
      return_type: Record<string, unknown>;
    };
    nvim_list_chans: {
      parameters: [];
      return_type: unknown[];
    };
    nvim_call_atomic: {
      parameters: [calls: unknown[]];
      return_type: unknown[];
    };
    nvim_list_uis: {
      parameters: [];
      return_type: unknown[];
    };
    nvim_get_proc_children: {
      parameters: [pid: number];
      return_type: unknown[];
    };
    nvim_get_proc: {
      parameters: [pid: number];
      return_type: unknown;
    };
    nvim_select_popupmenu_item: {
      parameters: [
        item: number,
        insert: boolean,
        finish: boolean,
        opts: Record<string, unknown>,
      ];
      return_type: undefined;
    };
    nvim_del_mark: {
      parameters: [name: string];
      return_type: boolean;
    };
    nvim_get_mark: {
      parameters: [name: string, opts: Record<string, unknown>];
      return_type: unknown[];
    };
    nvim_eval_statusline: {
      parameters: [str: string, opts: Record<string, unknown>];
      return_type: Record<string, unknown>;
    };
    nvim_exec2: {
      parameters: [src: string, opts: Record<string, unknown>];
      return_type: Record<string, unknown>;
    };
    nvim_command: {
      parameters: [command: string];
      return_type: undefined;
    };
    nvim_eval: {
      parameters: [expr: string];
      return_type: unknown;
    };
    nvim_call_function: {
      parameters: [fn: string, args: unknown[]];
      return_type: unknown;
    };
    nvim_call_dict_function: {
      parameters: [dict: unknown, fn: string, args: unknown[]];
      return_type: unknown;
    };
    nvim_parse_expression: {
      parameters: [expr: string, flags: string, highlight: boolean];
      return_type: Record<string, unknown>;
    };
    nvim_open_win: {
      parameters: [
        buffer: number,
        enter: boolean,
        config: Record<string, unknown>,
      ];
      return_type: number;
    };
    nvim_win_set_config: {
      parameters: [window: number, config: Record<string, unknown>];
      return_type: undefined;
    };
    nvim_win_get_config: {
      parameters: [window: number];
      return_type: Record<string, unknown>;
    };
    nvim_win_get_buf: {
      parameters: [window: number];
      return_type: number;
    };
    nvim_win_set_buf: {
      parameters: [window: number, buffer: number];
      return_type: undefined;
    };
    nvim_win_get_cursor: {
      parameters: [window: number];
      return_type: [number, number];
    };
    nvim_win_set_cursor: {
      parameters: [window: number, pos: [number, number]];
      return_type: undefined;
    };
    nvim_win_get_height: {
      parameters: [window: number];
      return_type: number;
    };
    nvim_win_set_height: {
      parameters: [window: number, height: number];
      return_type: undefined;
    };
    nvim_win_get_width: {
      parameters: [window: number];
      return_type: number;
    };
    nvim_win_set_width: {
      parameters: [window: number, width: number];
      return_type: undefined;
    };
    nvim_win_get_var: {
      parameters: [window: number, name: string];
      return_type: unknown;
    };
    nvim_win_set_var: {
      parameters: [window: number, name: string, value: unknown];
      return_type: undefined;
    };
    nvim_win_del_var: {
      parameters: [window: number, name: string];
      return_type: undefined;
    };
    nvim_win_get_position: {
      parameters: [window: number];
      return_type: [number, number];
    };
    nvim_win_get_tabpage: {
      parameters: [window: number];
      return_type: number;
    };
    nvim_win_get_number: {
      parameters: [window: number];
      return_type: number;
    };
    nvim_win_is_valid: {
      parameters: [window: number];
      return_type: boolean;
    };
    nvim_win_hide: {
      parameters: [window: number];
      return_type: undefined;
    };
    nvim_win_close: {
      parameters: [window: number, force: boolean];
      return_type: undefined;
    };
    nvim_win_call: {
      parameters: [window: number, fun: unknown];
      return_type: unknown;
    };
    nvim_win_set_hl_ns: {
      parameters: [window: number, ns_id: number];
      return_type: undefined;
    };
  };

  ui_events: {
    mode_info_set: {
      parameters: [enabled: boolean, cursor_styles: unknown[]];
    };
    update_menu: {
      parameters: [];
    };
    busy_start: {
      parameters: [];
    };
    busy_stop: {
      parameters: [];
    };
    mouse_on: {
      parameters: [];
    };
    mouse_off: {
      parameters: [];
    };
    mode_change: {
      parameters: [mode: string, mode_idx: number];
    };
    bell: {
      parameters: [];
    };
    visual_bell: {
      parameters: [];
    };
    flush: {
      parameters: [];
    };
    suspend: {
      parameters: [];
    };
    set_title: {
      parameters: [title: string];
    };
    set_icon: {
      parameters: [icon: string];
    };
    screenshot: {
      parameters: [path: string];
    };
    option_set: {
      parameters: [name: string, value: unknown];
    };
    update_fg: {
      parameters: [fg: number];
    };
    update_bg: {
      parameters: [bg: number];
    };
    update_sp: {
      parameters: [sp: number];
    };
    resize: {
      parameters: [width: number, height: number];
    };
    clear: {
      parameters: [];
    };
    eol_clear: {
      parameters: [];
    };
    cursor_goto: {
      parameters: [row: number, col: number];
    };
    highlight_set: {
      parameters: [attrs: Record<string, unknown>];
    };
    put: {
      parameters: [str: string];
    };
    set_scroll_region: {
      parameters: [top: number, bot: number, left: number, right: number];
    };
    scroll: {
      parameters: [count: number];
    };
    default_colors_set: {
      parameters: [
        rgb_fg: number,
        rgb_bg: number,
        rgb_sp: number,
        cterm_fg: number,
        cterm_bg: number,
      ];
    };
    hl_attr_define: {
      parameters: [
        id: number,
        rgb_attrs: Record<string, unknown>,
        cterm_attrs: Record<string, unknown>,
        info: unknown[],
      ];
    };
    hl_group_set: {
      parameters: [name: string, id: number];
    };
    grid_resize: {
      parameters: [grid: number, width: number, height: number];
    };
    grid_clear: {
      parameters: [grid: number];
    };
    grid_cursor_goto: {
      parameters: [grid: number, row: number, col: number];
    };
    grid_line: {
      parameters: [
        grid: number,
        row: number,
        col_start: number,
        data: unknown[],
        wrap: boolean,
      ];
    };
    grid_scroll: {
      parameters: [
        grid: number,
        top: number,
        bot: number,
        left: number,
        right: number,
        rows: number,
        cols: number,
      ];
    };
    grid_destroy: {
      parameters: [grid: number];
    };
    win_pos: {
      parameters: [
        grid: number,
        win: number,
        startrow: number,
        startcol: number,
        width: number,
        height: number,
      ];
    };
    win_float_pos: {
      parameters: [
        grid: number,
        win: number,
        anchor: string,
        anchor_grid: number,
        anchor_row: number,
        anchor_col: number,
        focusable: boolean,
        zindex: number,
      ];
    };
    win_external_pos: {
      parameters: [grid: number, win: number];
    };
    win_hide: {
      parameters: [grid: number];
    };
    win_close: {
      parameters: [grid: number];
    };
    msg_set_pos: {
      parameters: [
        grid: number,
        row: number,
        scrolled: boolean,
        sep_char: string,
      ];
    };
    win_viewport: {
      parameters: [
        grid: number,
        win: number,
        topline: number,
        botline: number,
        curline: number,
        curcol: number,
        line_count: number,
        scroll_delta: number,
      ];
    };
    win_extmark: {
      parameters: [
        grid: number,
        win: number,
        ns_id: number,
        mark_id: number,
        row: number,
        col: number,
      ];
    };
    popupmenu_show: {
      parameters: [
        items: unknown[],
        selected: number,
        row: number,
        col: number,
        grid: number,
      ];
    };
    popupmenu_hide: {
      parameters: [];
    };
    popupmenu_select: {
      parameters: [selected: number];
    };
    tabline_update: {
      parameters: [
        current: number,
        tabs: unknown[],
        current_buffer: number,
        buffers: unknown[],
      ];
    };
    cmdline_show: {
      parameters: [
        content: unknown[],
        pos: number,
        firstc: string,
        prompt: string,
        indent: number,
        level: number,
      ];
    };
    cmdline_pos: {
      parameters: [pos: number, level: number];
    };
    cmdline_special_char: {
      parameters: [c: string, shift: boolean, level: number];
    };
    cmdline_hide: {
      parameters: [level: number];
    };
    cmdline_block_show: {
      parameters: [lines: unknown[]];
    };
    cmdline_block_append: {
      parameters: [lines: unknown[]];
    };
    cmdline_block_hide: {
      parameters: [];
    };
    wildmenu_show: {
      parameters: [items: unknown[]];
    };
    wildmenu_select: {
      parameters: [selected: number];
    };
    wildmenu_hide: {
      parameters: [];
    };
    msg_show: {
      parameters: [kind: string, content: unknown[], replace_last: boolean];
    };
    msg_clear: {
      parameters: [];
    };
    msg_showcmd: {
      parameters: [content: unknown[]];
    };
    msg_showmode: {
      parameters: [content: unknown[]];
    };
    msg_ruler: {
      parameters: [content: unknown[]];
    };
    msg_history_show: {
      parameters: [entries: unknown[]];
    };
    msg_history_clear: {
      parameters: [];
    };
  };

  error_types: {
    Exception: { id: 0 };
    Validation: { id: 1 };
  };

  types: {
    Buffer: { id: 0; prefix: "nvim_buf_" };
    Window: { id: 1; prefix: "nvim_win_" };
    Tabpage: { id: 2; prefix: "nvim_tabpage_" };
  };

  notifications: Notifications;

  requests: Requests;
};
