import ExpressSession from "express-session";
import MongoSession from "connect-mongodb-session";
import { Config } from "./config";

const MongoStore = MongoSession(ExpressSession);

export const session = (config: Config) => {
  const maxAge = config.session_cookie_max_age_ms ?? 7 * 24 * 60 * 60 * 1000;
  const secure = config.session_cookie_secure ?? config.ssl;

  return ExpressSession({
    name: config.session_name || "raven.sid",
    secret: config.secret_token,
    saveUninitialized: false,
    resave: config.session_resave ?? false,
    rolling: config.session_rolling ?? false,
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
