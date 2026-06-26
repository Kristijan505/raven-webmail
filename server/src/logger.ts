import pino from "pino";

// Session-bearing headers (request Cookie, login Set-Cookie) must never reach the
// logs, or anyone with log access could replay a live session. Redaction is set on
// the INSTANCE — not only in pino-http's options — so it also covers any direct
// logger.* call, not just the HTTP access logs. (pino-http builds its per-request
// logger as a child of this instance, so it inherits the redaction.)
const redact = {
  paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
  remove: true,
};

// Structured JSON logger. Level via RAVEN_LOG_LEVEL (default "info").
// JSON is aggregation-friendly (Loki/ELK); pipe through `pino-pretty` locally
// for human-readable output if desired.
export const logger = pino({
  level: process.env.RAVEN_LOG_LEVEL || "info",
  redact,
});
