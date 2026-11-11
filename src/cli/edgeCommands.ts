import type {
  AccessPolicy,
  AccessPort,
  DnsPort,
  TunnelIngressPort,
} from '../domain/ports.ts';

export interface EdgeCommandOutput {
  hostname: string;
  changed: boolean;
  applied: boolean;
  diff?: string;
  recordId?: string;
  appId?: string;
  aud?: string;
}

/**
 * dryRun is derived from `apply` here so callers (and their tests) only ever
 * reason about one flag: whichever adapter method fires below is the single
 * place a mutating Cloudflare call could happen.
 */
export async function runEdgeIngress(
  port: TunnelIngressPort,
  hostname: string,
  service: string,
  apply: boolean
): Promise<EdgeCommandOutput> {
  const result = await port.addHost(hostname, service, { dryRun: !apply });
  return { hostname, changed: result.changed, applied: apply, diff: result.diff };
}

export async function runEdgeDns(
  port: DnsPort,
  hostname: string,
  target: string,
  apply: boolean,
  opts: { proxied?: boolean; ttl?: number } = {}
): Promise<EdgeCommandOutput> {
  const result = await port.ensureCname(hostname, target, { dryRun: !apply, ...opts });
  return { hostname, changed: result.changed, applied: apply, diff: result.diff, recordId: result.recordId };
}

export async function runEdgeAccess(
  port: AccessPort,
  hostname: string,
  name: string,
  policy: AccessPolicy,
  apply: boolean,
  oauth?: unknown,
  appType?: 'ssh'
): Promise<EdgeCommandOutput> {
  const result = await port.ensure(hostname, name, policy, { dryRun: !apply, oauth, appType });
  return { hostname, changed: result.changed, applied: apply, diff: result.diff, appId: result.appId, aud: result.aud };
}

/**
 * Managed OAuth for MCP and other non-browser clients (Cloudflare Access acts as the authorization server).
 * Short access token + long grant session, per the Cloudflare Managed OAuth guidance for CLI/agent use.
 */
export const MANAGED_OAUTH_AGENT = {
  enabled: true,
  dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true },
  grant: { access_token_lifetime: '15m', session_duration: '336h' },
} as const;

export async function runEdgeCa(
  adapter: { ensureCa(hostname: string, opts: { dryRun: boolean }): Promise<{ changed: boolean; aud?: string; publicKey?: string; diff?: string }> },
  hostname: string,
  apply: boolean
): Promise<{ hostname: string; changed: boolean; applied: boolean; diff?: string; publicKey?: string; aud?: string }> {
  const r = await adapter.ensureCa(hostname, { dryRun: !apply });
  return { hostname, changed: r.changed, applied: apply, diff: r.diff, publicKey: r.publicKey, aud: r.aud };
}
