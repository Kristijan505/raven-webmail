# Raven Webmail Modernization Plan

Last updated: 2026-03-10  
Owner: RedCode / Raven fork  
Goal: fully modernize dependencies and framework stack while keeping WildDuck compatibility and safe rollback.

## Scope

- Upgrade backend and frontend stacks to current maintained versions.
- Keep current behavior and API compatibility for existing Raven routes.
- Deliver migration in milestones that can be tested on beta before production cutover.

## Current Status

- [x] Beta service boots and serves pages on Node 24 image.
- [x] Session bootstrap fixed for Node 24 by using `globalThis.fetch` in app hooks.
- [x] Runtime validation migrated from `typescript-is` to explicit `zod` schemas.
- [x] Dependency stack modernized for current runtime/build toolchains (backend + frontend).
- [ ] Production cutover ready with documented rollback.

## Milestones

## M1: Baseline + Security Floor

### Tasks

- [ ] Freeze baseline image/tag and config snapshot.
- [ ] Record smoke-test baseline (healthz, locale, login, mailbox list, logout).
- [x] Patch known root vulnerability override (`fast-xml-parser` to `>=5.3.8`).
- [x] Regenerate lockfiles cleanly with Node LTS.

### Acceptance criteria

- [x] `npm audit --omit=dev` in root has no high/critical findings.
- [ ] Existing beta flow still works after rebuild.

## M2: Backend Modernization

### Tasks

- [x] Upgrade backend runtime dependencies (Express 5, MongoDB 7, connect-mongodb-session 5, related typings).
- [x] Remove `node-fetch` in server and use native fetch (Node 24).
- [x] Keep session behavior stable (`secure`, `sameSite`, cookie domain, rolling/resave flags).
- [ ] Validate all server API routes used by app still pass.

### Acceptance criteria

- [x] Build succeeds on Node 24.
- [ ] Smoke tests pass against beta.
- [ ] No backend regressions in login, mailbox load, message read, send, logout.

## M3: Frontend Platform Migration

### Tasks

- [x] Migrate app from old SvelteKit pre-1.0 patterns to SvelteKit 2.x.
- [x] Migrate Svelte 3 to Svelte 5 compatible setup.
- [x] Update hook/session flow to modern Kit model while preserving behavior.
- [x] Update lint/format/check tooling to current supported versions.
- [x] Replace legacy `svelte-material-icons` with maintained `unplugin-icons` + Iconify MDI.

### Acceptance criteria

- [x] `npm run build` passes in app with modern stack.
- [ ] Beta UX and existing functionality behave the same.
- [ ] No critical console/runtime errors in tested flows.

## M4: CI/CD + Image Hardening Finalization

### Tasks

- [ ] Update CI workflows for modern Node/LTS matrix and migration checks.
- [ ] Keep audit and image scanning gates active.
- [ ] Finalize production Docker image and health checks.
- [ ] Produce release notes + rollback instructions.

### Acceptance criteria

- [ ] CI green on build/test/audit gates.
- [ ] Trivy scan has no high/critical findings in release image.
- [ ] Rollback tested and documented.

## Test Matrix (Required Before Cutover)

- [ ] Login with valid credentials.
- [ ] Failed login path.
- [ ] Inbox list and mailbox counters.
- [ ] Open message, mark seen/unseen, flag/unflag.
- [ ] Move/delete message.
- [ ] Compose and send message with attachment.
- [ ] Search and pagination.
- [ ] Update profile/signature/password.
- [ ] Logout and re-login.

## Rollback Plan

- Keep previous known-good image tag available.
- Recreate service with previous image and previous config snapshot.
- Verify healthz + login + mailbox list immediately after rollback.

## Progress Log

- 2026-02-27: Created migration tracker and milestone structure.
- 2026-02-27: Applied root dependency override `fast-xml-parser=5.3.8`.
- 2026-02-27: Refreshed root lockfile with Node LTS (`npm install` in project root).
- 2026-02-27: Verified app lockfile is current (`npm install` in `app`) and full build passes.
- 2026-02-27: App prod audit remains clean (`npm audit --omit=dev` => 0 vulnerabilities).
- 2026-02-27: Migrated server fetch paths (`client.ts`, `api.ts`, `sveltekit-dev-proxy.ts`) from `node-fetch` to native fetch with Node stream bridging.
- 2026-02-27: Confirmed full project build passes after native-fetch migration.
- 2026-02-27: Expanded `/scripts/smoke.sh` authenticated checks to include `/api/pages/layout`, mailbox message listing, and message fetch.
- 2026-02-27: Upgraded backend dependency targets (`express@5`, `mongodb@7`, `connect-mongodb-session@5`, `commander@14`), removed `node-fetch`, and regenerated root lockfile.
- 2026-02-27: Root prod audit now clean (`npm audit --omit=dev` => 0 vulnerabilities).
- 2026-02-27: Rebuilt and validated backend after dependency bump (`npm run build:server` and full `npm run build` pass).
- 2026-02-27: Upgraded app toolchain to current stack (`@sveltejs/kit@2`, `svelte@5`, `@sveltejs/adapter-node@5`, modern Vite build scripts).
- 2026-02-27: Migrated app routing from legacy files (`__layout.svelte`, `index.svelte`) to Kit 2 route conventions (`+layout/+page/+error`), including grouped `(app)` layout and dedicated `+page.ts` loaders.
- 2026-02-27: Removed legacy app session hooks (`getSession`/`externalFetch`) and moved locale bootstrap to root `+layout.ts` with client-side load (`ssr = false`) to keep behavior aligned with previous non-SSR setup.
- 2026-02-27: Updated Svelte-5-incompatible internals (`svelte/internal` helpers and `$app/env` imports), plus Vite raw CSS imports in editor components.
- 2026-02-27: Updated service worker for modern `$service-worker` exports (`version` instead of `timestamp`) and confirmed app build success.
- 2026-02-27: Verified full project build passes on Node LTS (`npm run build` at repo root).
- 2026-02-27: Resolved Kit2/Svelte5 type-level breakages in editor/compose/dashboard modules; `npm run check` now passes with `0 errors` (warnings remain, mostly legacy a11y/style).
- 2026-02-27: Attempted `svelte-material-icons` upgrade; latest release is not Svelte 5 compatible (peer `^3 || ^4`), so package remains pinned at compatible version until upstream support lands.
- 2026-02-27: Completed icon stack migration in `app` to `unplugin-icons` + `@iconify-json/mdi`, rewrote icon imports to `~icons/mdi/*`, and validated `npm run build` on Node LTS.
- 2026-02-27: Verified `npm run check` after icon migration (`0 errors`, warnings are pre-existing a11y/style warnings in legacy templates).
- 2026-03-04: Fixed production startup compatibility for SvelteKit 2 output by adding `raven.js` fallback from legacy `app/build/middlewares.js` to modern `app/build/handler.js`.
- 2026-03-04: Moved `typescript-is` to root runtime dependencies and simplified Docker production prune step so the module is always present at runtime.
- 2026-03-09: Fixed frontend boot crash (`Cannot read properties of undefined (reading 'find')`) by making mailbox sorting null-safe and initializing dashboard mailbox store before prop hydration.
- 2026-03-10: Updated root and app dependencies to latest available versions and refreshed both lockfiles under Node LTS.
- 2026-03-10: Replaced `typescript-is` runtime validation with explicit `zod` schemas for server request/config parsing; removed transformer plugin from `server/tsconfig.json`.
- 2026-03-10: Switched server console coloring from `chalk` to `picocolors` to keep runtime compatibility with CommonJS build output.
- 2026-03-10: Pinned Raven Docker base image to `node:24-alpine3.23` for both build and runtime stages.
- 2026-03-10: Pinned WildDuck stack images in `/wildduck/docker-compose.yml` to current selected tags (`wildduck`, `zonemta`, `haraka`, `mongo`, `redis`, `rspamd`).
- 2026-03-10: Removed dashboard SSE debug console log noise and re-verified app checks/build.
