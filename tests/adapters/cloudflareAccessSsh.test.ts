import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareAccessAdapter } from '../../src/adapters/cloudflareAccess.ts';
import { runEdgeAccess, runEdgeCa } from '../../src/cli/edgeCommands.ts';
import type { AccessPolicy } from '../../src/domain/ports.ts';
import { envelope, liveApp } from '../fixtures/cloudflareAccessApi.ts';

const HOST = 'alice-shell.example.com';
const POLICY: AccessPolicy = { decision: 'allow', include: [{ email: { email: 'operator@example.com' } }] };

interface Call { url: string; method: string; body?: any }

// Fake API: app list, plus a CA that exists only after a POST to /ca.
function fake(apps: unknown[], caExists = false) {
  const calls: Call[] = [];
  let ca = caExists;
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/ca')) {
      if (method === 'GET') {
        return ca
          ? new Response(JSON.stringify(envelope({ aud: 'aud-tag-1', public_key: 'ecdsa-sha2-nistp256 AAAAKEY' })), { status: 200 })
          : new Response(JSON.stringify({ success: false, errors: [] }), { status: 404 });
      }
      ca = true;
      return new Response(JSON.stringify(envelope({ aud: 'aud-tag-1', public_key: 'ecdsa-sha2-nistp256 AAAAKEY' })), { status: 200 });
    }
    if (method === 'GET') return new Response(JSON.stringify(envelope(apps)), { status: 200 });
    return new Response(JSON.stringify(envelope(liveApp({ domain: HOST, type: 'ssh' }))), { status: 200 });
  };
  return { f: f as unknown as typeof fetch, calls };
}
const adapter = (f: typeof fetch) => new CloudflareAccessAdapter({ fetch: f, accountId: 'acc', token: 'tok-secret' });

test('ssh type is sent on create', async () => {
  const { f, calls } = fake([]);
  await runEdgeAccess(adapter(f), HOST, 'ssh-alice', POLICY, true, undefined, 'ssh');
  assert.equal(calls.find((c) => c.method === 'POST')!.body.type, 'ssh');
});

test('default type stays self_hosted', async () => {
  const { f, calls } = fake([]);
  await runEdgeAccess(adapter(f), HOST, 'x', POLICY, true);
  assert.equal(calls.find((c) => c.method === 'POST')!.body.type, 'self_hosted');
});

test('edge ca dry-run prints a diff and creates nothing', async () => {
  const { f, calls } = fake([liveApp({ domain: HOST, type: 'ssh' })]);
  const r = await runEdgeCa(adapter(f), HOST, false);
  assert.equal(r.changed, true);
  assert.equal(r.applied, false);
  assert.ok(r.diff?.includes(HOST));
  assert.deepEqual(calls.filter((c) => c.method === 'POST'), []);
});

test('edge ca apply creates once and a rerun is idempotent', async () => {
  const { f, calls } = fake([liveApp({ domain: HOST, type: 'ssh' })]);
  const first = await runEdgeCa(adapter(f), HOST, true);
  assert.equal(first.changed, true);
  assert.equal(first.publicKey, 'ecdsa-sha2-nistp256 AAAAKEY');
  assert.equal(first.aud, 'aud-tag-1');
  const second = await runEdgeCa(adapter(f), HOST, true);
  assert.equal(second.changed, false);
  assert.equal(second.publicKey, 'ecdsa-sha2-nistp256 AAAAKEY');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('edge ca with no app for the host fails and never leaks the token', async () => {
  const { f } = fake([]);
  await assert.rejects(runEdgeCa(adapter(f), HOST, true), (e: Error) => /No Access app found/.test(e.message) && !e.message.includes('tok-secret'));
});
