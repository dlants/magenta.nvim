import type { Nvim } from "../nvim/nvim-node/index.ts";
import { parseLsResponse } from "./lsBuffers.ts";

export async function getBuffersList(nvim: Nvim): Promise<string> {
  const lsResponse = await nvim.call("nvim_exec2", ["ls", { output: true }]);

  const result = parseLsResponse(lsResponse.output as string);
  return result
    .map((bufEntry) => {
      let out = "";
      if (bufEntry.flags.active) {
        out += "active ";
      }
      if (bufEntry.flags.modified) {
        out += "modified ";
      }
      if (bufEntry.flags.terminal) {
        out += "terminal ";
      }
      out += bufEntry.filePath;
      return out;
    })
    .join("\n");
}
