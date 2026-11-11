import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const EDGECTL_BIN = path.join(REPO_ROOT, 'bin', 'edgectl');

type RunResult = { code: number | null; stdout: string; stderr: string };

function runEdgectl(args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(EDGECTL_BIN, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const POLICY = {
  reservedOwners: ['foundry*', 'apps', 'admin', 'api', 'control', 'connect'],
  allowedHosts: ['sites.example.com'],
  ownerCidrs: { alice: ['10.20.0.0/16'], bob: ['10.30.0.0/16'] },
};

async function setup(): Promise<{ tmp: string; env: Record<string, string> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'edgectl-owner-'));
  const policyFile = path.join(tmp, 'policy.json');
  await fs.mkdir(path.join(tmp, 'dynamic'), { recursive: true });
  await fs.writeFile(policyFile, JSON.stringify(POLICY));
  const env = {
    EDGEKIT_STATE_DIR: path.join(tmp, 'state'),
    EDGEKIT_DYNAMIC_DIR: path.join(tmp, 'dynamic'),
    EDGEKIT_POLICY: policyFile,
    EDGEKIT_ENABLED: '1',
  };
  const reg = async (owner: string, name: string, ip: string): Promise<void> => {
    const r = await runEdgectl(['register', '--owner', owner, '--name', name, '--host', 'sites.example.com', '--target', `http://${ip}:3000`], env);
    assert.equal(r.code, 0, r.stderr);
  };
  await reg('alice', 'a', '10.20.0.5');
  await reg('alice', 'b', '10.20.0.6');
  await reg('alice', 'c', '10.20.0.7');
  await reg('bob', 'x', '10.30.0.5');
  return { tmp, env };
}

test('list --owner filters and an unknown owner prints []', async () => {
  const { tmp, env } = await setup();
  try {
    const alice = JSON.parse((await runEdgectl(['list', '--owner', 'alice'], env)).stdout) as unknown[];
    assert.equal(alice.length, 3);
    const nobody = JSON.parse((await runEdgectl(['list', '--owner', 'nobody'], env)).stdout) as unknown[];
    assert.deepEqual(nobody, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('unregister-owner removes all of one owner and is idempotent', async () => {
  const { tmp, env } = await setup();
  try {
    const first = await runEdgectl(['unregister-owner', 'alice'], env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal((JSON.parse(first.stdout) as { removed: string[] }).removed.length, 3);
    const bob = JSON.parse((await runEdgectl(['list', '--owner', 'bob'], env)).stdout) as unknown[];
    assert.equal(bob.length, 1);
    const files = await fs.readdir(env['EDGEKIT_DYNAMIC_DIR']!);
    assert.ok(!files.some((f) => f.startsWith('alice--')));
    const second = await runEdgectl(['unregister-owner', 'alice'], env);
    assert.equal(second.code, 0);
    assert.deepEqual(JSON.parse(second.stdout), { removed: [] });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('unregister-owner with the flag off exits 3', async () => {
  const { tmp, env } = await setup();
  try {
    const r = await runEdgectl(['unregister-owner', 'alice'], { ...env, EDGEKIT_ENABLED: '0' });
    assert.equal(r.code, 3);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
