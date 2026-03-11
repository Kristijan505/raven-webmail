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
