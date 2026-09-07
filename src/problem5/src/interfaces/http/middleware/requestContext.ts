import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Header name clients and proxies use to propagate a correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Shape an accepted inbound correlation id must have. */
const REQUEST_ID_PATTERN = /^[0-9a-zA-Z-]{8,64}$/;

/**
 * Reads the correlation id as a string.
 *
 * `pino-http` already augments `IncomingMessage` with `id: ReqId`, which is
 * `string | number | object` - so declaring our own `id: string` on the same
 * interface would be a conflicting merge. Rather than fight the ambient type,
 * this narrows at the point of use. Every id this service assigns is a string;
 * the coercion is belt-and-braces for one set by something else.
 */
export function requestId(req: Request): string {
  return typeof req.id === 'string' ? req.id : String(req.id);
}

/**
 * Assigns a correlation id to every request.
 *
 * An inbound `x-request-id` is honoured so a trace survives across services -
 * but only after validation. The value ends up in log lines and in a response
 * header, so an unvalidated one lets a caller inject newlines into logs (making
 * forged entries) or control characters into headers (response splitting).
 * Anything that does not look like an id is replaced rather than rejected:
 * failing a request over a cosmetic header would be worse than ignoring it.
 */
export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const supplied = req.get(REQUEST_ID_HEADER);
    req.id =
      supplied !== undefined && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId(req));
    next();
  };
}
