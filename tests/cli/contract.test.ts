import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const EDGECTL_BIN = path.resolve(import.meta.dirname, '../..', 'bin', 'edgectl');

test('edgectl contract prints contract 1 without any edgekit env', () => {
  const r = spawnSync(EDGECTL_BIN, ['contract'], { env: { PATH: process.env['PATH'] }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]!) as { contract: number; version: string; features: string[] };
  assert.equal(j.contract, 1);
  assert.equal(typeof j.version, 'string');
  assert.ok(j.version.length > 0);
  assert.deepEqual(j.features, ['owner-limits', 'access-path', 'owner-commands']);
});
