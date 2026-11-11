import type {
  AccessApp,
  AccessEnsureOpts,
  AccessPolicy,
  AccessPort,
} from '../domain/ports.ts';

export interface AccessAppRaw {
  id: string;
  name: string;
  domain: string;
  aud?: string;
  type?: string;
  oauth_configuration?: unknown;
  policies?: unknown[];
  [key: string]: unknown;
}

export interface CloudflareAccessListResponse {
  result?: AccessAppRaw[];
  result_info?: unknown;
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  [key: string]: unknown;
}

/**
 * Cloudflare Access Applications API endpoint path template.
 * Verified 2026-10-24 against the Cloudflare OpenAPI spec: /accounts/{account_id}/access/apps (served under /client/v4).
 * Create/update bodies need `type: 'self_hosted'` and `domain`; responses carry `aud`; list is paginated via `result_info`.
 */
export const ACCESS_APPS_PATH_TEMPLATE = '/client/v4/accounts/{account_id}/access/apps';

const LIST_PAGE_SIZE = 50;

/** The live API returns policies enriched with id/uid/name/precedence/timestamps; compare only what we set. */
export function comparablePolicy(p: unknown): string {
  const x = (p ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    decision: x.decision,
    include: x.include ?? [],
    exclude: x.exclude ?? [],
    require: x.require ?? [],
  });
}

function redactToken(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join('[REDACTED]');
}

export function sanitizeError(err: unknown, token: string): Error {
  const originalMessage = err instanceof Error ? err.message : String(err);
  const safeMessage = redactToken(originalMessage, token);
  const safeErr = new Error(safeMessage);
  if (err instanceof Error && err.stack) {
    safeErr.stack = redactToken(err.stack, token);
  }
  return safeErr;
}

/** Request body per the Cloudflare ref: `type` and `domain` are required; inline policies need a name. */
export function appBody(hostname: string, name: string, policies: AccessPolicy[], oauth?: unknown) {
  const body: Record<string, unknown> = {
    type: 'self_hosted',
    name,
    domain: hostname,
    policies: policies.map((p, i) => ({ name: `${name} policy ${i + 1}`, ...p })),
  };
  if (oauth !== undefined) body.oauth_configuration = oauth;
  return body;
}

const ACCESS_PATH_RE = /^\/[a-zA-Z0-9._~/*-]*$/;

/** Returns an error message when `host[/path]` has a bad path, else undefined. Plain hosts pass. */
export function accessTargetError(target: string): string | undefined {
  const slash = target.indexOf('/');
  if (slash === -1) return undefined;
  if (slash === 0 || !ACCESS_PATH_RE.test(target.slice(slash))) {
    return `edge access path must match ${ACCESS_PATH_RE.source}`;
  }
  return undefined;
}

export class CloudflareAccessAdapter implements AccessPort {
  private readonly fetchFn: typeof fetch;
  private readonly accountId: string;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(params: {
    fetch: typeof fetch;
    accountId: string;
    token: string;
    baseUrl?: string;
  }) {
    this.fetchFn = params.fetch;
    this.accountId = params.accountId;
    this.token = params.token;
    this.baseUrl = params.baseUrl || 'https://api.cloudflare.com';
  }

  private getBaseUrl(): string {
    const urlPath = ACCESS_APPS_PATH_TEMPLATE.replace('{account_id}', encodeURIComponent(this.accountId));
    return `${this.baseUrl}${urlPath}`;
  }

  private getAppUrl(appId: string): string {
    return `${this.getBaseUrl()}/${encodeURIComponent(appId)}`;
  }

  private async listApps(): Promise<AccessApp[]> {
    const all: AccessApp[] = [];
    let page = 1;
    for (;;) {
      const { apps, totalPages } = await this.listPage(page);
      all.push(...apps);
      if (page >= totalPages) break;
      page += 1;
    }
    return all;
  }

  private async listPage(page: number): Promise<{ apps: AccessApp[]; totalPages: number }> {
    const url = `${this.getBaseUrl()}?page=${page}&per_page=${LIST_PAGE_SIZE}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw sanitizeError(err, this.token);
    }

    if (!res.ok) {
      throw new Error(`Failed to list Access apps: HTTP ${res.status} ${res.statusText}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error('Failed to parse Access apps list response: invalid JSON');
    }

    if (!json || typeof json !== 'object') {
      throw new Error('Invalid Access apps list response: expected JSON object');
    }

    const bodyObj = json as CloudflareAccessListResponse;
    if (!Array.isArray(bodyObj.result)) {
      throw new Error('Invalid Access apps list response: missing result array');
    }

    const totalPages = Number((bodyObj.result_info as { total_pages?: number } | undefined)?.total_pages ?? 1);
    const apps = bodyObj.result.map((app) => ({
      id: String(app.id),
      name: String(app.name),
      domain: String(app.domain),
      aud: typeof app.aud === 'string' ? app.aud : undefined,
      oauth_configuration: app.oauth_configuration,
      policies: Array.isArray(app.policies) ? (app.policies as AccessPolicy[]) : undefined,
    }));
    return { apps, totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1 };
  }

  async list(): Promise<AccessApp[]> {
    try {
      return await this.listApps();
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }

  async ensure(
    hostname: string,
    name: string,
    policy: AccessPolicy,
    opts: AccessEnsureOpts
  ): Promise<{ changed: boolean; appId?: string; aud?: string; diff?: string }> {
    const targetError = accessTargetError(hostname);
    if (targetError) throw new Error(targetError);
    try {
      const apps = await this.listApps();
      const existing = apps.find((a) => a.domain === hostname);
      const desiredPolicies = [policy];

      if (existing) {
        const samePolicies =
          (existing.policies ?? []).map(comparablePolicy).join('|') === desiredPolicies.map(comparablePolicy).join('|');
        const sameOauth = opts.oauth === undefined || JSON.stringify(existing.oauth_configuration ?? null) === JSON.stringify(opts.oauth);
        if (existing.name === name && samePolicies && sameOauth) {
          // Idempotent: nothing to change
          return { changed: false, appId: existing.id, aud: existing.aud, diff: '' };
        }

        const diff = `--- ${hostname} AccessApp ${JSON.stringify({ name: existing.name, policies: existing.policies ?? [] })}\n`
          + `+++ ${hostname} AccessApp ${JSON.stringify({ name, policies: desiredPolicies })}`;

        if (opts.dryRun) {
          return { changed: true, appId: existing.id, diff };
        }

        await this.updateApp(existing.id, hostname, name, desiredPolicies, opts.oauth);
        return { changed: true, appId: existing.id, aud: existing.aud, diff };
      }

      const diff = `+ ${hostname} AccessApp ${JSON.stringify({ name, policies: desiredPolicies })}`;

      if (opts.dryRun) {
        return { changed: true, diff };
      }

      const created = await this.createApp(hostname, name, desiredPolicies, opts.oauth);
      return { changed: true, appId: created.id, aud: created.aud, diff };
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }

  async remove(
    hostname: string,
    opts: AccessEnsureOpts
  ): Promise<{ changed: boolean; diff?: string }> {
    try {
      const apps = await this.listApps();
      const existing = apps.find((a) => a.domain === hostname);

      if (!existing) {
        return { changed: false, diff: '' };
      }

      const diff = `- ${hostname} AccessApp ${JSON.stringify({ name: existing.name, policies: existing.policies ?? [] })}`;

      if (opts.dryRun) {
        return { changed: true, diff };
      }

      await this.deleteApp(existing.id);
      return { changed: true, diff };
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }

  private async createApp(
    hostname: string,
    name: string,
    policies: AccessPolicy[],
    oauth?: unknown
  ): Promise<{ id?: string; aud?: string }> {
    const res = await this.fetchFn(this.getBaseUrl(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(appBody(hostname, name, policies, oauth)),
    });

    if (!res.ok) {
      throw new Error(`Failed to create Access app: HTTP ${res.status} ${res.statusText}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      // Fallback if no JSON response
    }

    const result = json && typeof json === 'object' ? (json as any).result : undefined;
    return {
      id: result?.id ? String(result.id) : undefined,
      aud: typeof result?.aud === 'string' ? result.aud : undefined,
    };
  }

  private async updateApp(appId: string, hostname: string, name: string, policies: AccessPolicy[], oauth?: unknown): Promise<void> {
    const res = await this.fetchFn(this.getAppUrl(appId), {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(appBody(hostname, name, policies, oauth)),
    });

    if (!res.ok) {
      throw new Error(`Failed to update Access app: HTTP ${res.status} ${res.statusText}`);
    }
  }

  private async deleteApp(appId: string): Promise<void> {
    const res = await this.fetchFn(this.getAppUrl(appId), {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to delete Access app: HTTP ${res.status} ${res.statusText}`);
    }
  }
}
