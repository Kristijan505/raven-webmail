#!/usr/bin/env node
global.__RAVEN_IMPORT_SVELTEKIT__ = async () => {
  try {
    // Backward compatible with legacy Raven app bundle layout.
    return await import("./app/build/middlewares.js");
  } catch (_err) {
    // SvelteKit 2 adapter-node output exposes `handler.js` instead.
    const { handler } = await import("./app/build/handler.js");
    return {
      assetsMiddleware: (_req, _res, next) => next(),
      kitMiddleware: handler,
      prerenderedMiddleware: (_req, _res, next) => next()
    };
  }
};
require("source-map-support").install();
require("./server/dist/cli.js");
