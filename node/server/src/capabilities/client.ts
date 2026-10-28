import type {
  ClientEffectHandler,
  LspRequest,
  LspRequestKind,
} from "../protocol/client.ts";
import type { AbsFilePath, HomeDir, ProjectDir } from "../utils/files.ts";
import type { LspClient } from "./lsp-client.ts";
import type { LuaExecutor } from "./lua-executor.ts";

export type ClientCommandName =
  | "buf"
  | "buffers"
  | "qf"
  | "quickfix"
  | "diag"
  | "diagnostics";

/** Adapts client requests to the `LspClient` tools use; LSP paths resolve
 * against the thread projectDir. */
export function clientLspClient(
  client: ClientEffectHandler,
  projectDir: ProjectDir,
  homeDir: HomeDir,
): LspClient {
  const lsp =
    <K extends LspRequestKind>(kind: K) =>
    (filePath: AbsFilePath, position: LspRequest["position"]) =>
      client.request<LspRequest & { kind: K }>({
        type: "lsp",
        kind,
        projectDir,
        homeDir,
        filePath,
        position,
      });
  return {
    requestHover: lsp("hover"),
    requestReferences: lsp("references"),
    requestDefinition: lsp("definition"),
    requestTypeDefinition: lsp("typeDefinition"),
  };
}
export function clientLuaExecutor(client: ClientEffectHandler): LuaExecutor {
  return { execLua: (code) => client.request({ type: "lua", code }) };
}

export function clientFileWritten(
  client: ClientEffectHandler,
): ((absPath: AbsFilePath) => Promise<void>) | undefined {
  if (!client.info.notifiesFileWritten) return undefined;
  return (absPath) => client.request({ type: "fileWritten", absPath });
}
