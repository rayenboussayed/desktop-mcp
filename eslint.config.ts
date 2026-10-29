// @ts-nocheck

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import vitest from "@vitest/eslint-plugin";
import { jsdoc } from "eslint-plugin-jsdoc";
import unicorn from "eslint-plugin-unicorn";
import deMoragn from "eslint-plugin-de-morgan";
import n from "eslint-plugin-n";
import sonarjs from "eslint-plugin-sonarjs";
import deslint from "@deslint/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";

const JS_FILES = "**/*.{ts,mts,cts}";
const TS_FILES = "**/*.{ts,mts,cts}";

export default defineConfig([
  globalIgnores([
    "node_modules",
    "dist",
    "package-lock.json",
    "*.config.*",
  ]),
  {
    files: [JS_FILES, TS_FILES],
    plugins: {
      js,
      n: n.configs["recommended-module"],
      unicorn: unicorn.configs.recommended,
      sonarjs: sonarjs.configs.recommended,
      deslint: deslint.configs.recommended,
    },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.node },
  },
  tseslint.configs.recommended,
  deMoragn.configs.recommended,
  {
    files: [JS_FILES],
    ...jsdoc({ config: "flat/recommended" }),
  },
  {
    files: [TS_FILES],
    ...jsdoc({ config: "flat/recommended-tsdoc" }),
  },
  {
    files: ["tests/**/*.test.ts"],
    plugins: { vitest },
  },
  {
    files: ["**/*.json"],
    plugins: { json },
    language: "json/json",
    extends: ["json/recommended"],
  },
  {
    files: ["**/*.jsonc"],
    plugins: { json },
    language: "json/jsonc",
    extends: ["json/recommended"],
  },
  {
    files: ["**/*.json5"],
    plugins: { json },
    language: "json/json5",
    extends: ["json/recommended"],
  },
  {
    files: ["**/*.md"],
    plugins: { markdown },
    language: "markdown/gfm",
    extends: ["markdown/recommended"],
  },
]);
