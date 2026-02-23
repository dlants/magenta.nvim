import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      "**/node/test/fixtures/**",
      "**/node/test/tmp/**",
      "**/eslint.config.mjs",
      "node/nvim/nvim-node/cli/**",
      "**/node/core/dist/**",
    ],
  },
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/node/test/fixtures/**", "**/node/test/tmp/**"],
    extends: [...tseslint.configs.recommended], // Use non-type-checked config for test fixtures
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-void": ["error", { allowAsStatement: true }],
      "no-restricted-properties": [
        "error",
        {
          object: "describe",
          property: "only",
          message:
            "describe.only is not allowed as it may be committed accidentally",
        },
        {
          object: "it",
          property: "only",
          message: "it.only is not allowed as it may be committed accidentally",
        },
      ],
    },
  },
];
