import { ApiError } from "./util";
import { StatusCodes } from "http-status-codes";
import { DISPLAY_ERRORS } from "./env";
import { Readable } from "stream";

const fromWeb = (Readable as any).fromWeb as ((stream: any) => NodeJS.ReadableStream);

export const url = (u: string) => {
  return __RAVEN__.config.wildduck_api_url.replace(/\/$/, "") + u;
}

const Requester = <Body>(method: string) => {
  return async (u: string, accessToken: string, body?: Body) => {
    
    const init: RequestInit = { method }

    if(body != null) {
      init.headers = {
        "x-access-token": accessToken,
        "content-type": "application/json",
      }

      init.body = JSON.stringify(body);
    } else {
      init.headers = { "x-access-token": accessToken }
    }

    const res = await fetch(url(u), init).catch(e => {
      throw new ApiError(StatusCodes.BAD_GATEWAY, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway", "bad_gateway");
    })

    if(res.status === StatusCodes.FORBIDDEN) {
      throw new ApiError(StatusCodes.FORBIDDEN, "The session has expired", "session_expired");
    }

    const json = await res.json().catch(e => {
      throw new ApiError(StatusCodes.BAD_GATEWAY, "Invalid JSON from backend", "bad_gateway");
    })

    if(json?.error) {
      throw new ApiError(res.ok ? StatusCodes.INTERNAL_SERVER_ERROR : res.status, String(json.error))
    }

    return json;
  }
}

export const get = Requester<void>("GET");
export const del = Requester<void>("DELETE");
export const post = Requester<any>("POST");
export const put = Requester<any>("PUT");

export type Authentication = {
  success: boolean
  id: string
  username: string
  scope: string
  require2fa: string[]
  requirePasswordChange: boolean
  token: string
}

export const authenticate = async (username: string, password: string): Promise<Authentication> => {
  const res = await fetch(url("/authenticate"), {
    method: "POST",
    headers: { 
      "content-type": "application/json",
      "x-access-token": __RAVEN__.config.wildduck_api_token,
    },
    body: JSON.stringify({
      token: true,
      scope: "master",
      username,
      password,
    })
  }).catch(e => {
    throw new ApiError(StatusCodes.BAD_GATEWAY, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway", "bad_gateway");
  })

  const json: any = await res.json().catch(e => {
    throw new ApiError(StatusCodes.BAD_GATEWAY, "Invalid JSON body from backend", "bad_gateway")
  });

  if(json?.error) {
    throw new ApiError(res.ok ? StatusCodes.INTERNAL_SERVER_ERROR : res.status, String(json.error));
  }

  return json;
}

export const watch = async (userId: string, accessToken: string): Promise<NodeJS.ReadableStream> => {
  const res = await fetch(url(`/users/${userId}/updates`), {
    headers: { "x-access-token": accessToken },
  }).catch(e => {
    throw new ApiError(502, DISPLAY_ERRORS ? String(e?.message) : "Bad Gateway", "bad_gateway");
  })

  if(res.ok) {
    if(!res.body) {
      throw new ApiError(502, "Invalid stream from backend", "bad_gateway");
    }
    return fromWeb(res.body as any);
  }

  if(res.status === StatusCodes.FORBIDDEN) {
    throw new ApiError(StatusCodes.FORBIDDEN, "Session has expired", "session_expired");
  }

  const json = await res.json().catch(() => {
    throw new ApiError(502, "Invalid JSON body from backend", "bad_gateway");
  })

  throw new ApiError(res.status, String(json?.error || "JSON error without message"));
}
