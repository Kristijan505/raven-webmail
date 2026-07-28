import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Server only. The app's own tests are plain TS, but they resolve through
    // app/tsconfig.json, which extends the tsconfig svelte-kit sync generates into
    // app/.svelte-kit/. This config is what the build-server CI job runs, and that job
    // never syncs the app — so reaching across broke it with "Tsconfig not found"
    // while passing locally, where .svelte-kit/ happens to be lying around from a
    // previous build. The app half is already covered by the build-app job running
    // vitest inside app/, so pointing here as well bought duplicate coverage at the
    // cost of a red pipeline.
    include: ["server/src/**/*.test.ts"],
  },
});
