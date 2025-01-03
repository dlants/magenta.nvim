import Anthropic from "@anthropic-ai/sdk";
import * as ToolManager from "../tools/toolManager.ts";
import { extendError, type Result } from "../utils/result.ts";
import type { Nvim } from "bunvim";
import type { StopReason, Provider, ProviderMessage } from "./provider.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";

export class AnthropicProvider implements Provider {
  private client: Anthropic;

  constructor(private nvim: Nvim) {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("Anthropic API key not found in config or environment");
    }

    this.client = new Anthropic({
      apiKey,
    });
  }

  async sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }> {
    const buf: string[] = [];
    let flushInProgress: boolean = false;

    const flushBuffer = () => {
      if (buf.length && !flushInProgress) {
        const text = buf.join("");
        buf.splice(0);

        flushInProgress = true;

        try {
          onText(text);
        } finally {
          flushInProgress = false;
          setInterval(flushBuffer, 1);
        }
      }
    };

    const anthropicMessages = messages.map((m): Anthropic.MessageParam => {
      let content: Anthropic.MessageParam["content"];
      if (typeof m.content == "string") {
        content = m.content;
      } else {
        content = m.content.map((c): Anthropic.ContentBlockParam => {
          switch (c.type) {
            case "text":
              return c;
            case "tool_use":
              return {
                id: c.request.id,
                input: c.request.input,
                name: c.request.name,
                type: "tool_use",
              };
            case "tool_result":
              return {
                tool_use_id: c.id,
                type: "tool_result",
                content:
                  c.result.status == "ok" ? c.result.value : c.result.error,
                is_error: c.result.status == "error",
              };
            default:
              assertUnreachable(c);
          }
        });
      }

      return {
        role: m.role,
        content,
      };
    });

    const stream = this.client.messages
      .stream({
        messages: anthropicMessages,
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 4096,
        system: `\
You are a coding assistant to a software engineer, inside a neovim plugin called magenta.nvim .
Be concise.
Do not narrate tool use.
You can use multiple tools at once, so try to minimize round trips.
First understand what’s already working - do not change or delete or break existing functionality.
Look for the simplest possible fix.
Avoid introducing unnecessary complexity.
Don’t introduce new technologies without asking.
Follow existing patterns and code structure.`,
        tool_choice: {
          type: "auto",
          disable_parallel_tool_use: false,
        },
        tools: ToolManager.TOOL_SPECS as Anthropic.Tool[],
      })
      .on("text", (text: string) => {
        buf.push(text);
        flushBuffer();
      })
      .on("error", onError)
      .on("inputJson", (_delta, snapshot) => {
        this.nvim.logger?.debug(
          `anthropic stream inputJson: ${JSON.stringify(snapshot)}`,
        );
      });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response: Anthropic.Message = await stream.finalMessage();

    if (response.stop_reason === "max_tokens") {
      onError(new Error("Response exceeded max_tokens limit"));
    }

    const toolRequests: Result<
      ToolManager.ToolRequest,
      { rawRequest: unknown }
    >[] = response.content
      .filter((req) => req.type == "tool_use")
      .map((req) => {
        const result = ((): Result<ToolManager.ToolRequest> => {
          if (typeof req != "object" || req == null) {
            return { status: "error", error: "received a non-object" };
          }

          const name = (
            req as unknown as { [key: string]: unknown } | undefined
          )?.["name"];

          if (typeof req.name != "string") {
            return {
              status: "error",
              error: "expected req.name to be string",
            };
          }

          const req2 = req as unknown as { [key: string]: unknown };

          if (req2.type != "tool_use") {
            return {
              status: "error",
              error: "expected req.type to be tool_use",
            };
          }

          if (typeof req2.id != "string") {
            return { status: "error", error: "expected req.id to be a string" };
          }

          if (typeof req2.input != "object" || req2.input == null) {
            return {
              status: "error",
              error: "expected req.input to be an object",
            };
          }

          const input = ToolManager.validateToolInput(
            name,
            req2.input as { [key: string]: unknown },
          );

          if (input.status == "ok") {
            return {
              status: "ok",
              value: {
                name: name as ToolManager.ToolRequest["name"],
                id: req2.id as unknown as ToolRequestId,
                input: input.value,
              },
            };
          } else {
            return input;
          }
        })();

        return extendError(result, { rawRequest: req });
      });

    this.nvim.logger?.debug("toolRequests: " + JSON.stringify(toolRequests));
    this.nvim.logger?.debug("stopReason: " + response.stop_reason);
    return { toolRequests, stopReason: response.stop_reason || "end_turn" };
  }
}
