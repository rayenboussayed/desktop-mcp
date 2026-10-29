import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false, // the GUI tests share one X display
    coverage: {
      provider: "v8",
      reportOnFailure: true,
      include: ["src/**/*.ts"],
      exclude: ["src/bin/**", "src/index.ts"], // bin/* are 2-line launchers; index.ts is a pure re-export barrel
      reporter: ["text", "json"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
