import type { ClientCommandName } from "../capabilities/client.ts";
import type {
  LspDefinitionResponse,
  LspHoverResponse,
  LspReferencesResponse,
} from "../capabilities/lsp-client.ts";
import type { AgentInput } from "../providers/provider-types.ts";
import type { AbsFilePath, HomeDir, ProjectDir } from "../utils/files.ts";
import type { JsonValue } from "../utils/json.ts";

/** Derived by `createClientEffectHandler` from the handlers a client serves. */
export type ClientInfo = {
  neovimVersion: string;
  supportsAuthUI: boolean;
  notifiesFileWritten: boolean;
};

export type LspRequestKind =
  | "hover"
  | "references"
  | "definition"
  | "typeDefinition";

export type LspRequest = {
  type: "lsp";
  kind: LspRequestKind;
  projectDir: ProjectDir;
  homeDir: HomeDir;
  filePath: AbsFilePath;
  position: { line: number; character: number };
};

export type ClientRequest =
  | LspRequest
  | { type: "lua"; code: string }
  | { type: "expandClientCommand"; command: ClientCommandName; match: string }
  | { type: "oauth"; authUrl: string }
  | { type: "fileWritten"; absPath: AbsFilePath };

type LspResponseMap = {
  hover: LspHoverResponse;
  references: LspReferencesResponse;
  definition: LspDefinitionResponse;
  typeDefinition: LspDefinitionResponse;
};

export type ClientResponse<R extends ClientRequest> = R extends {
  type: "lsp";
  kind: infer K extends LspRequestKind;
}
  ? LspResponseMap[K]
  : R extends { type: "lua" }
    ? JsonValue | undefined
    : R extends { type: "expandClientCommand" }
      ? AgentInput[]
      : R extends { type: "oauth" }
        ? { code: string }
        : R extends { type: "fileWritten" }
          ? undefined
          : never;

type RequestOf<K extends ClientRequest["type"]> = Extract<
  ClientRequest,
  { type: K }
>;
export type ClientRequestHandlers = {
  [K in ClientRequest["type"]]: (
    req: RequestOf<K>,
  ) => Promise<ClientResponse<RequestOf<K>>>;
};
/** `oauth` and `fileWritten` are optional; `ClientInfo` flags are derived from
 * which of them the client handles, so the two cannot disagree. */
export type ClientRequestHandlerSet = Omit<
  ClientRequestHandlers,
  "oauth" | "fileWritten"
> &
  Partial<Pick<ClientRequestHandlers, "oauth" | "fileWritten">>;
export function createClientEffectHandler({
  neovimVersion,
  handlers,
  notify,
}: {
  neovimVersion: string;
  handlers: ClientRequestHandlerSet;
  notify: (n: ClientNotification) => void;
}): ClientEffectHandler {
  const lookup: Partial<ClientRequestHandlers> = handlers;
  return {
    info: {
      neovimVersion,
      supportsAuthUI: handlers.oauth !== undefined,
      notifiesFileWritten: handlers.fileWritten !== undefined,
    },
    request<R extends ClientRequest>(req: R): Promise<ClientResponse<R>> {
      const handler = lookup[req.type] as
        | ((req: R) => Promise<ClientResponse<R>>)
        | undefined;
      // The mapped type pairs each request type with its response type; TS
      // cannot correlate the indexed lookup with `R`, hence the one cast above.
      if (!handler) {
        return Promise.reject(
          new Error(`Client does not handle ${req.type} requests`),
        );
      }
      return handler(req);
    },
    notify,
  };
}
export type ClientNotification =
  | { type: "loginProgress"; chunk: string }
  | { type: "authError"; message: string };

/** The attached client, as data in both directions. Every capability the
 * server borrows from a client is a `ClientRequest` handled here. */
export interface ClientEffectHandler {
  info: ClientInfo;
  /** Rejection surfaces as the caller's error. Cancellation is a later
   * `cancel` request by id once there is a transport; in-process the server
   * drops the result. */
  request<R extends ClientRequest>(req: R): Promise<ClientResponse<R>>;
  notify(n: ClientNotification): void;
}
