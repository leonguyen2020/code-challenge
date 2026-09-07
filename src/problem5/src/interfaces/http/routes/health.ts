import { Router } from 'express';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';

/**
 * Liveness and readiness.
 *
 * These are not resource endpoints and do not count against the "five
 * operations" the brief specifies; they are how an orchestrator decides whether
 * to restart the process or route traffic to it.
 *
 * The distinction matters and is routinely got wrong:
 *
 *   * **`/healthz` (liveness)** answers "is this process wedged?". It checks
 *     nothing external. If it probed the database, a database blip would make
 *     Kubernetes *restart every replica* - turning a recoverable dependency
 *     outage into a crash loop that guarantees an outage.
 *   * **`/readyz` (readiness)** answers "can this instance serve traffic right
 *     now?". It does check dependencies, because the correct response to a
 *     database outage is to stop routing requests here, not to restart.
 */
export function healthRoutes(dataSource: DataSource, redis: Redis): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
  });

  router.get('/readyz', async (_req, res) => {
    const checks = await Promise.all([
      probe('postgres', async () => {
        await dataSource.query('SELECT 1');
      }),
      probe('redis', async () => {
        await redis.ping();
      }),
    ]);

    const ready = checks.every((check) => check.ok);
    // 503 rather than 200-with-a-flag: load balancers and orchestrators read
    // the status code, not the body.
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: Object.fromEntries(checks.map((check) => [check.name, check.ok ? 'ok' : 'failed'])),
    });
  });

  return router;
}

async function probe(name: string, check: () => Promise<void>): Promise<{ name: string; ok: boolean }> {
  try {
    await check();
    return { name, ok: true };
  } catch {
    // The reason is deliberately not returned: readiness responses are
    // frequently exposed and a driver error names hosts, databases and users.
    return { name, ok: false };
  }
}
