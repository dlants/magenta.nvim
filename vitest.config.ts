/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    globalSetup: ["./node/nvimclient/test/global-setup.ts"],
    setupFiles: ["./node/nvimclient/test/setup.ts"],
    // Each test file spawns its own nvim process; cap parallelism so we don't
    // exhaust memory by spinning up too many at once.
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
  },
});
