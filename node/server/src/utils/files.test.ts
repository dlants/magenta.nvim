import { describe, expect, it } from "vitest";
import {
  type HomeDir,
  resolveAbsPath,
  type UnresolvedFilePath,
} from "./files.ts";

const home = "/home/user" as HomeDir;
const resolve = (p: string) => resolveAbsPath(p as UnresolvedFilePath, home);

describe("resolveAbsPath", () => {
  it("expands bare ~ to the home directory", () => {
    expect(resolve("~")).toEqual({ status: "ok", value: "/home/user" });
  });
  it("expands ~/ paths", () => {
    expect(resolve("~/a/b")).toEqual({ status: "ok", value: "/home/user/a/b" });
  });
  it("normalizes absolute paths", () => {
    expect(resolve("/a/../b/./c")).toEqual({ status: "ok", value: "/b/c" });
  });
  it("rejects relative paths", () => {
    const result = resolve("a/b");
    expect(result.status).toBe("error");
  });
});
