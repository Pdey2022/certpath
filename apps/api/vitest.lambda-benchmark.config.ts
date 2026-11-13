import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["benchmark/lambda/**/*.test.ts"],
  },
});
