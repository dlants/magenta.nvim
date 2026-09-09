import type { CompletedToolInfo, RunScript } from "@magenta/server";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import { d, type VDOMNode, withBindings } from "../tea/view.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { RenderContext } from "./index.ts";

export function renderResult(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode | undefined {
  const input = info.request.input as RunScript.Input;
  const entry = context.chat.scriptRunner
    ?.getScriptCatalog()
    .find((c) => c.name === input.scriptName);
  if (!entry) {
    return undefined;
  }

  return withBindings(d`\n📄 ${entry.file}`, {
    "<CR>": () => {
      openFileInNonMagentaWindow(
        entry.file as UnresolvedFilePath,
        context,
      ).catch((e: Error) => context.nvim.logger.error(e.message));
    },
  });
}
