import { describe, expect, it } from "vitest";
import { mergeOptions, type MagentaOptions } from "./options.ts";

describe("mergeOptions", () => {
  const baseOptions: MagentaOptions = {
    profiles: [
      { name: "test", provider: "mock", model: "mock", fastModel: "mock-fast" },
    ],
    activeProfile: "test",
    sidebarPosition: "left",
    sidebarPositionOpts: {
      above: { displayHeightPercentage: 0.3, inputHeightPercentage: 0.1 },
      below: { displayHeightPercentage: 0.3, inputHeightPercentage: 0.1 },
      tab: { displayHeightPercentage: 0.8 },
      left: { widthPercentage: 0.4, displayHeightPercentage: 0.8 },
      right: { widthPercentage: 0.4, displayHeightPercentage: 0.8 },
    },
    maxConcurrentSubagents: 3,
    commandConfig: {},
    autoContext: [],
    skillsPaths: [],
    mcpServers: {},
    getFileAutoAllowGlobs: [],
    customCommands: [],
  };

  describe("commandConfig merging", () => {
    it("should add new commands from project config", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          git: { subCommands: { status: { allowAll: true } } },
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          npm: { subCommands: { install: { allowAll: true } } },
        },
      });

      expect(merged.commandConfig.git).toEqual({
        subCommands: { status: { allowAll: true } },
      });
      expect(merged.commandConfig.npm).toEqual({
        subCommands: { install: { allowAll: true } },
      });
    });

    it("should merge subCommands from both configs", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          git: { subCommands: { status: { allowAll: true } } },
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          git: { subCommands: { commit: { args: [["-m", { any: true }]] } } },
        },
      });

      expect(merged.commandConfig.git).toEqual({
        subCommands: {
          status: { allowAll: true },
          commit: { args: [["-m", { any: true }]] },
        },
      });
    });

    it("should combine args arrays from both configs", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          cat: { args: [[{ file: true }]] },
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          cat: { args: [["-n", { file: true }]] },
        },
      });

      expect(merged.commandConfig.cat).toEqual({
        args: [[{ file: true }], ["-n", { file: true }]],
      });
    });

    it("should set allowAll if either config has it", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          echo: { args: [["hello"]] },
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          echo: { allowAll: true },
        },
      });

      expect(merged.commandConfig.echo).toEqual({
        args: [["hello"]],
        allowAll: true,
      });
    });

    it("should deeply merge nested subCommands", () => {
      const base: MagentaOptions = {
        ...baseOptions,
        commandConfig: {
          git: {
            subCommands: {
              remote: {
                subCommands: {
                  add: { args: [[{ any: true }, { any: true }]] },
                },
              },
            },
          },
        },
      };

      const merged = mergeOptions(base, {
        commandConfig: {
          git: {
            subCommands: {
              remote: {
                subCommands: {
                  remove: { args: [[{ any: true }]] },
                },
              },
            },
          },
        },
      });

      expect(merged.commandConfig.git).toEqual({
        subCommands: {
          remote: {
            subCommands: {
              add: { args: [[{ any: true }, { any: true }]] },
              remove: { args: [[{ any: true }]] },
            },
          },
        },
      });
    });
  });
});
