import express, { RequestHandler } from "express";
import crypto from "crypto";
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

// Inject the per-request CSP nonce into every <script> tag of the served HTML so
// we can drop 'unsafe-inline' from script-src. Only wraps the SvelteKit handler
// (assets and /api are untouched); rewrites text/html only and switches that
// response to chunked encoding so it stays correct with/without compression.
const injectCspNonce: RequestHandler = (req, res, next) => {
  const nonce = (res.locals as any)?.nonce as string | undefined;
  if (!nonce) return next();

  // The HTML shell bakes a per-request CSP nonce into its <script> tags, so it
  // must never be reused from cache: a cached body (old nonce) paired with a
  // freshly generated response header (new nonce) blocks every inline script and
  // the app hangs on the loading screen — only a hard reload recovers. Drop the
  // conditional request headers so the page handler can't answer 304 with a
  // stale body; the rewritten HTML is additionally marked no-store below.
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];

  const chunks: Buffer[] = [];
  let deferredHeaders: Record<string, any> | undefined;

  const origWriteHead = res.writeHead.bind(res);
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  const toBuf = (chunk: any, enc?: any): Buffer =>
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === "string" ? (enc as BufferEncoding) : "utf8");

  (res as any).writeHead = (code: number, ...rest: any[]) => {
    res.statusCode = code;
    const headersArg = rest.find((a) => a && typeof a === "object" && !Array.isArray(a));
    if (headersArg) deferredHeaders = headersArg as Record<string, any>;
    return res;
  };

  (res as any).write = (chunk: any, ...args: any[]): boolean => {
    if (chunk != null) chunks.push(toBuf(chunk, args[0]));
    const cb = args.find((a) => typeof a === "function");
    if (cb) (cb as () => void)();
    return true;
  };

  (res as any).end = (chunk?: any, ...args: any[]): any => {
    if (chunk != null && typeof chunk !== "function") chunks.push(toBuf(chunk, args[0]));
    const cb = [chunk, ...args].find((a) => typeof a === "function");

    res.writeHead = origWriteHead;
    res.write = origWrite;
    res.end = origEnd;

    if (deferredHeaders) {
      for (const [k, v] of Object.entries(deferredHeaders)) res.setHeader(k, v as any);
    }

    let body = Buffer.concat(chunks);
    const ct = String(res.getHeader("content-type") || "");
    if (/text\/html/i.test(ct)) {
      if (body.length) {
        const html = body.toString("utf8").replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
        body = Buffer.from(html, "utf8");
      }
      // Per-request nonce -> the shell can't be cached or revalidated, or a stale
      // cached body fails CSP against the freshly generated header.
      res.setHeader("cache-control", "no-store");
      res.removeHeader("etag");
      res.removeHeader("last-modified");
      res.removeHeader("content-length"); // length changed -> chunked (compression-safe)
    }

    origWriteHead(res.statusCode);
    if (body.length) origWrite(body as any);
    return origEnd(cb as any);
  };

  next();
};

export const start = async (config: Config) => {
  
  // @ts-ignore
  // We have to do this this way for sveltekit server
  global.__RAVEN__ = { config };

  const app = express();
  app.disable("x-powered-by");

  if(config.trust_proxy != null) {
    // `true` is permissive: Express then trusts the ENTIRE X-Forwarded-For chain,
    // so a client can spoof the leftmost entry — defeating the IP-keyed login rate
    // limit (express-rate-limit's ERR_ERL_PERMISSIVE_TRUST_PROXY). Require an
    // explicit hop count / subnet instead so req.ip can't be forged.
    if(config.trust_proxy === true) {
      throw new Error("config.trust_proxy=true is unsafe (clients can spoof X-Forwarded-For and bypass rate limiting); set the number of proxy hops, e.g. trust_proxy=1");
    }
    app.set("trust proxy", config.trust_proxy);
  }

  // Structured request logging with a per-request id (req.id / req.log). Skips the
  // health check to avoid noise; the /api handlers log unhandled errors via req.log.
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/api/healthz" },
    // pino-http's default serializers log request AND response headers, which
    // include `Cookie: raven.sid=...` on every authenticated request and
    // `Set-Cookie` on login. Without redaction, anyone with log access could
    // replay live sessions until expiry — strip the session-bearing headers.
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      remove: true,
    },
  }));

  // Security headers (defense-in-depth). The app renders untrusted email HTML, so a
  // CSP, frame-ancestors and nosniff matter here; email bodies are additionally
  // isolated in a sandboxed (no-allow-scripts) iframe. SSR is disabled, so these are
  // set at the Express layer. script-src uses a per-request nonce (injected into the
  // SvelteKit HTML by injectCspNonce) instead of 'unsafe-inline'; dev keeps
  // unsafe-inline/eval for Vite HMR. Google Fonts are allow-listed for the UI.
  app.use((req, res, next) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    (res.locals as any).nonce = nonce;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      SVELTEKIT_DEV ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : `script-src 'self' 'nonce-${nonce}'`,
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
    app.use(injectCspNonce)
    app.use(kit.kitMiddleware);
  }

  const server = createServer(config, app);
  server.listen(config.port);
  console.log(`> ${pc.yellow(config.ssl ? "https" : "http")} server listening at port ${pc.yellow(String(config.port))}`);
}
