/**
 * The application's error taxonomy.
 *
 * Every failure the API can produce is one of these. Two properties make that
 * useful rather than decorative:
 *
 *   * `code` is a stable, machine-readable string. Clients branch on it. It is
 *     API surface and may not be reworded.
 *   * `httpStatus` lives on the error itself, so the HTTP layer never has to
 *     guess a status from an error message or an `instanceof` ladder.
 *
 * Anything that is *not* an `AppError` reaching the error handler is, by
 * definition, a bug we did not anticipate - so it becomes a 500 and its details
 * are logged but never sent to the client.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'PRODUCT_NOT_FOUND'
  | 'SKU_ALREADY_EXISTS'
  | 'VERSION_CONFLICT'
  | 'INVALID_CURSOR'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

/** A single field-level validation problem, safe to return to the client. */
export interface FieldIssue {
  /** Dotted path to the offending field, e.g. `"price.amount"`. */
  readonly path: string;
  /**
   * Human-readable explanation. Never contains the submitted value verbatim -
   * enforced by `safeIssueMessage` in the error handler, because zod's own
   * default text for a failed enum echoes the input back.
   */
  readonly message: string;
}

export abstract class AppError extends Error {
  public abstract readonly code: ErrorCode;
  public abstract readonly httpStatus: number;

  /**
   * Extra machine-readable context merged into the problem document.
   * Must contain nothing secret: it is sent to the client.
   */
  public readonly details: Readonly<Record<string, unknown>>;

  protected constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
    this.details = Object.freeze({ ...details });
    /* istanbul ignore else -- V8-only API. */
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** Request body, query or params failed schema validation. */
export class ValidationError extends AppError {
  public readonly code = 'VALIDATION_FAILED' as const;
  public readonly httpStatus = 400;

  public constructor(public readonly issues: readonly FieldIssue[]) {
    super('The request payload failed validation.', { issues });
  }
}

/** No product exists with the requested identifier. */
export class ProductNotFoundError extends AppError {
  public readonly code = 'PRODUCT_NOT_FOUND' as const;
  public readonly httpStatus = 404;

  public constructor(public readonly id: string) {
    super(`No product exists with id "${id}".`, { id });
  }
}

/**
 * A product with this SKU already exists.
 *
 * Raised from the unique-constraint violation rather than from a prior
 * `SELECT`: checking first and inserting second is a race, and under
 * concurrency two requests both pass the check and one still fails. The
 * database constraint is the only authority.
 */
export class SkuAlreadyExistsError extends AppError {
  public readonly code = 'SKU_ALREADY_EXISTS' as const;
  public readonly httpStatus = 409;

  public constructor(public readonly sku: string) {
    super(`A product with SKU "${sku}" already exists.`, { sku });
  }
}

/**
 * The caller's `If-Match` version is stale: someone else modified the row first.
 *
 * This is the lost-update problem made visible. Without it, two concurrent
 * "set stock to X" requests silently discard one another's work.
 */
export class VersionConflictError extends AppError {
  public readonly code = 'VERSION_CONFLICT' as const;
  public readonly httpStatus = 409;

  public constructor(
    public readonly id: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Product "${id}" has been modified by another request ` +
        `(expected version ${expectedVersion}, current version ${actualVersion}). ` +
        `Re-read the resource and retry.`,
      { id, expectedVersion, actualVersion },
    );
  }
}

/** The pagination cursor was not produced by this service, or is corrupt. */
export class InvalidCursorError extends AppError {
  public readonly code = 'INVALID_CURSOR' as const;
  public readonly httpStatus = 400;

  public constructor(reason: string) {
    super(`The pagination cursor is not valid: ${reason}`);
  }
}

/** The caller exceeded the request budget for their window. */
export class RateLimitedError extends AppError {
  public readonly code = 'RATE_LIMITED' as const;
  public readonly httpStatus = 429;

  public constructor(public readonly retryAfterSeconds: number) {
    super('Too many requests. Slow down.', { retryAfterSeconds });
  }
}
