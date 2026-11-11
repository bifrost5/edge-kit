import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareAccessAdapter, accessTargetError } from '../../src/adapters/cloudflareAccess.ts';
import { runEdgeAccess } from '../../src/cli/edgeCommands.ts';
import type { AccessPolicy } from '../../src/domain/ports.ts';
import { envelope, liveApp } from '../fixtures/cloudflareAccessApi.ts';

const TARGET = 'sites.example.com/p/alice--*';
const POLICY: AccessPolicy = { decision: 'allow', include: [{ email: { email: 'operator@example.com' } }] };

interface Call { url: string; method: string; body?: any }

function stub(apps: unknown[]) {
  const calls: Call[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(method === 'GET' ? envelope(apps) : envelope(liveApp({ domain: TARGET }))), { status: 200 });
  };
  return { f: f as unknown as typeof fetch, calls };
}
const adapter = (f: typeof fetch) => new CloudflareAccessAdapter({ fetch: f, accountId: 'acc', token: 'tok-secret' });

test('dry-run diff shows host/path and sends no mutation', async () => {
  const { f, calls } = stub([]);
  const r = await runEdgeAccess(adapter(f), TARGET, 'Alice', POLICY, false);
  assert.equal(r.applied, false);
  assert.ok(r.diff?.includes(TARGET));
  assert.deepEqual(calls.filter((c) => c.method !== 'GET'), []);
});

test('apply sends host/path as the app domain', async () => {
  const { f, calls } = stub([]);
  await runEdgeAccess(adapter(f), TARGET, 'Alice', POLICY, true);
  const post = calls.find((c) => c.method === 'POST')!;
  assert.equal(post.body.domain, TARGET);
});

test('rerun against an app with the same host/path is idempotent', async () => {
  const { f, calls } = stub([liveApp({ name: 'Alice', domain: TARGET })]);
  const r = await runEdgeAccess(adapter(f), TARGET, 'Alice', POLICY, true);
  assert.equal(r.changed, false);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET'), []);
});

test('a host without the path does not match the path app', async () => {
  const { f, calls } = stub([liveApp({ name: 'Alice', domain: TARGET })]);
  const r = await runEdgeAccess(adapter(f), 'sites.example.com', 'Alice', POLICY, false);
  assert.equal(r.changed, true);
  assert.equal(calls.length, 1);
});

test('bad path is refused, plain host passes', async () => {
  for (const bad of ['sites.example.com/p/a b', 'sites.example.com/p/`x`', 'sites.example.com/a?x=1']) {
    assert.ok(accessTargetError(bad), bad);
    const { f, calls } = stub([]);
    await assert.rejects(runEdgeAccess(adapter(f), bad, 'A', POLICY, true), /edge access path must match/);
    assert.equal(calls.length, 0);
  }
  assert.equal(accessTargetError('sites.example.com'), undefined);
  assert.equal(accessTargetError(TARGET), undefined);
});
