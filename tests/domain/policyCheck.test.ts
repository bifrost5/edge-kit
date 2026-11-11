import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { validatePolicy } from '../../src/domain/routeSpec.ts';

const EDGECTL_BIN = path.resolve(import.meta.dirname, '../..', 'bin', 'edgectl');

const VALID = {
  reservedOwners: ['ops', 'system', 'internal'],
  allowedHosts: ['sites.example.com', 'test.example.com'],
  siteHosts: ['portal.example.com'],
  ownerCidrs: { alice: ['10.20.0.0/16'], bob: ['10.30.0.0/16'] },
  denyIps: ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8'],
  publicOwners: ['bob'],
  maxRoutesPerOwner: 10,
  ownerLimits: { alice: { maxRoutes: 5 } },
};

test('the README sample policy passes', () => {
  assert.deepEqual(validatePolicy(VALID), []);
});

const BAD: [string, unknown][] = [
  ['not an object', 'x'],
  ['empty allowedHosts', { ...VALID, allowedHosts: [] }],
  ['bad host string', { ...VALID, allowedHosts: ['Bad Host'] }],
  ['siteHosts not strings', { ...VALID, siteHosts: [1] }],
  ['publicOwners not an array', { ...VALID, publicOwners: 'bob' }],
  ['reservedOwners not strings', { ...VALID, reservedOwners: [1] }],
  ['bad owner CIDR', { ...VALID, ownerCidrs: { alice: ['10.20.0.0/33'] } }],
  ['bad denyIps', { ...VALID, denyIps: ['nope'] }],
  ['zero maxRoutesPerOwner', { ...VALID, maxRoutesPerOwner: 0 }],
  ['bad ownerLimits', { ...VALID, ownerLimits: { alice: { maxRoutes: -1 } } }],
  ['unknown key', { ...VALID, surprise: true }],
];
for (const [label, policy] of BAD) {
  test(`rejects: ${label}`, () => {
    assert.ok(validatePolicy(policy).length > 0);
  });
}

test('ownerTargets is accepted', () => {
  assert.deepEqual(validatePolicy({ ...VALID, ownerTargets: { alice: ['web'] } }), []);
});

test('policy-check CLI exits 0 for good and 2 for a bad CIDR, with no state env', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'policycheck-'));
  try {
    const good = path.join(tmp, 'good.json');
    const bad = path.join(tmp, 'bad.json');
    await fs.writeFile(good, JSON.stringify(VALID));
    await fs.writeFile(bad, JSON.stringify({ ...VALID, ownerCidrs: { alice: ['10.0.0.0/99'] } }));
    const env = { PATH: process.env['PATH'] };
    const g = spawnSync(EDGECTL_BIN, ['policy-check', '--file', good], { env, encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
    assert.deepEqual(JSON.parse(g.stdout), { ok: true });
    const b = spawnSync(EDGECTL_BIN, ['policy-check', '--file', bad], { env, encoding: 'utf8' });
    assert.equal(b.status, 2);
    assert.match(b.stderr, /ownerCidrs\.alice/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
