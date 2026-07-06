import { StatusCodes } from "http-status-codes";
import type { Request, Response, NextFunction } from "express";
import { DISPLAY_ERRORS } from "./env";
import { logger } from "./logger";

export const validate = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch(e: any) {
    // Zod messages are English and technical; surface a localized generic instead
    // of leaking them to the user (the raw message stays on the Error for logs).
    // Log the real detail server-side: the client only ever sees the generic, so
    // without this a validation 400 is undiagnosable in production — exactly what made
    // the draft-send `reference` regression hard to track down. The zod message
    // carries field paths + expected types, not the submitted values, so it is safe.
    logger.warn({ detail: String(e?.message) }, "request body failed validation");
    throw new ApiError(StatusCodes.BAD_REQUEST, String(e?.message || "Bad request"), "bad_request")
  }
}

export const pageHandler = (fn: (req: Request, res: Response, next: NextFunction) => any) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res, next);
    } catch(e: any) {
      
      if(e instanceof ApiError) {
        if(e.status === StatusCodes.FORBIDDEN) {
          return res.json({
            status: 302,
            redirect: "/login"
          })
        } else {
          return res.status(e.status).json({
            status: e.status,
            error: errMsg(req, e.key, e.message),
          })
        }
      }

      const status = Number(e?.status) || 500;
      (req as any).log?.error({ err: e }, "unhandled error in /api page handler");
      const message = DISPLAY_ERRORS ? String(e?.message) : errMsg(req, "internal_server_error", "Internal server error");

      return res.status(status).json({
        status,
        error: message,
      })
    }
  }
}

export const handler = (fn: (req: Request, res: Response, next: NextFunction) => any) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res, next);
    } catch(e: any) {

      if(e instanceof ApiError) {
        return res
          .status(e.status)
          .json({
            error: {
              status: e.status,
              message: errMsg(req, e.key, e.message)
            }
          })
      }

      const status = Number(e?.status) || 500;
      (req as any).log?.error({ err: e }, "unhandled error in /api handler");
      const message = DISPLAY_ERRORS ? String(e?.message) : errMsg(req, "internal_server_error", "Internal server error");

      return res
        .status(status)
        .json({ error: { status, message } })
    }
  }
}

export class ApiError extends Error {
  status: number;
  // Optional i18n key into the locale `errors` group. The handlers below resolve
  // it against req.locale (the user's language) and fall back to `message` (an
  // English string kept for logs and the pre-locale window).
  key?: string;
  constructor(status: number, message: string, key?: string) {
    super(message);
    this.status = status;
    this.key = key;
  }
}

// Resolve a user-facing error string in the request language. Errors thrown deep
// in client.ts / proxy code carry an i18n `key` instead of a localized string,
// because only here (request scope) do we have req.locale.
export const errMsg = (req: Request, key: string | undefined, fallback: string): string => {
  const table = req.locale?.errors as Record<string, string> | undefined;
  return (key && table?.[key]) || fallback;
};