/// <reference types="vitest" />
import { defineConfig } from "vite";

const setupFiles = ["./node/nvimclient/test/setup.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          include: ["node/server/**/*.test.ts", "sdk/**/*.test.ts"],
          setupFiles,
          pool: "threads",
        },
      },
      {
        test: {
          name: "node",
          include: ["node/nvimclient/**/*.node.test.ts"],
          setupFiles,
          pool: "threads",
        },
      },
      {
        test: {
          name: "nvim",
          include: ["node/nvimclient/**/*.test.ts"],
          exclude: ["node/nvimclient/**/*.node.test.ts", "**/node_modules/**"],
          globalSetup: ["./node/nvimclient/test/global-setup.ts"],
          setupFiles,
          // Each test file spawns its own nvim process; cap parallelism so we
          // don't exhaust memory by spinning up too many at once.
          pool: "forks",
          poolOptions: { forks: { maxForks: 4, minForks: 1 } },
        },
      },
    ],
  },
});
