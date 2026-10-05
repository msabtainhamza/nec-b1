import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { DatabaseService } from '../src/database/database.service.js';

let app: INestApplication;

before(async () => {
  app = await createApp({ config: loadConfig({ ...process.env, NODE_ENV: 'test' }) });
  await app.init();
});

after(async () => {
  await app.close();
});

it('reports public readiness only after the database query succeeds', async (t) => {
  const executor = app.get(DatabaseService).db.getExecutor();
  const query = t.mock.method(executor, 'executeQuery', async () => ({ rows: [] }));
  const response = await request(app.getHttpServer()).get('/health').expect(200);
  assert.deepEqual(response.body, { status: 'ok', apiVersion: 'v1', database: 'ok' });
  assert.equal(query.mock.callCount(), 1);
  assert.equal(query.mock.calls[0]?.arguments[0]?.sql, 'select 1');
});

it('returns 503 for refused IPv4 and IPv6 connections without leaking database details', async (t) => {
  const executor = app.get(DatabaseService).db.getExecutor();
  const refused = Object.assign(new Error('secret connection details'), { code: 'ECONNREFUSED' });
  t.mock.method(executor, 'executeQuery', async () => { throw new AggregateError([refused, refused]); });
  const log = t.mock.method(Logger.prototype, 'warn', () => undefined);
  const response = await request(app.getHttpServer()).get('/health').expect(503);
  assert.equal(response.body.error.code, 'DATABASE_UNAVAILABLE');
  assert.equal(response.body.error.correlationId, response.headers['x-correlation-id']);
  assert.ok(response.body.error.correlationId);
  assert.match(response.body.error.message, /Restore database connectivity/);
  assert.doesNotMatch(JSON.stringify(response.body), /secret|ECONNREFUSED|stack/);
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(log.mock.calls[0]?.arguments[0])), {
    event: 'health.database_unavailable', codes: ['ECONNREFUSED'],
  });
});

it('returns 503 for other database failures and recovers on the next successful probe', async (t) => {
  const executor = app.get(DatabaseService).db.getExecutor();
  const query = t.mock.method(executor, 'executeQuery', async () => ({ rows: [] }));
  query.mock.mockImplementationOnce(async () => { throw new Error('private database error'); });
  t.mock.method(Logger.prototype, 'warn', () => undefined);
  const http = request(app.getHttpServer());
  const failed = await http.get('/health').expect(503);
  assert.equal(failed.body.error.code, 'DATABASE_UNAVAILABLE');
  await http.get('/health').expect(200);
});
