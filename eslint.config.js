// eslint.config.js
import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import noFloatingPromise from "eslint-plugin-no-floating-promise";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ["dist/**", "coverage/**"],
  },

  // First, import the recommended configuration
  pluginJs.configs.recommended,

  // Type-aware linting for the TypeScript migration (no type-checking
  // required, so `tsc` project service setup is unnecessary here).
  // `strict` = recommended + no-non-null-assertion / no-dynamic-delete /
  // no-invalid-void-type 等，全仓零报错是合并门禁。
  ...tseslint.configs.strict,

  // Then override or customize specific rules
  {
    plugins: {
      "no-floating-promise": noFloatingPromise,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-undef": "error",              // Disallow the use of undeclared variables or functions.
      "semi": ["error", "always"],      // Require the use of semicolons at the end of statements.
      "curly": "off",                   // Do not enforce the use of curly braces around blocks of code.
      "no-unused-vars": "off",          // Disable warnings for unused variables.
      "@typescript-eslint/no-unused-vars": "off", // Templates intentionally expose imports for injected code.
      "@typescript-eslint/no-explicit-any": "off", // Migration sanctions `any` at untyped boundaries (bot/agent/mineflayer).
      "no-unreachable": "off",          // Disable warnings for unreachable code.
      "require-await": "error",         // Disallow async functions which have no await expression
      "no-floating-promise/no-floating-promise": "error", // Disallow Promises without error handling or awaiting
    },
  },

  // `no-undef` false-positives on TypeScript types/namespaces (e.g. `NodeJS`);
  // `tsc --noEmit` already guarantees declared names in .ts files.
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
    },
  },
];
