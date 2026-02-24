import type { Nvim } from "../nvim/nvim-node/index.ts";
import { parseLsResponse } from "./lsBuffers.ts";
import {
  resolveFilePath,
  type NvimCwd,
  type HomeDir,
  type UnresolvedFilePath,
  type AbsFilePath,
} from "./files.ts";

export type DiagnosticsRes = {
  end_col: number;
  message: string;
  namespace: number;
  col: number;
  code: number;
  end_lnum: number;
  source: string;
  lnum: number;
  user_data: {
    lsp: {
      code: number;
      message: string;
      range: {
        start: {
          character: number;
          line: number;
        };
        end: {
          character: number;
          line: number;
        };
      };
      tags: [];
      source: string;
      severity: number;
    };
  };
  bufnr: number;
  severity: number;
};

export async function getDiagnostics(
  nvim: Nvim,
  cwd: NvimCwd,
  homeDir: HomeDir,
): Promise<string> {
  nvim.logger.debug(`Getting diagnostics`);

  let diagnostics: DiagnosticsRes[];
  try {
    diagnostics = (await nvim.call("nvim_exec_lua", [
      `return vim.diagnostic.get(nil)`,
      [],
    ])) as DiagnosticsRes[];
  } catch (e) {
    throw new Error(`failed to nvim_exec_lua: ${JSON.stringify(e)}`);
  }

  const lsResponse = await nvim.call("nvim_exec2", ["ls", { output: true }]);

  const result = parseLsResponse(lsResponse.output as string);
  const bufMap: { [bufId: string]: AbsFilePath } = {};
  for (const res of result) {
    bufMap[res.id] = resolveFilePath(
      cwd,
      res.filePath as UnresolvedFilePath,
      homeDir,
    );
  }

  const content = diagnostics
    .map(
      (d) =>
        `file: ${bufMap[d.bufnr]} source: ${d.source}, severity: ${d.severity}, message: "${d.message}"`,
    )
    .join("\n");

  nvim.logger.debug(`got diagnostics content: ${content}`);
  return content;
}
