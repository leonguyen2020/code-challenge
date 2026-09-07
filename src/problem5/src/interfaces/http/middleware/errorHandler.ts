import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, ValidationError, type FieldIssue } from '../../../shared/errors';
import type { Logger } from '../../../shared/logger';
import { requestId } from './requestContext';

/**
 * RFC 9457 "Problem Details for HTTP APIs".
 *
 * A single, documented error shape beats every endpoint inventing its own. The
 * media type is `application/problem+json` so a client can tell a structured
 * error from a normal body without inspecting the status code.
 */
export interface ProblemDocument {
  /** Stable URI-ish identifier for the problem class. */
  readonly type: string;
  /** Short, human-readable summary. Safe to display. */
  readonly title: string;
  readonly status: number;
  /** Explanation specific to this occurrence. */
  readonly detail: string;
  /** The request path this occurred on. */
  readonly instance: string;
  /** Machine-readable code; clients branch on this, never on `detail`. */
  readonly code: string;
  /** Correlation id, so a user can quote it and support can find the log line. */
  readonly requestId: string;
  readonly [extension: string]: unknown;
}

function zodToFieldIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Body-parser failures arrive as generic `Error`s with a `type` property.
 * Left unhandled they become 500s, which is wrong: malformed JSON and an
 * oversized body are both the client's doing.
 */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

function classifyBodyParserError(
  error: BodyParserError,
): { status: number; code: string; detail: string } | null {
  switch (error.type) {
    case 'entity.parse.failed':
      return {
        status: 400,
        code: 'MALFORMED_JSON',
        detail: 'The request body is not valid JSON.',
      };
    case 'entity.too.large':
      return {
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        detail: 'The request body exceeds the configured size limit.',
      };
    case 'encoding.unsupported':
      return {
        status: 415,
        code: 'UNSUPPORTED_ENCODING',
        detail: 'The request body uses an unsupported content encoding.',
      };
    default:
      return null;
  }
}

/**
 * The single place an error becomes an HTTP response.
 *
 * The governing rule: **anything not explicitly recognised is a 500 whose
 * details never reach the client.** Driver errors carry table names, column
 * names, SQL fragments and sometimes row values; stack traces carry filesystem
 * paths. Those go to the log, addressable by `requestId`, and the client gets a
 * generic message plus that id.
 */
export function errorHandler(logger: Logger, isProduction: boolean): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    // Express requires the four-arity signature to recognise this as an error
    // handler; if the response has already started streaming, the only correct
    // action is to let the default handler destroy the socket.
    if (res.headersSent) {
      next(error);
      return;
    }

    const base = { instance: req.originalUrl, requestId: requestId(req) };

    if (error instanceof ZodError) {
      const validation = new ValidationError(zodToFieldIssues(error));
      res.status(validation.httpStatus).type('application/problem+json').json({
        type: 'about:blank',
        title: 'Validation failed',
        status: validation.httpStatus,
        detail: validation.message,
        code: validation.code,
        issues: validation.issues,
        ...base,
      } satisfies ProblemDocument);
      return;
    }

    if (error instanceof AppError) {
      // Expected failures are logged at warn: they are part of normal
      // operation, and paging someone because a client sent a bad SKU is how
      // alerting gets ignored.
      logger.warn({ err: error, requestId: requestId(req), code: error.code }, 'request failed');
      res
        .status(error.httpStatus)
        .type('application/problem+json')
        .json({
          type: 'about:blank',
          title: error.name.replace(/Error$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
          status: error.httpStatus,
          detail: error.message,
          code: error.code,
          ...error.details,
          ...base,
        } satisfies ProblemDocument);
      return;
    }

    const bodyParserProblem =
      error instanceof Error ? classifyBodyParserError(error as BodyParserError) : null;
    if (bodyParserProblem !== null) {
      res.status(bodyParserProblem.status).type('application/problem+json').json({
        type: 'about:blank',
        title: 'Bad request',
        status: bodyParserProblem.status,
        detail: bodyParserProblem.detail,
        code: bodyParserProblem.code,
        ...base,
      } satisfies ProblemDocument);
      return;
    }

    // Genuinely unexpected. Log everything, disclose nothing.
    logger.error({ err: error, requestId: requestId(req) }, 'unhandled error');
    res
      .status(500)
      .type('application/problem+json')
      .json({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: isProduction
          ? 'An unexpected error occurred. Quote the requestId when reporting this.'
          : `An unexpected error occurred: ${
              error instanceof Error ? error.message : String(error)
            }`,
        code: 'INTERNAL_ERROR',
        ...base,
      } satisfies ProblemDocument);
  };
}

/** Terminal 404 for unmatched routes, in the same problem+json shape. */
export function notFoundHandler() {
  return (req: Request, res: Response): void => {
    res.status(404).type('application/problem+json').json({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: `No route matches ${req.method} ${req.path}.`,
      code: 'ROUTE_NOT_FOUND',
      instance: req.originalUrl,
      requestId: requestId(req),
    } satisfies ProblemDocument);
  };
}
