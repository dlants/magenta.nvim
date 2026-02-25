import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pollUntil, Defer } from "../../utils/async.ts";
import type { ServerName } from "./types.ts";
import type { MCPMockToolConfig, MCPMockToolSchemaType } from "./options.ts";
import { z } from "zod";
import { assertUnreachable } from "../../utils/assertUnreachable.ts";

export class MockToolStub {
  public calls: Array<{ args: unknown; result: unknown }> = [];
  private pendingCalls: Array<{ args: unknown; defer: Defer<unknown> }> = [];

  constructor(public name: string) {}

  async awaitCall(timeout = 1000): Promise<{ args: unknown }> {
    return pollUntil(
      () => {
        const call = this.pendingCalls[0];
        if (!call) {
          throw new Error(`No pending call to tool ${this.name}`);
        }
        return call;
      },
      { timeout },
    );
  }

  respondWith(result: unknown): void {
    const call = this.pendingCalls.shift();
    if (call) {
      call.defer.resolve(result);
      this.calls.push({ args: call.args, result });
    }
  }

  respondWithError(error: string): void {
    const call = this.pendingCalls.shift();
    if (call) {
      call.defer.reject(new Error(error));
      this.calls.push({ args: call.args, result: error });
    }
  }

  async invoke(args: unknown): Promise<unknown> {
    const defer = new Defer<unknown>();
    this.pendingCalls.push({ args, defer });
    return defer.promise;
  }

  clearCalls(): void {
    this.calls = [];
    this.pendingCalls = [];
  }
}

export class MockMCPServer {
  private server: McpServer;
  private transport: InMemoryTransport | undefined;
  private clientTransport: InMemoryTransport | undefined;
  private tools: MCPMockToolConfig[];
  public toolCalls: Array<{ name: string; args: unknown; result: unknown }> =
    [];
  private toolStubs: Map<string, MockToolStub> = new Map();

  constructor(
    public serverName: ServerName,
    tools: MCPMockToolConfig[] = [],
  ) {
    this.tools = tools;
    this.server = new McpServer(
      {
        name: serverName,
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupTools();
    mockServers[this.serverName] = this;
  }

  private createZodSchema(inputSchema: {
    [param: string]: MCPMockToolSchemaType;
  }): z.ZodRawShape {
    const shape: z.ZodRawShape = {};

    for (const [key, type] of Object.entries(inputSchema)) {
      switch (type) {
        case "string":
          shape[key] = z.string();
          break;
        case "number":
          shape[key] = z.number();
          break;
        case "boolean":
          shape[key] = z.boolean();
          break;

        default:
          assertUnreachable(type);
      }
    }

    return shape;
  }

  private setupTools(): void {
    // Create stubs and register tools with the server using the proper API
    for (const tool of this.tools) {
      const stub = new MockToolStub(tool.name);
      this.toolStubs.set(tool.name, stub);

      if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
        const zodShape = this.createZodSchema(tool.inputSchema);

        this.server.registerTool(
          tool.name,
          {
            description: tool.description || "",
            inputSchema: zodShape,
          },
          async (args) => {
            try {
              const result = await stub.invoke(args);
              return {
                content: [
                  {
                    type: "text",
                    text:
                      typeof result === "string"
                        ? result
                        : JSON.stringify(result),
                  },
                ],
              };
            } catch (error) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }
          },
        );
      } else {
        // Tool without input schema
        this.server.tool(tool.name, tool.description || "", async () => {
          try {
            const result = await stub.invoke(undefined);
            return {
              content: [
                {
                  type: "text",
                  text:
                    typeof result === "string"
                      ? result
                      : JSON.stringify(result),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          }
        });
      }
    }
  }

  async start(): Promise<InMemoryTransport> {
    // Create paired transports for in-memory communication
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    this.transport = serverTransport;
    this.clientTransport = clientTransport;

    await this.server.connect(this.transport);

    return this.clientTransport;
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }
    if (this.clientTransport) {
      await this.clientTransport.close();
      this.clientTransport = undefined;
    }
  }

  async awaitToolCall(
    toolName: string,
    timeout = 1000,
  ): Promise<{ name: string; args: unknown; result: unknown }> {
    return pollUntil(
      () => {
        const call = this.toolCalls.find((c) => c.name === toolName);
        if (!call) {
          throw new Error(`No call to tool ${toolName} found`);
        }
        return call;
      },
      { timeout },
    );
  }

  async awaitToolStub(toolName: string, timeout = 1000): Promise<MockToolStub> {
    return pollUntil(
      () => {
        const stub = this.toolStubs.get(toolName);
        if (!stub) {
          throw new Error(`Tool stub ${toolName} not found`);
        }
        return stub;
      },
      { timeout },
    );
  }

  clearToolCalls(): void {
    this.toolCalls = [];
  }
}

export const mockServers: { [serverName: ServerName]: MockMCPServer } = {};
