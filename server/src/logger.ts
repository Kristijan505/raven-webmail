import pino from "pino";

// Structured JSON logger. Level via RAVEN_LOG_LEVEL (default "info").
// JSON is aggregation-friendly (Loki/ELK); pipe through `pino-pretty` locally
// for human-readable output if desired.
export const logger = pino({
  level: process.env.RAVEN_LOG_LEVEL || "info",
});
