import type { Nvim } from "./nvim-node/index.ts";

export async function openUrl(url: string, nvim: Nvim): Promise<void> {
  const escaped = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await nvim.call("nvim_exec_lua", [`vim.ui.open("${escaped}")`, []]);
}
