import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';

test('golden test: dynamic/probe-block.yml matches tests/golden/probe-block.yml byte-for-byte', async () => {
  const renderedPath = path.join(process.cwd(), 'dynamic/probe-block.yml');
  const goldenPath = path.join(process.cwd(), 'tests/golden/probe-block.yml');

  const renderedBytes = await fs.readFile(renderedPath);
  const goldenBytes = await fs.readFile(goldenPath);

  assert.equal(
    renderedBytes.equals(goldenBytes),
    true,
    `dynamic/probe-block.yml does not match tests/golden/probe-block.yml byte-for-byte.\nRendered:\n${renderedBytes.toString('utf8')}\nGolden:\n${goldenBytes.toString('utf8')}`
  );

  const parsed: any = parse(renderedBytes.toString('utf8'));
  assert.ok(parsed.http, 'http section must exist');

  const router = parsed.http.routers?.['edgekit-scanner-block'];
  assert.ok(router, 'edgekit-scanner-block router must exist');
  assert.equal(router.priority, 1000, 'router priority must be high (1000)');
  assert.deepEqual(router.entryPoints, ['web'], 'router entryPoints must include web');
  assert.deepEqual(
    router.middlewares,
    ['edgekit-security@file'],
    'router must chain through the shared edgekit-security@file middleware'
  );
  assert.equal(
    router.service,
    'edgekit-scanner-blackhole',
    'router service must be the scanner blackhole'
  );

  const expectedPrefixes = [
    '/.env',
    '/wp-login.php',
    '/wp-admin',
    '/.git',
    '/phpmyadmin',
    '/xmlrpc.php',
  ];

  const rule: string = router.rule;
  assert.equal(typeof rule, 'string', 'router rule must be a string');
  for (const prefix of expectedPrefixes) {
    assert.ok(
      rule.includes(`PathPrefix(\`${prefix}\`)`),
      `router rule must contain PathPrefix for ${prefix}`
    );
  }

  const service = parsed.http.services?.['edgekit-scanner-blackhole'];
  assert.ok(service, 'edgekit-scanner-blackhole service must exist');
  assert.deepEqual(
    service.loadBalancer?.servers,
    [{ url: 'http://127.0.0.1:9' }],
    'blackhole service must point at the discard port'
  );
});

test('secrets-block router: any path with a secrets segment or test-users.json never reaches an app', async () => {
  const parsed: any = parse(await fs.readFile(path.join(process.cwd(), 'dynamic/probe-block.yml'), 'utf8'));
  const router = parsed.http.routers?.['edgekit-secrets-block'];
  assert.ok(router, 'edgekit-secrets-block router must exist');
  assert.equal(router.priority, 1000);
  assert.deepEqual(router.entryPoints, ['web']);
  assert.equal(router.service, 'edgekit-scanner-blackhole');
  const m = /^PathRegexp\(`(.+)`\)$/.exec(router.rule);
  assert.ok(m, `rule must be one PathRegexp, got ${router.rule}`);
  const re = new RegExp(m[1]);
  for (const p of ['/secrets/test-users.json', '/p/casa--montessori/secrets/x', '/secrets', '/a/test-users.json']) assert.ok(re.test(p), `must block ${p}`);
  for (const p of ['/p/casa--montessori/', '/assets/secretsPanel.js', '/docs/secrets.md', '/mysecrets/x']) assert.ok(!re.test(p), `must not block ${p}`);
});
