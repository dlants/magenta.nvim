import { describe, expect, it } from "vitest";
import type {
  ScriptCatalogEntry,
  ScriptRunner,
} from "../capabilities/script-runner.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ToolRequestId } from "../tool-types.ts";
import * as RunScript from "./run-script.ts";

const catalog: ScriptCatalogEntry[] = [
  {
    name: "foo",
    description: "does foo",
    parameterSchema: {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    },
    file: "/scripts/foo.ts",
  },
];

describe("run_script tool", () => {
  it("enumerates discovered scripts in the spec", () => {
    const spec = RunScript.getSpec(catalog);
    expect(spec.name).toBe("run_script");
    const schema = spec.input_schema as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    const props = schema.properties;
    expect(props.scriptName.enum).toEqual(["foo"]);
    expect(spec.description).toContain("foo: does foo");
  });

  it("requires scriptName but not parameters", () => {
    const schema = RunScript.getSpec(catalog).input_schema as {
      required: string[];
    };
    expect(schema.required).toEqual(["scriptName"]);
  });

  it("accepts well-formed input", () => {
    const result = RunScript.validateInput({
      scriptName: "foo",
      parameters: { x: "thing" },
    });
    expect(result.status).toBe("ok");
  });

  it("accepts input with omitted parameters (discovery step)", () => {
    const result = RunScript.validateInput({ scriptName: "foo" });
    expect(result.status).toBe("ok");
  });

  it("rejects input with a missing scriptName", () => {
    const result = RunScript.validateInput({ parameters: {} });
    expect(result.status).toBe("error");
  });

  it("rejects input whose parameters are not an object", () => {
    const result = RunScript.validateInput({
      scriptName: "foo",
      parameters: "nope",
    });
    expect(result.status).toBe("error");
  });

  function makeInvoker() {
    const calls: { scriptName: string; parameters: unknown }[] = [];
    const invoker: ScriptRunner = {
      discover: () => Promise.resolve(),
      getScriptCatalog: () => catalog,
      runScript: ({ scriptName, parameters }) =>
        calls.push({ scriptName, parameters }),
    };
    return { invoker, calls };
  }

  function makeRequest(input: RunScript.Input): RunScript.ToolRequest {
    return {
      id: "req-1" as ToolRequestId,
      toolName: "run_script",
      input,
    };
  }

  it("returns the parameter schema and does not invoke when parameters are omitted", async () => {
    const { invoker, calls } = makeInvoker();
    const result = await RunScript.execute(makeRequest({ scriptName: "foo" }), {
      scriptRunner: invoker,
      threadId: "thread-1" as ThreadId,
    }).promise;
    expect(calls).toHaveLength(0);
    expect(result.result.status).toBe("ok");
    const text =
      result.result.status === "ok" ? result.result.value[0] : undefined;
    expect(text && "text" in text ? text.text : "").toContain('"required"');
  });

  it("rejects parameters that violate the script's schema without invoking", async () => {
    const { invoker, calls } = makeInvoker();
    const result = await RunScript.execute(
      makeRequest({ scriptName: "foo", parameters: { x: 123 } }),
      { scriptRunner: invoker, threadId: "thread-1" as ThreadId },
    ).promise;
    expect(result.result.status).toBe("error");
    expect(calls).toHaveLength(0);
  });
  it("invokes the script when parameters are supplied", async () => {
    const { invoker, calls } = makeInvoker();
    const result = await RunScript.execute(
      makeRequest({ scriptName: "foo", parameters: { x: "thing" } }),
      { scriptRunner: invoker, threadId: "thread-1" as ThreadId },
    ).promise;
    expect(result.result.status).toBe("ok");
    expect(calls).toEqual([{ scriptName: "foo", parameters: { x: "thing" } }]);
  });
});
