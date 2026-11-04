import { describe, expect, it } from "vitest";
import {
  parseJsonRpcLine,
  parseResourceState,
  parseWatcherManifest,
} from "./protocol.ts";

const manifest = {
  name: "gh",
  protocolVersion: 1,
  command: ["node", "index.ts"],
};

describe("parseWatcherManifest", () => {
  it("accepts a valid manifest", () => {
    expect(parseWatcherManifest(manifest)).toEqual({
      status: "ok",
      value: manifest,
    });
  });
  it.each([
    ["invalid name", { name: "a b" }, /name/],
    ["wrong protocolVersion", { protocolVersion: 2 }, /protocolVersion/],
    ["empty command", { command: [] }, /command/],
    ["non-string command", { command: ["node", 1] }, /command/],
  ])("rejects %s", (_, patch, msg) => {
    const r = parseWatcherManifest({ ...manifest, ...patch });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toMatch(msg);
  });
});

describe("parseResourceState", () => {
  const base = { key: "k", context: "c", summary: "s" };
  it("rejects unknown status", () => {
    expect(parseResourceState({ ...base, status: "bogus" })).toBeUndefined();
  });
  it("requires error on failing/unavailable and forbids it elsewhere", () => {
    expect(parseResourceState({ ...base, status: "failing" })).toBeUndefined();
    expect(
      parseResourceState({ ...base, status: "active", error: "e" }),
    ).toBeUndefined();
    expect(
      parseResourceState({ ...base, status: "unavailable", error: "e" }),
    ).toEqual({ ...base, status: "unavailable", error: "e" });
  });
});

describe("parseJsonRpcLine", () => {
  it("parses a method without id as a notification", () => {
    expect(
      parseJsonRpcLine('{"jsonrpc":"2.0","method":"state","params":1}'),
    ).toEqual({ kind: "notification", method: "state", params: 1 });
  });
  it("maps a null error id to undefined", () => {
    expect(
      parseJsonRpcLine(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"m"}}',
      ),
    ).toEqual({
      kind: "error",
      id: undefined,
      error: { code: -32700, message: "m" },
    });
  });
  it("rejects garbage", () => {
    expect(parseJsonRpcLine("nope")).toBeUndefined();
    expect(parseJsonRpcLine('{"id":1,"result":1}')).toBeUndefined();
  });
});
