import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const README = fs.readFileSync(path.resolve(import.meta.dirname, '../..', 'README.md'), 'utf8');

test('README has the consumer contract section', () => {
  assert.ok(README.includes('## Consumer contract (version 1)'));
  const section = README.split('## Consumer contract (version 1)')[1]!.split('\n## ')[0]!;
  for (const word of [
    'register', 'unregister', 'unregister-owner', 'list --owner', 'reconcile', 'check',
    'policy-check', 'contract', 'edge access', '--type ssh', 'edge ca',
    'ownerCidrs', 'publicOwners', 'reservedOwners', 'maxRoutesPerOwner', 'ownerLimits',
    'bump the contract number'.replace('bump', 'Bump'),
  ]) {
    assert.ok(section.includes(word), `missing: ${word}`);
  }
});

test('the section sits before Not done yet', () => {
  assert.ok(README.indexOf('## Consumer contract (version 1)') < README.indexOf('## Not done yet'));
});
