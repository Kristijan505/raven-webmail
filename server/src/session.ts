import ExpressSession from "express-session";
import MongoSession from "connect-mongodb-session";
import { Config } from "./config";

const MongoStore = MongoSession(ExpressSession);

export const session = (config: Config) => {
  const maxAge = config.session_cookie_max_age_ms ?? 7 * 24 * 60 * 60 * 1000;
  // Only a real trusted-proxy value counts. An explicit trust_proxy=false means
  // "not behind a proxy", so it must NOT enable proxy-derived cookie handling
  // (secure="auto" from X-Forwarded-Proto, proxy:true) — `!= null` alone would,
  // since false != null.
  const trustProxy = config.trust_proxy != null && config.trust_proxy !== false;
  // When TLS is terminated at a reverse proxy (trust_proxy set, ssl=false), tie the
  // Secure flag to the forwarded protocol ("auto") instead of leaving it off, so the
  // session cookie is never issued over a plaintext hop. Direct TLS => always secure.
  const secure: boolean | "auto" =
    config.session_cookie_secure ?? (config.ssl ? true : trustProxy ? "auto" : false);

  return ExpressSession({
    name: config.session_name || "raven.sid",
    secret: config.secret_token,
    saveUninitialized: false,
    resave: config.session_resave ?? false,
    rolling: config.session_rolling ?? false,
    proxy: trustProxy ? true : undefined,
    unset: "destroy",
    cookie: {
      maxAge,
      secure,
      httpOnly: config.session_cookie_http_only ?? true,
      sameSite: config.session_cookie_same_site || "lax",
      domain: config.session_cookie_domain || undefined,
    },
    store: new MongoStore({
      uri: config.mongodb_url,
      collection: "sessions-v2",
      expires: maxAge,
    })
  })
}
