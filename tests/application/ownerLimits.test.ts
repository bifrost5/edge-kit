import test from 'node:test';
import assert from 'node:assert/strict';

import type { RouteSpec, Policy } from '../../src/domain/routeSpec.ts';
import type { RouteStorePort, RouteRenderPort, QuotaStatePort, Clock } from '../../src/domain/ports.ts';
import { RouteManager } from '../../src/application/routeManager.ts';

class FakeRouteStore implements RouteStorePort {
  routes: Map<string, RouteSpec> = new Map();
  put(spec: RouteSpec): void {
    this.routes.set(spec.id, spec);
  }
  get(id: string): RouteSpec | null {
    return this.routes.get(id) ?? null;
  }
  list(): RouteSpec[] {
    return Array.from(this.routes.values());
  }
  delete(id: string): boolean {
    return this.routes.delete(id);
  }
}

class FakeRouteRenderer implements RouteRenderPort {
  rendered: Map<string, RouteSpec> = new Map();
  write(spec: RouteSpec): void {
    this.rendered.set(spec.id, spec);
  }
  remove(id: string): boolean {
    return this.rendered.delete(id);
  }
  listIds(): string[] {
    return Array.from(this.rendered.keys());
  }
}

class FakeQuota implements QuotaStatePort {
  recordRegistration(): void {}
  countInWindow(): number {
    return 0;
  }
}

const clock: Clock = { now: () => 1000 };

const basePolicy: Policy = {
  allowedHosts: ['sites.example.com'],
  ownerCidrs: { alice: ['10.20.0.0/16'], bob: ['10.30.0.0/16'] },
};

function createManager(extra: Partial<Policy> = {}) {
  return new RouteManager({
    store: new FakeRouteStore(),
    renderer: new FakeRouteRenderer(),
    quota: new FakeQuota(),
    clock,
    policy: { ...basePolicy, ...extra },
  }, { maxRegistrationsPerWindow: 1000 });
}

function input(owner: string, n: number) {
  const net = owner === 'alice' ? '10.20' : '10.30';
  return {
    owner,
    id: `${owner}--r${n}`,
    host: 'sites.example.com',
    target: `http://${net}.0.${n + 1}:3000`,
    access: 'private',
  };
}

test('default cap stays 20', async () => {
  const m = createManager();
  for (let i = 0; i < 20; i++) await m.register(input('alice', i));
  await assert.rejects(() => m.register(input('alice', 20)), /Max routes per owner exceeded/);
});

test('policy cap 2 refuses the third route of one owner', async () => {
  const m = createManager({ maxRoutesPerOwner: 2 });
  await m.register(input('alice', 0));
  await m.register(input('alice', 1));
  await assert.rejects(() => m.register(input('alice', 2)), /Max routes per owner exceeded.*max: 2/);
});

test('ownerLimits alice 1 and cap 3 for bob', async () => {
  const m = createManager({ maxRoutesPerOwner: 3, ownerLimits: { alice: { maxRoutes: 1 } } });
  await m.register(input('alice', 0));
  await assert.rejects(() => m.register(input('alice', 1)), /max: 1/);
  for (let i = 0; i < 3; i++) await m.register(input('bob', i));
  await assert.rejects(() => m.register(input('bob', 3)), /max: 3/);
});

test('bad cap values are refused', async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const m = createManager({ maxRoutesPerOwner: bad });
    await assert.rejects(() => m.register(input('alice', 0)), /^Error: Invalid policy/);
    const m2 = createManager({ ownerLimits: { alice: { maxRoutes: bad } } });
    await assert.rejects(() => m2.register(input('alice', 0)), /^Error: Invalid policy/);
  }
});
