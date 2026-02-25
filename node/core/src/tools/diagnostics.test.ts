import { describe, it, expect } from "vitest";
import * as Diagnostics from "./diagnostics.ts";
import type { DiagnosticsProvider } from "../capabilities/diagnostics-provider.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";

function createMockProvider(
  getDiagnostics: DiagnosticsProvider["getDiagnostics"],
): DiagnosticsProvider {
  return { getDiagnostics };
}

async function getResultText(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<string> {
  const result = await invocation.promise;
  if (result.result.status === "ok") {
    return (result.result.value[0] as { type: "text"; text: string }).text;
  }
  return result.result.error;
}

describe("diagnostics unit tests", () => {
  it("returns diagnostics from provider", async () => {
    const diagnosticText = 'file: test.ts severity: 1, message: "error"';
    const provider = createMockProvider(() => Promise.resolve(diagnosticText));

    const invocation = Diagnostics.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "diagnostics" as const,
        input: {},
      },
      { diagnosticsProvider: provider },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    const text = await getResultText(invocation);
    expect(text).toBe(diagnosticText);
  });

  it("returns error when provider throws", async () => {
    const provider = createMockProvider(() =>
      Promise.reject(new Error("LSP not ready")),
    );

    const invocation = Diagnostics.execute(
      {
        id: "tool_2" as ToolRequestId,
        toolName: "diagnostics" as const,
        input: {},
      },
      { diagnosticsProvider: provider },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("LSP not ready");
    }
  });

  it("returns abort error when aborted before provider resolves", async () => {
    let resolveProvider: (value: string) => void;
    const provider = createMockProvider(
      () =>
        new Promise<string>((resolve) => {
          resolveProvider = resolve;
        }),
    );

    const invocation = Diagnostics.execute(
      {
        id: "tool_3" as ToolRequestId,
        toolName: "diagnostics" as const,
        input: {},
      },
      { diagnosticsProvider: provider },
    );

    invocation.abort();
    resolveProvider!("some diagnostics");

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("aborted");
    }
  });
});
