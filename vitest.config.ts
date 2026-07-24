import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The app half is Svelte, but pure logic extracted out of components (list
    // reconciliation and the like) is plain TS and worth covering here.
    include: ["server/src/**/*.test.ts", "app/src/**/*.test.ts"],
  },
});
