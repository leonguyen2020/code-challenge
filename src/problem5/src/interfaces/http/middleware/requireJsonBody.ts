import type { NextFunction, Request, Response } from 'express';
import { requestId } from './requestContext';

/**
 * Rejects write requests that do not carry a JSON body.
 *
 * `express.json()` only parses a matching Content-Type and otherwise leaves
 * `req.body` as an empty object. Without this guard, a POST sent as
 * `text/plain` produces a confusing "sku is required" validation error rather
 * than the accurate answer, which is that the media type is unsupported. 415 is
 * the status that tells the client what to actually change.
 */
export function requireJsonBody() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
      next();
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).type('application/problem+json').json({
        type: 'about:blank',
        title: 'Unsupported Media Type',
        status: 415,
        detail: 'This endpoint requires a Content-Type of application/json.',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        instance: req.originalUrl,
        requestId: requestId(req),
      });
      return;
    }
    next();
  };
}
