import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { RouteManager } from '../application/routeManager.ts';
import { FileRouteStore } from '../adapters/fileStore.ts';
import { TraefikFileRenderer } from '../adapters/traefikRenderer.ts';
import { DockerTargetResolver } from '../adapters/dockerTargetResolver.ts';
import { FileQuotaState } from '../adapters/fileQuotaState.ts';
import { deriveId, isValidId, validatePolicy, type Policy } from '../domain/routeSpec.ts';
import type { AccessPolicy, Clock } from '../domain/ports.ts';
import { CloudflareTunnelIngressAdapter } from '../adapters/cloudflareIngress.ts';
import { CloudflareDnsAdapter } from '../adapters/cloudflareDns.ts';
import { CloudflareAccessAdapter } from '../adapters/cloudflareAccess.ts';
import { accessTargetError } from '../adapters/cloudflareAccess.ts';
import { checkRoutes } from '../application/targetCheck.ts';
import { execFileSync } from 'node:child_process';
import { EDGEKIT_CONTRACT, EDGEKIT_FEATURES } from '../domain/contract.ts';
import { runEdgeAccess, runEdgeCa, runEdgeDns, runEdgeIngress } from './edgeCommands.ts';

class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean>; positionals: string[] } {
  let command = args[0] || '';
  let startIdx = 1;
  if (command === 'edge' && typeof args[1] === 'string' && !args[1].startsWith('--')) {
    command = `edge ${args[1]}`;
    startIdx = 2;
  }
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  let i = startIdx;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--no-strip') {
      flags['strip'] = false;
      i++;
    } else if (arg.startsWith('--')) {
      const flagName = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg !== undefined && !nextArg.startsWith('--')) {
        flags[flagName] = nextArg;
        i += 2;
      } else {
        flags[flagName] = true;
        i++;
      }
    } else {
      positionals.push(arg);
      i++;
    }
  }

  return { command, flags, positionals };
}

function parseBoolFlag(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return value !== 'false';
}

/**
 * The edge/* commands operate on Cloudflare account resources (tunnel ingress,
 * DNS, Access), not the local route store, so they bypass EDGEKIT_STATE_DIR /
 * EDGEKIT_DYNAMIC_DIR / EDGEKIT_POLICY and EDGEKIT_ENABLED entirely. The only
 * gate they respect is --apply; CF_API_TOKEN is read from the environment and
 * never echoed back on any path, including errors (adapters redact it).
 */
async function runEdgeCli(
  command: string,
  flags: Record<string, string | boolean>,
  positionals: string[]
): Promise<void> {
  const subcommand = command.slice('edge '.length);
  const hostname = positionals[0];
  const apply = flags['apply'] === true;

  if (!hostname) {
    process.stderr.write(`edge ${subcommand} requires a hostname\n`);
    process.exit(2);
  }

  if (!['ingress', 'dns', 'access', 'ca'].includes(subcommand)) {
    process.stderr.write(`Unknown edge subcommand: ${subcommand}\n`);
    process.exit(1);
  }

  const token = process.env.CF_API_TOKEN;
  if (!token) {
    process.stderr.write('CF_API_TOKEN environment variable is required\n');
    process.exit(1);
  }

  try {
    switch (subcommand) {
      case 'ingress': {
        const service = typeof flags['service'] === 'string' ? flags['service'] : undefined;
        if (!service) {
          process.stderr.write('edge ingress requires --service\n');
          process.exit(2);
        }
        const accountId = process.env.CF_ACCOUNT_ID;
        const tunnelId = process.env.CF_TUNNEL_ID;
        if (!accountId || !tunnelId) {
          process.stderr.write('CF_ACCOUNT_ID and CF_TUNNEL_ID environment variables are required\n');
          process.exit(1);
        }

        const adapter = new CloudflareTunnelIngressAdapter({ fetch, accountId, tunnelId, token });
        const result = await runEdgeIngress(adapter, hostname, service, apply);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exit(0);
        break;
      }

      case 'dns': {
        const target = typeof flags['target'] === 'string' ? flags['target'] : undefined;
        if (!target) {
          process.stderr.write('edge dns requires --target\n');
          process.exit(2);
        }
        const zoneId = process.env.CF_ZONE_ID;
        if (!zoneId) {
          process.stderr.write('CF_ZONE_ID environment variable is required\n');
          process.exit(1);
        }

        const proxied = parseBoolFlag(flags['proxied']);
        const ttl = typeof flags['ttl'] === 'string' ? Number(flags['ttl']) : undefined;

        const adapter = new CloudflareDnsAdapter({ fetch, zoneId, token });
        const result = await runEdgeDns(adapter, hostname, target, apply, { proxied, ttl });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exit(0);
        break;
      }

      case 'ca': {
        const accountId = process.env.CF_ACCOUNT_ID;
        if (!accountId) {
          process.stderr.write('CF_ACCOUNT_ID environment variable is required\n');
          process.exit(1);
        }
        const adapter = new CloudflareAccessAdapter({ fetch, accountId, token });
        const result = await runEdgeCa(adapter, hostname, apply);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exit(0);
        break;
      }

      case 'access': {
        const accessType = flags['type'];
        if (accessType !== undefined && accessType !== 'ssh') {
          process.stderr.write("edge access --type must be 'ssh' when set\n");
          process.exit(2);
        }
        const name = typeof flags['name'] === 'string' ? flags['name'] : undefined;
        const policyRaw = typeof flags['policy'] === 'string' ? flags['policy'] : undefined;
        if (!name || !policyRaw) {
          process.stderr.write('edge access requires --name and --policy\n');
          process.exit(2);
        }

        const targetError = accessTargetError(hostname);
        if (targetError) {
          process.stderr.write(`${targetError}\n`);
          process.exit(2);
        }

        let policy: AccessPolicy;
        try {
          policy = JSON.parse(policyRaw);
        } catch {
          process.stderr.write('edge access --policy must be valid JSON\n');
          process.exit(2);
        }
        if (typeof policy.decision !== 'string' || !Array.isArray(policy.include)) {
          process.stderr.write('edge access --policy must include a decision and an include array\n');
          process.exit(2);
        }

        const accountId = process.env.CF_ACCOUNT_ID;
        if (!accountId) {
          process.stderr.write('CF_ACCOUNT_ID environment variable is required\n');
          process.exit(1);
        }

        const adapter = new CloudflareAccessAdapter({ fetch, accountId, token });
        const result = await runEdgeAccess(adapter, hostname, name, policy, apply, flags['oauth'] === true ? MANAGED_OAUTH_AGENT : undefined, accessType === 'ssh' ? 'ssh' : undefined);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exit(0);
        break;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const { command, flags, positionals } = parseArgs(args);

  if (command === 'contract') {
    // Needs no env vars and works when disabled.
    let version = 'unknown';
    try {
      const root = path.resolve(import.meta.dirname, '../..');
      version = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
    } catch {
      version = 'unknown';
    }
    process.stdout.write(JSON.stringify({ contract: EDGEKIT_CONTRACT, version, features: EDGEKIT_FEATURES }) + '\n');
    process.exit(0);
  }

  if (command === 'policy-check') {
    // Needs no ENABLED flag and does not read the state dirs.
    const file = typeof flags['file'] === 'string' ? flags['file'] : process.env.EDGEKIT_POLICY;
    if (!file) {
      process.stderr.write('policy-check needs --file or EDGEKIT_POLICY\n');
      process.exit(2);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err: unknown) {
      process.stderr.write(`cannot read policy: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    const errors = validatePolicy(parsed);
    if (errors.length > 0) {
      process.stderr.write(errors.join('\n') + '\n');
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    process.exit(0);
  }

  if (command.startsWith('edge ')) {
    await runEdgeCli(command, flags, positionals);
    return;
  }

  const stateDir = process.env.EDGEKIT_STATE_DIR;
  const dynamicDir = process.env.EDGEKIT_DYNAMIC_DIR;
  const policyFile = process.env.EDGEKIT_POLICY;
  const enabledFlag = process.env.EDGEKIT_ENABLED ?? '0';

  if (!stateDir || !dynamicDir || !policyFile) {
    process.stderr.write('Missing required environment variable(s)\n');
    process.exit(1);
  }

  // When EDGEKIT_ENABLED is not '1', register/unregister/reconcile print 'edgekit disabled' to stderr and exit 3; list still works.
  const isMutatingCommand = ['register', 'unregister', 'unregister-owner', 'reconcile'].includes(command);
  if (isMutatingCommand && enabledFlag !== '1') {
    process.stderr.write('edgekit disabled\n');
    process.exit(3);
  }

  // Load Policy
  let policy: Policy;
  try {
    const rawPolicy = await fs.readFile(policyFile, 'utf8');
    policy = JSON.parse(rawPolicy);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to load policy: ${msg}\n`);
    process.exit(1);
  }

  if (command === 'check') {
    if (process.env.EDGEKIT_TARGET_PROBE !== '1') {
      process.stdout.write('check disabled (EDGEKIT_TARGET_PROBE not set)\n');
      process.exit(0);
    }
    // Report only: reads the store, never writes or removes anything.
    try {
      const routes = await new FileRouteStore(stateDir).list();
      const resolver = new DockerTargetResolver({ network: process.env.EDGEKIT_NETWORK || 'edgekit-net' });
      const results = await checkRoutes(routes, fetch, {
        resolveHost: async (host) => (await resolver.resolve(host)).map((t) => t.ip),
      });
      if (flags['json'] === true) {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      } else {
        for (const r of results) {
          process.stdout.write(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id} ${r.target}${r.reason ? ` ${r.reason}` : ''}\n`);
        }
      }
      process.exit(results.some((r) => !r.ok) ? 1 : 0);
    } catch (err: unknown) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  const store = new FileRouteStore(stateDir);
  const renderer = new TraefikFileRenderer(dynamicDir);
  const quota = new FileQuotaState(stateDir);
  const clock = new RealClock();

  const manager = new RouteManager({
    store,
    renderer,
    quota,
    clock,
    policy,
    aliasTargets: process.env.EDGEKIT_ALIAS_TARGETS === '1',
    resolver: new DockerTargetResolver({ network: process.env.EDGEKIT_NETWORK || 'edgekit-net' }),
  });

  try {
    switch (command) {
      case 'register': {
        const isSite = flags['site'] === true;
        const owner = typeof flags['owner'] === 'string' ? flags['owner'] : undefined;
        const name = typeof flags['name'] === 'string' ? flags['name'] : undefined;
        const host = typeof flags['host'] === 'string' ? flags['host'] : undefined;
        const target = typeof flags['target'] === 'string' ? flags['target'] : undefined;
        const access = typeof flags['access'] === 'string' ? flags['access'] : undefined;
        const pathPrefixFlag = typeof flags['path-prefix'] === 'string' ? flags['path-prefix'] : undefined;
        const redirectExactFrom = typeof flags['redirect-exact-from'] === 'string' ? flags['redirect-exact-from'] : undefined;
        const redirectTo = typeof flags['redirect-to'] === 'string' ? flags['redirect-to'] : undefined;

        // Simplest option: strip prefix defaults to false for site routes (--strip to enable),
        // and true for /p routes (--no-strip to disable).
        const stripPrefix = isSite ? flags['strip'] === true : flags['strip'] !== false;

        if (!owner || !name || !host || !target) {
          process.stderr.write('register requires --owner, --name, --host, and --target\n');
          process.exit(2);
        }

        if (isSite && !pathPrefixFlag) {
          process.stderr.write('register --site requires --path-prefix\n');
          process.exit(2);
        }

        if (redirectExactFrom !== undefined && redirectTo === undefined) {
          process.stderr.write('register --redirect-exact-from requires --redirect-to\n');
          process.exit(2);
        }
        if (redirectTo !== undefined && redirectExactFrom === undefined) {
          process.stderr.write('register --redirect-to requires --redirect-exact-from\n');
          process.exit(2);
        }

        const id = deriveId(owner, name);
        const specInput: Record<string, unknown> = {
          id,
          owner,
          host,
          target,
          stripPrefix,
        };
        if (isSite) {
          specInput.kind = 'site';
          specInput.pathPrefix = pathPrefixFlag;
          if (redirectExactFrom !== undefined) {
            specInput.redirectExactFrom = redirectExactFrom;
          }
          if (redirectTo !== undefined) {
            specInput.redirectTo = redirectTo;
          }
        } else if (pathPrefixFlag !== undefined) {
          specInput.pathPrefix = pathPrefixFlag;
        }

        if (access !== undefined) {
          specInput.access = access;
        }

        const result = await manager.register(specInput);
        process.stdout.write(JSON.stringify(result.spec, null, 2) + '\n');
        process.exit(0);
        break;
      }

      case 'unregister': {
        const id = positionals[0] || (typeof flags['id'] === 'string' ? flags['id'] : undefined);
        if (!id) {
          process.stderr.write('unregister requires an id\n');
          process.exit(2);
        }
        if (!isValidId(id)) {
          process.stderr.write(`Validation failed: invalid id '${id}'\n`);
          process.exit(2);
        }
        await manager.unregister(id);
        process.exit(0);
        break;
      }

      case 'unregister-owner': {
        const owner = positionals[0] || (typeof flags['owner'] === 'string' ? flags['owner'] : undefined);
        if (!owner || !/^[a-z0-9]+$/.test(owner)) {
          process.stderr.write('unregister-owner requires a valid owner\n');
          process.exit(2);
        }
        const removed = await manager.unregisterOwner(owner);
        process.stdout.write(JSON.stringify({ removed }, null, 2) + '\n');
        process.exit(0);
        break;
      }

      case 'list': {
        const all = await manager.list();
        const ownerFilter = typeof flags['owner'] === 'string' ? flags['owner'] : undefined;
        const routes = ownerFilter === undefined ? all : all.filter((r) => r.owner === ownerFilter);
        process.stdout.write(JSON.stringify(routes, null, 2) + '\n');
        process.exit(0);
        break;
      }

      case 'reconcile': {
        const res = await manager.reconcile();
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        process.exit(0);
        break;
      }

      default: {
        process.stderr.write(`Unknown command: ${command}\n`);
        process.exit(1);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.startsWith('Validation failed:') ||
      msg.startsWith('Max routes per owner exceeded') ||
      msg.startsWith('Registration rate limit exceeded')
    ) {
      process.stderr.write(`${msg}\n`);
      process.exit(2);
    }

    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
