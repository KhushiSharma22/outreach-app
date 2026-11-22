import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresConnectionOptions } from '../server/db.mjs';

test('remote database connections verify TLS and preserve non-TLS connection options', () => {
  const options = postgresConnectionOptions('postgres://user:pass@db.example.test/db?sslmode=require&application_name=outbound', { VERCEL: '1' });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  const parsed = new URL(options.connectionString);
  assert.equal(parsed.searchParams.has('sslmode'), false);
  assert.equal(parsed.searchParams.get('application_name'), 'outbound');
});

test('production cannot disable TLS for a remote database; local development still works', () => {
  assert.throws(() => postgresConnectionOptions('postgres://u:p@db.example.test/db', { NODE_ENV: 'production', DATABASE_SSL: 'false' }), /not allowed/);
  assert.equal(postgresConnectionOptions('postgres://u:p@127.0.0.1:5432/db', { NODE_ENV: 'test' }).ssl, false);
});

test('custom database CA is kept authoritative over connection-string SSL options', () => {
  const options = postgresConnectionOptions('postgres://u:p@db.example.test/db?sslmode=require', { DATABASE_CA_CERT_PEM: 'line1\\nline2' });
  assert.deepEqual(options.ssl, { ca: 'line1\nline2', rejectUnauthorized: true });
  assert.throws(() => postgresConnectionOptions('postgres://u:p@db.example.test/db?sslrootcert=other.pem', {}), /DATABASE_CA_CERT/);
});
