/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    globalSetup: ["./node/test/global-setup.ts"],
    setupFiles: ["./node/test/setup.ts"],
  },
});
