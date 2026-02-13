import { type Nvim } from "./nvim/nvim-node";
import type { NvimBuffer } from "./nvim/buffer.ts";
import type { PositionString } from "./nvim/window.ts";

export class Lsp {
  private requestCounter = 0;
  private requests: {
    [requestId: string]:
      | {
          type: "hover";
          resolve: (result: LspHoverResponse) => void;
          reject: (err: Error) => void;
        }
      | {
          type: "find_references";
          resolve: (result: LspReferencesResponse) => void;
          reject: (err: Error) => void;
        }
      | {
          type: "definition";
          resolve: (result: LspDefinitionResponse) => void;
          reject: (err: Error) => void;
        }
      | {
          type: "type_definition";
          resolve: (result: LspTypeDefinitionResponse) => void;
          reject: (err: Error) => void;
        };
  } = {};

  constructor(private nvim: Nvim) {}

  requestHover(
    buffer: NvimBuffer,
    pos: PositionString,
  ): Promise<LspHoverResponse> {
    return new Promise<LspHoverResponse>((resolve, reject) => {
      const requestId = this.getRequestId();
      this.requests[requestId] = { type: "hover", resolve, reject };

      this.nvim.logger.debug(`Initiating hover command...`);
      this.nvim
        .call("nvim_exec_lua", [
          `require('magenta').lsp_hover_request("${requestId}", ${buffer.id}, ${pos.row}, ${pos.col})`,
          [],
        ])
        .catch((...args: string[][]) => {
          this.nvim.logger.error(`lsp request error: ${JSON.stringify(args)}`);
          this.rejectRequest(
            requestId,
            new Error(args[0][1] as unknown as string),
          );
        });
    });
  }

  requestReferences(
    buffer: NvimBuffer,
    pos: PositionString,
  ): Promise<LspReferencesResponse> {
    return new Promise((resolve, reject) => {
      const requestId = this.getRequestId();
      this.requests[requestId] = { type: "find_references", resolve, reject };

      this.nvim.logger.debug(`Initiating references command...`);
      this.nvim
        .call("nvim_exec_lua", [
          `require('magenta').lsp_references_request("${requestId}", ${buffer.id}, ${pos.row}, ${pos.col})`,
          [],
        ])
        .catch((err: Error) => {
          this.rejectRequest(requestId, err);
        });
    });
  }

  requestDefinition(
    buffer: NvimBuffer,
    pos: PositionString,
  ): Promise<LspDefinitionResponse> {
    return new Promise((resolve, reject) => {
      const requestId = this.getRequestId();
      this.requests[requestId] = { type: "definition", resolve, reject };

      this.nvim.logger.debug(`Initiating definition command...`);
      this.nvim
        .call("nvim_exec_lua", [
          `require('magenta').lsp_definition_request("${requestId}", ${buffer.id}, ${pos.row}, ${pos.col})`,
          [],
        ])
        .catch((err: Error) => {
          this.rejectRequest(requestId, err);
        });
    });
  }

  requestTypeDefinition(
    buffer: NvimBuffer,
    pos: PositionString,
  ): Promise<LspTypeDefinitionResponse> {
    return new Promise((resolve, reject) => {
      const requestId = this.getRequestId();
      this.requests[requestId] = { type: "type_definition", resolve, reject };

      this.nvim.logger.debug(`Initiating type definition command...`);
      this.nvim
        .call("nvim_exec_lua", [
          `require('magenta').lsp_type_definition_request("${requestId}", ${buffer.id}, ${pos.row}, ${pos.col})`,
          [],
        ])
        .catch((err: Error) => {
          this.rejectRequest(requestId, err);
        });
    });
  }

  private rejectRequest(requestId: string, error: Error) {
    const request = this.requests[requestId];
    if (request) {
      delete this.requests[requestId];
      request.reject(error);
    }
  }

  private getRequestId() {
    const id = this.requestCounter.toString();
    this.requestCounter += 1;
    return id;
  }

  onLspResponse(result: unknown) {
    this.nvim.logger.debug(`onLspResponse: ${JSON.stringify(result)}`);

    // Check if result is an error string (from LSP timeout/attach failure)
    if (typeof result === "string") {
      this.nvim.logger.error(`LSP error: ${result}`);
      // We can't reject because we don't have the requestId
      // This shouldn't happen in practice since Lua should wrap it properly
      return;
    }

    const [[[requestId, res]]] = result as [[[number, unknown]]];
    const request = this.requests[requestId];
    if (!request) {
      throw new Error(
        `Expected to find lsp request with id ${requestId} but found none.`,
      );
    }

    // Check if res is an error string
    if (typeof res === "string") {
      delete this.requests[requestId];
      request.reject(new Error(res));
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    request.resolve(res as any);
  }
}

// LSP Protocol types - these document what we expect from vim.lsp.buf_request_all responses

type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

type LspHoverResponse = (null | {
  result: {
    range: LspRange;
    contents: {
      kind: string;
      value: string;
    };
  };
})[];

type LspReferencesResponse = (null | {
  result: {
    uri: string;
    range: LspRange;
  }[];
})[];

// Definition responses can have two formats:
// 1. Simple format with uri and range
// 2. LSP LocationLink format with targetUri and targetRange
export type LspDefinitionResponse = (null | {
  result: (
    | {
        uri: string;
        range: LspRange;
      }
    | {
        targetUri: string;
        targetRange: LspRange;
        targetSelectionRange?: LspRange;
        originSelectionRange?: LspRange;
      }
  )[];
})[];

type LspTypeDefinitionResponse = (null | {
  result: (
    | {
        uri: string;
        range: LspRange;
      }
    | {
        targetUri: string;
        targetRange: LspRange;
        targetSelectionRange?: LspRange;
        originSelectionRange?: LspRange;
      }
  )[];
})[];
