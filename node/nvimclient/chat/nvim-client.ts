import type {
  ClientEffectHandler,
  ClientNotification,
  LspRequest,
} from "@magenta/server";
import { createClientEffectHandler, isJsonValue } from "@magenta/server";
import { NvimAuthUI } from "../auth/auth-ui.ts";
import type { Lsp } from "../capabilities/lsp.ts";
import { NvimLspClient } from "../capabilities/lsp-client-adapter.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { reloadBufferIfOpen } from "../utils/buffers.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { expandClientCommand } from "./commands/client-commands.ts";

/** Handles the effects the server requests of this Neovim instance. */
export async function createNvimClient({
  nvim,
  lsp,
  cwd,
  homeDir,
}: {
  nvim: Nvim;
  lsp: Lsp;
  cwd: NvimCwd;
  homeDir: HomeDir;
}): Promise<ClientEffectHandler> {
  const neovimVersion = String(await nvim.call("nvim_eval", ["v:version"]));
  const authUI = new NvimAuthUI(nvim);

  function lspRequest(req: LspRequest) {
    const client = new NvimLspClient(lsp, nvim, req.projectDir, req.homeDir);
    switch (req.kind) {
      case "hover":
        return client.requestHover(req.filePath, req.position);
      case "references":
        return client.requestReferences(req.filePath, req.position);
      case "definition":
        return client.requestDefinition(req.filePath, req.position);
      case "typeDefinition":
        return client.requestTypeDefinition(req.filePath, req.position);
    }
  }

  return createClientEffectHandler({
    neovimVersion,
    handlers: {
      lsp: lspRequest,
      async lua(req) {
        const value: unknown = await nvim.call("nvim_exec_lua", [req.code, []]);
        // lua `nil` arrives as msgpack nil.
        if (value === null || value === undefined) return undefined;
        if (!isJsonValue(value)) {
          throw new Error("nvim_exec_lua returned a non-JSON value");
        }
        return value;
      },
      expandClientCommand: (req) =>
        expandClientCommand(req.command, { nvim, cwd, homeDir }),
      oauth: async (req) => ({ code: await authUI.showOAuthFlow(req.authUrl) }),
      async fileWritten(req) {
        await reloadBufferIfOpen({ nvim, cwd, homeDir }, req.absPath);
        return undefined;
      },
    },
    notify(n: ClientNotification) {
      switch (n.type) {
        case "loginProgress":
          return authUI.showLoginProgress(n.chunk);
        case "authError":
          return authUI.showError(n.message);
      }
    },
  });
}
