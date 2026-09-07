import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { healthRoutes } from '../../src/interfaces/http/routes/health';

function app(pgOk: boolean, redisOk: boolean) {
  const dataSource = {
    query: async () => {
      if (!pgOk) throw new Error('connection refused to host db-primary as user app');
      return [{ '?column?': 1 }];
    },
  } as unknown as DataSource;
  const redis = {
    ping: async () => {
      if (!redisOk) throw new Error('ECONNREFUSED 10.0.0.5:6379');
      return 'PONG';
    },
  } as unknown as Redis;
  return express().use(healthRoutes(dataSource, redis));
}

describe('liveness and readiness', () => {
  it('reports liveness without touching any dependency', async () => {
    // If /healthz probed the database, a database blip would make the
    // orchestrator restart every replica - turning a recoverable dependency
    // outage into a guaranteed crash loop.
    const response = await request(app(false, false)).get('/healthz').expect(200);
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.uptimeSeconds).toBe('number');
  });

  it('reports ready when both dependencies answer', async () => {
    const response = await request(app(true, true)).get('/readyz').expect(200);
    expect(response.body).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it.each([
    ['postgres is down', false, true, { postgres: 'failed', redis: 'ok' }],
    ['redis is down', true, false, { postgres: 'ok', redis: 'failed' }],
    ['both are down', false, false, { postgres: 'failed', redis: 'failed' }],
  ])('returns 503 when %s', async (_label, pgOk, redisOk, checks) => {
    // 503 rather than 200-with-a-flag: load balancers read the status code.
    const response = await request(app(pgOk, redisOk)).get('/readyz').expect(503);
    expect(response.body).toEqual({ status: 'not_ready', checks });
  });

  it('never discloses why a dependency failed', async () => {
    // Readiness endpoints are widely exposed, and a driver error names hosts,
    // databases and users.
    const response = await request(app(false, false)).get('/readyz').expect(503);
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('db-primary');
    expect(serialised).not.toContain('10.0.0.5');
    expect(serialised).not.toContain('ECONNREFUSED');
  });
});
