import pino, { type DestinationStream } from 'pino';

/**
 * Paths scrubbed from every log line.
 *
 * This is not decoration. Request logging serialises whole header objects, and
 * `authorization` / `cookie` headers routinely end up in log aggregators that
 * far more people can read than can read the database.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
] as const;

/**
 * Builds a logger.
 *
 * Exposed as a factory - rather than only the singleton below - so the
 * redaction rules can be tested against a real destination stream. A redaction
 * list nobody verifies is a list that quietly stops matching after the first
 * header rename.
 */
export function createLogger(level: string, destination?: DestinationStream) {
  const options = {
    level,
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
    // ISO timestamps rather than epoch milliseconds: log aggregators sort and
    // window on them, and epoch values are a recurring source of timezone
    // confusion during an incident.
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

/**
 * Process-wide logger.
 *
 * JSON rather than pretty-printed text, because logs are read by machines in
 * every environment that matters.
 */
export const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

export type Logger = typeof logger;
