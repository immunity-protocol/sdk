import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
