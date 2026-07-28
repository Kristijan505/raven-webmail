import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Server only. The app's tests are plain TS, but they resolve through
    // app/tsconfig.json, which extends the tsconfig svelte-kit sync generates into
    // app/.svelte-kit/. This config is what the build-server CI job runs, and that job
    // never syncs the app — so reaching across broke it with "Tsconfig not found"
    // while passing locally, where .svelte-kit/ happens to be lying around from an
    // earlier build.
    //
    // The app runs its own: `npm test` in app/ is vitest, after `npm run build` has
    // synced. Both halves have to stay wired for CI to mean anything — pointing this
    // config at app/src while app's own test script was still a placeholder echo is
    // how 39 tests ended up running in neither job.
    include: ["server/src/**/*.test.ts"],
  },
});
