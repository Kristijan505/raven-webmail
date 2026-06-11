import express from "express";
import { api } from "./api";
import { Config } from "./config";
import { session } from "./session";
import https from "https";
import http from "http";

import { readFileSync } from "fs";
import pc from "picocolors";
import { SVELTEKIT_DEV, SVELTEKIT_PORT } from "./env";
import { sveltekitDevProxy } from "./sveltekit-dev-proxy";

import compression from "compression";
import pinoHttp from "pino-http";
import { logger } from "./logger";

const createServer = (config: Config, app: http.RequestListener) => {
  if(config.ssl) {
    let cert: Buffer;
    let key: Buffer;
    try {
      cert = readFileSync(config.ssl_certificate);
      key = readFileSync(config.ssl_certificate_key);
    } catch(e: any) {
      console.warn(`Error loading ssl key and cert: ${pc.yellow(e.message)}`);
      process.exit(1);
    }

    return https.createServer({
      key,
      cert,
    }, app); 
  } else {
    return http.createServer(app);
  }
} 

export const start = async (config: Config) => {
  
  // @ts-ignore
  // We have to do this this way for sveltekit server
  global.__RAVEN__ = { config };

  const app = express();
  app.disable("x-powered-by");

  if(config.trust_proxy != null) {
    app.set("trust proxy", config.trust_proxy);
  }

  // Structured request logging with a per-request id (req.id / req.log). Skips the
  // health check to avoid noise; the /api handlers log unhandled errors via req.log.
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/api/healthz" },
  }));

  // Security headers (defense-in-depth). The app renders untrusted email HTML, so a
  // CSP, frame-ancestors and nosniff matter here; email bodies are additionally
  // isolated in a sandboxed (no-allow-scripts) iframe. 'unsafe-inline' is required
  // for SvelteKit's inline bootstrap; Google Fonts are allow-listed for the UI.
  // SSR is disabled, so these must be set at the Express layer (not svelte.config).
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
      "frame-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "));
    if(req.secure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  config.compression && app.use(compression());

  app.use("/api", session(config), api(config));
  
  if(SVELTEKIT_DEV) {
    app.use(sveltekitDevProxy(SVELTEKIT_PORT))
  } else {
    const kit = await __RAVEN_IMPORT_SVELTEKIT__();
    app.use(kit.assetsMiddleware)
    app.use(kit.kitMiddleware);
  }

  const server = createServer(config, app);
  server.listen(config.port);
  console.log(`> ${pc.yellow(config.ssl ? "https" : "http")} server listening at port ${pc.yellow(String(config.port))}`);
}
