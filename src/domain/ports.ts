import type { RouteSpec } from './routeSpec.ts';

export interface RouteStorePort {
  put(spec: RouteSpec): Promise<void> | void;
  get(id: string): Promise<RouteSpec | null> | RouteSpec | null;
  list(): Promise<RouteSpec[]> | RouteSpec[];
  delete(id: string): Promise<boolean> | boolean;
}

export interface RouteRenderPort {
  write(spec: RouteSpec): Promise<void> | void;
  remove(id: string): Promise<boolean> | boolean;
  listIds(): Promise<string[]> | string[];
}

export interface QuotaStatePort {
  recordRegistration(owner: string, nowMs: number): Promise<void> | void;
  countInWindow(owner: string, windowMs: number, nowMs: number): Promise<number> | number;
}

export interface Clock {
  now(): number;
}

export interface DnsEnsureOpts {
  dryRun: boolean;
  proxied?: boolean;
  ttl?: number;
}

export interface DnsPort {
  ensureCname(
    hostname: string,
    target: string,
    opts: DnsEnsureOpts
  ): Promise<{ changed: boolean; recordId?: string; diff?: string }>;
  removeCname(
    hostname: string,
    opts: { dryRun: boolean }
  ): Promise<{ changed: boolean; diff?: string }>;
}

export interface TunnelIngressOpts {
  dryRun: boolean;
}

export interface TunnelIngressPort {
  addHost(
    hostname: string,
    service: string,
    opts: TunnelIngressOpts
  ): Promise<{ changed: boolean; diff: string }>;
  removeHost(
    hostname: string,
    opts: TunnelIngressOpts
  ): Promise<{ changed: boolean; diff: string }>;
}

export interface AccessPolicyRule {
  [key: string]: unknown;
}

export interface AccessPolicy {
  decision: 'allow' | 'deny' | 'non_identity' | 'bypass';
  include: AccessPolicyRule[];
  exclude?: AccessPolicyRule[];
  require?: AccessPolicyRule[];
  [key: string]: unknown;
}

export interface AccessApp {
  id: string;
  name: string;
  domain: string;
  aud?: string;
  policies?: AccessPolicy[];
  [key: string]: unknown;
}

export interface AccessEnsureOpts {
  dryRun: boolean;
  /** Managed OAuth for non-browser clients (MCP). Passed through as `oauth_configuration`. */
  oauth?: unknown;
  /** App type: omit for the default 'self_hosted', or 'ssh' for browser-rendered SSH. */
  appType?: 'ssh';
}

export interface AccessPort {
  list(): Promise<AccessApp[]>;
  ensure(
    hostname: string,
    name: string,
    policy: AccessPolicy,
    opts: AccessEnsureOpts
  ): Promise<{ changed: boolean; appId?: string; aud?: string; diff?: string }>;
  remove(
    hostname: string,
    opts: AccessEnsureOpts
  ): Promise<{ changed: boolean; diff?: string }>;
}

export type ResolvedTarget = {
  ip: string;
  container: string;
  labels?: Record<string, string>;
  /** Network subnet (CIDR) when the resolver knows it. */
  subnet?: string;
};

export interface TargetResolverPort {
  resolve(alias: string): Promise<ResolvedTarget[]>;
}
