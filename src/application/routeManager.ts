import type { RouteSpec, Policy } from '../domain/routeSpec.ts';
import { validateRouteSpec, isValidId, isKitReservedName } from '../domain/routeSpec.ts';
import type { RouteStorePort, RouteRenderPort, QuotaStatePort, Clock, TargetResolverPort } from '../domain/ports.ts';

export interface RouteManagerDeps {
  store: RouteStorePort;
  renderer: RouteRenderPort;
  quota: QuotaStatePort;
  clock: Clock;
  policy: Policy;
  resolver?: TargetResolverPort;
  aliasTargets?: boolean;
}

export interface RouteManagerLimits {
  maxRoutesPerOwner?: number;
  maxRegistrationsPerWindow?: number;
  windowMs?: number;
}

export interface RegisterResult {
  ok: true;
  spec: RouteSpec;
}

function specsEqual(a: RouteSpec, b: RouteSpec): boolean {
  return (
    a.id === b.id &&
    a.owner === b.owner &&
    a.host === b.host &&
    a.pathPrefix === b.pathPrefix &&
    a.target === b.target &&
    a.access === b.access &&
    a.stripPrefix === b.stripPrefix &&
    (a.kind ?? 'prefix') === (b.kind ?? 'prefix') &&
    a.redirectExactFrom === b.redirectExactFrom &&
    a.redirectTo === b.redirectTo
  );
}

const DEFAULT_DENY_IPS = ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8'];

function ipToNum(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return null;
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const a = ipToNum(ip);
  const b = ipToNum(base);
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
}

function aliasOf(target: string): string | null {
  const m = target.match(/^http:\/\/([^:/]+):\d+$/);
  if (!m || ipToNum(m[1]) !== null) return null;
  return m[1];
}

export class RouteManager {
  private deps: RouteManagerDeps;
  private maxRoutesPerOwner: number;
  private maxRegistrationsPerWindow: number;
  private windowMs: number;

  constructor(
    deps: RouteManagerDeps,
    limits?: RouteManagerLimits
  ) {
    this.deps = deps;
    this.maxRoutesPerOwner = limits?.maxRoutesPerOwner ?? 20;
    this.maxRegistrationsPerWindow = limits?.maxRegistrationsPerWindow ?? 10;
    this.windowMs = limits?.windowMs ?? 60000;
  }

  private async checkAlias(spec: RouteSpec): Promise<string[]> {
    const alias = aliasOf(spec.target);
    if (alias === null) return [];
    const resolver = this.deps.resolver;
    if (!resolver) return [`target alias '${alias}' requires a resolver`];
    let found;
    try {
      found = await resolver.resolve(alias);
    } catch (e) {
      return [`target alias '${alias}' could not resolve: ${(e as Error).message}`];
    }
    if (found.length === 0) return [`target alias '${alias}' did not resolve to any container`];
    if (found.length !== 1) {
      return [`target alias '${alias}' must resolve to exactly one container (got ${found.length})`];
    }
    const t = found[0];
    if (isKitReservedName(t.container) || t.labels?.['com.docker.compose.project'] === 'edgekit') {
      return [`target alias '${alias}' resolves to kit container '${t.container}'`];
    }
    for (const cidr of this.deps.policy.denyIps ?? DEFAULT_DENY_IPS) {
      if (inCidr(t.ip, cidr)) return [`target alias '${alias}' resolves to denied IP ${t.ip}`];
    }
    if (t.subnet && !inCidr(t.ip, t.subnet)) {
      return [`target alias '${alias}' resolves outside network subnet`];
    }
    const owner = spec.owner;
    const allowlisted = (this.deps.policy.ownerTargets?.[owner] ?? []).includes(alias);
    if (!allowlisted && t.container !== owner && t.labels?.['edgekit.owner'] !== owner) {
      return [`target alias '${alias}' is not owned by '${owner}'`];
    }
    return [];
  }

  private effectiveOwnerCap(owner: string): number {
    const policy = this.deps.policy;
    const ownerMax = policy.ownerLimits?.[owner]?.maxRoutes;
    for (const v of [ownerMax, policy.maxRoutesPerOwner]) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
        throw new Error(`Invalid policy: route cap must be a positive integer (got ${String(v)})`);
      }
    }
    return ownerMax ?? policy.maxRoutesPerOwner ?? this.maxRoutesPerOwner;
  }

  async register(input: unknown): Promise<RegisterResult> {
    const existingRoutes = await this.deps.store.list();
    // 1. Validation (pure, no I/O before validation passes)
    const validationResult = validateRouteSpec(input, this.deps.policy, existingRoutes, {
      aliasTargets: this.deps.aliasTargets,
    });
    if (!validationResult.ok) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }
    const spec = validationResult.spec;
    const ownerCap = this.effectiveOwnerCap(spec.owner);
    if (this.deps.aliasTargets) {
      const aliasErrors = await this.checkAlias(spec);
      if (aliasErrors.length > 0) {
        throw new Error(`Validation failed: ${aliasErrors.join(', ')}`);
      }
    }

    // 2. Check existing spec in store
    const existing = await this.deps.store.get(spec.id);
    if (existing && specsEqual(existing, spec)) {
      // Idempotent: same result, does NOT consume rate-limit quota, does not duplicate write
      return { ok: true, spec: existing };
    }

    const nowMs = this.deps.clock.now();

    // 3. Per-owner route cap: if this is a new route id, check cap
    if (!existing) {
      const ownerCount = existingRoutes.filter(r => r.owner === spec.owner).length;
      if (ownerCount >= ownerCap) {
        throw new Error(
          `Max routes per owner exceeded for owner '${spec.owner}' (current: ${ownerCount}, max: ${ownerCap})`
        );
      }
    }

    // 4. Rate limit check
    const currentWindowRegistrations = await this.deps.quota.countInWindow(
      spec.owner,
      this.windowMs,
      nowMs
    );
    if (currentWindowRegistrations >= this.maxRegistrationsPerWindow) {
      throw new Error(
        `Registration rate limit exceeded for owner '${spec.owner}' in window (current: ${currentWindowRegistrations}, max: ${this.maxRegistrationsPerWindow})`
      );
    }

    // 5. Consume rate-limit quota
    await this.deps.quota.recordRegistration(spec.owner, nowMs);

    // 6. On success: store.put then renderer.write
    await this.deps.store.put(spec);
    await this.deps.renderer.write(spec);

    return { ok: true, spec };
  }

  async unregister(id: string): Promise<boolean> {
    if (!isValidId(id)) {
      throw new Error(`Validation failed: invalid id '${id}'`);
    }
    await this.deps.store.delete(id);
    await this.deps.renderer.remove(id);
    return true;
  }

  async list(): Promise<RouteSpec[]> {
    const routes = await this.deps.store.list();
    return routes;
  }

  // Removes every route of one owner through the normal unregister path. Idempotent.
  async unregisterOwner(owner: string): Promise<string[]> {
    const routes = await this.deps.store.list();
    const removed: string[] = [];
    for (const r of routes) {
      if (r.owner !== owner) continue;
      await this.unregister(r.id);
      removed.push(r.id);
    }
    return removed;
  }

  async reconcile(): Promise<{ written: string[]; removed: string[]; skipped?: { id: string; errors: string[] }[] }> {
    const storeRoutes = await this.deps.store.list();
    const validStoreRouteMap = new Map<string, RouteSpec>();
    const skipped: { id: string; errors: string[] }[] = [];
    const keep = new Set<string>();

    for (const r of storeRoutes) {
      const valResult = validateRouteSpec(r, this.deps.policy, undefined, {
        aliasTargets: this.deps.aliasTargets,
      });
      if (valResult.ok) {
        if (this.deps.aliasTargets) {
          const aliasErrors = await this.checkAlias(valResult.spec);
          if (aliasErrors.length > 0) {
            skipped.push({ id: r.id, errors: aliasErrors });
            keep.add(r.id);
            continue;
          }
        }
        validStoreRouteMap.set(r.id, valResult.spec);
      } else {
        skipped.push({ id: r.id, errors: valResult.errors });
      }
    }

    const rendererIds = await this.deps.renderer.listIds();
    const rendererIdSet = new Set(rendererIds);

    const written: string[] = [];
    const removed: string[] = [];

    // 1. Remove orphans: renderer ids not in the valid store routes
    for (const rid of rendererIds) {
      if (!validStoreRouteMap.has(rid) && !keep.has(rid)) {
        await this.deps.renderer.remove(rid);
        removed.push(rid);
      }
    }

    // 2. Rewrite missing / ensure renderer matches store
    for (const [id, spec] of validStoreRouteMap) {
      if (!rendererIdSet.has(id)) {
        await this.deps.renderer.write(spec);
        written.push(id);
      }
    }

    const result: { written: string[]; removed: string[]; skipped?: { id: string; errors: string[] }[] } = {
      written,
      removed,
    };
    if (skipped.length > 0) {
      result.skipped = skipped;
    }

    return result;
  }
}
