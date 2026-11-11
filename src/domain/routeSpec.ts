export type RouteKind = 'prefix' | 'site';

export type RouteSpec = {
  id: string;
  owner: string;
  host: string;
  pathPrefix: string;
  target: string;
  access: 'private' | 'public';
  stripPrefix: boolean;
  kind?: RouteKind;
  redirectExactFrom?: string;
  redirectTo?: string;
};

export type Policy = {
  reservedOwners?: string[];
  allowedHosts: string[];
  siteHosts?: string[];
  ownerCidrs: Record<string, string[]>;
  denyIps?: string[];
  publicOwners?: string[];
  ownerTargets?: Record<string, string[]>;
  maxRoutesPerOwner?: number;
  ownerLimits?: Record<string, { maxRoutes?: number }>;
};

export type ValidateOptions = { aliasTargets?: boolean };

const KIT_SERVICE_NAMES = ['traefik', 'cloudflared', 'access-verifier', 'edgekit-notfound'];
const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isKitReservedName(name: string): boolean {
  return KIT_SERVICE_NAMES.includes(name) || name.startsWith('edgekit-') || /^edgekit.*-1$/.test(name);
}

export function deriveId(owner: string, name: string): string {
  return `${owner}--${name}`;
}

const DEFAULT_RESERVED_OWNERS = ['foundry*', 'apps', 'admin', 'api', 'control', 'connect'];
const DEFAULT_DENY_IPS = ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8'];

const OWNER_REGEX = /^[a-z0-9]+$/;
const NAME_REGEX = /^(?!.*--)[a-z0-9][a-z0-9-]{0,38}$/;
const HOST_REGEX = /^[a-z0-9.-]+$/;

export function isValidId(id: string): boolean {
  if (typeof id !== 'string') {
    return false;
  }
  const parts = id.split('--');
  if (parts.length !== 2) {
    return false;
  }
  const [owner, name] = parts;
  return OWNER_REGEX.test(owner) && NAME_REGEX.test(name);
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === pattern;
}

function parseIpv4(ipStr: string): number | null {
  const parts = ipStr.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d+$/.test(part)) {
      return null;
    }
    if (part.length > 1 && part.startsWith('0')) {
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return null;
    }
    num = (num << 8) | n;
  }
  return num >>> 0;
}

function parseCidr(cidr: string): { network: number; mask: number } | null {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) {
    const ip = parseIpv4(cidr);
    if (ip === null) return null;
    return { network: ip, mask: 0xffffffff };
  }
  const ipPart = cidr.slice(0, slashIdx);
  const prefixPart = cidr.slice(slashIdx + 1);
  if (!/^\d+$/.test(prefixPart)) {
    return null;
  }
  const prefixLen = Number(prefixPart);
  if (prefixLen < 0 || prefixLen > 32) {
    return null;
  }
  const ip = parseIpv4(ipPart);
  if (ip === null) {
    return null;
  }
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return { network: (ip & mask) >>> 0, mask };
}

function ipMatchesCidr(ipNum: number, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  return (ipNum & parsed.mask) >>> 0 === parsed.network;
}

const SITE_PATH_PREFIX_REGEX = /^\/[a-zA-Z0-9._~/-]*$/;

function normalizePathPrefix(p: string): string {
  if (p === '/') return '/';
  return p.replace(/\/+$/, '');
}

export function validateRouteSpec(
  input: unknown,
  policy: Policy,
  existingRoutes?: RouteSpec[],
  options: ValidateOptions = {}
): { ok: true; spec: RouteSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['Input must be a non-null object'] };
  }

  const raw = input as Record<string, unknown>;

  // Check required raw fields
  if (typeof raw.owner !== 'string') {
    errors.push('owner is required and must be a string');
  }
  if (typeof raw.id !== 'string') {
    errors.push('id is required and must be a string');
  }
  if (typeof raw.host !== 'string') {
    errors.push('host is required and must be a string');
  }
  if (typeof raw.target !== 'string') {
    errors.push('target is required and must be a string');
  }

  // Kind determination: kind === 'site' or raw.site === true
  const isSite = raw.kind === 'site' || raw.site === true;
  const kind: RouteKind = isSite ? 'site' : 'prefix';

  const reservedOwners = Array.from(
    new Set([...DEFAULT_RESERVED_OWNERS, ...(policy.reservedOwners ?? [])])
  );
  const denyIps = policy.denyIps ?? DEFAULT_DENY_IPS;
  const publicOwners = policy.publicOwners ?? [];

  const owner = typeof raw.owner === 'string' ? raw.owner : '';
  const id = typeof raw.id === 'string' ? raw.id : '';
  const host = typeof raw.host === 'string' ? raw.host : '';
  const target = typeof raw.target === 'string' ? raw.target : '';

  // Rule 1: owner matches ^[a-z0-9]+$ (no '-')
  let ownerValid = false;
  if (typeof raw.owner === 'string') {
    if (!OWNER_REGEX.test(owner)) {
      errors.push('owner must match ^[a-z0-9]+$');
    } else {
      ownerValid = true;
    }
  }

  // Name checking and id = `${owner}--${name}`
  let derivedExpectedId: string | null = null;
  if (typeof raw.id === 'string') {
    if (ownerValid) {
      const prefix = `${owner}--`;
      if (!id.startsWith(prefix)) {
        errors.push(`id must equal \${owner}--\${name}`);
      } else {
        const name = id.slice(prefix.length);
        if (!NAME_REGEX.test(name)) {
          errors.push('name must match ^[a-z0-9][a-z0-9-]{0,38}$');
        } else {
          derivedExpectedId = deriveId(owner, name);
        }
      }
    } else {
      // Owner is invalid or missing
      if (typeof raw.owner === 'string') {
        const doubleDashIdx = id.indexOf('--');
        if (doubleDashIdx > 0) {
          const namePart = id.slice(doubleDashIdx + 2);
          if (!NAME_REGEX.test(namePart)) {
            errors.push('name must match ^[a-z0-9][a-z0-9-]{0,38}$');
          }
        }
      }
    }
  }

  // Rule 3: owner or id matching a reserved pattern is rejected
  if (typeof raw.owner === 'string') {
    for (const pat of reservedOwners) {
      if (matchesPattern(owner, pat)) {
        errors.push(`owner matches reserved pattern '${pat}'`);
        break;
      }
    }
  }

  if (typeof raw.id === 'string') {
    for (const pat of reservedOwners) {
      if (matchesPattern(id, pat)) {
        errors.push(`id matches reserved pattern '${pat}'`);
        break;
      }
    }
  }

  // Path prefix validation
  let pathPrefix = '';
  const expectedPathPrefix = typeof raw.id === 'string' ? `/p/${id}/` : '';
  if (isSite) {
    if (typeof raw.pathPrefix !== 'string') {
      errors.push('pathPrefix is required for site routes and must be a string');
    } else if (!SITE_PATH_PREFIX_REGEX.test(raw.pathPrefix)) {
      errors.push('pathPrefix must start with / and match ^/[a-zA-Z0-9._~/-]*$');
    } else if (raw.pathPrefix === '/p' || raw.pathPrefix.startsWith('/p/')) {
      errors.push("pathPrefix '/p' and anything under it is refused");
    } else {
      pathPrefix = raw.pathPrefix;
    }
  } else {
    // Rule 2: pathPrefix is DERIVED as /p/<id>/ ; a caller-supplied pathPrefix that differs is an error
    if ('pathPrefix' in raw && raw.pathPrefix !== undefined) {
      if (typeof raw.pathPrefix !== 'string' || raw.pathPrefix !== expectedPathPrefix) {
        errors.push(`pathPrefix must be '${expectedPathPrefix}'`);
      }
    }
    pathPrefix = expectedPathPrefix;
  }

  // Collision check: two site routes on the same host and prefix are refused
  if (isSite && pathPrefix && existingRoutes && ownerValid) {
    const norm = normalizePathPrefix(pathPrefix);
    const collision = existingRoutes.find(
      (r) =>
        r.id !== id &&
        r.host === host &&
        (r.kind === 'site' || r.kind === undefined) &&
        normalizePathPrefix(r.pathPrefix) === norm
    );
    if (collision) {
      errors.push(
        `route collision: site route on host '${host}' and pathPrefix '${pathPrefix}' already exists (id: '${collision.id}')`
      );
    }
  }

  // Rule 4: host must match ^[a-z0-9.-]+$ AND (for site: policy.siteHosts; for /p: policy.allowedHosts)
  if (typeof raw.host === 'string') {
    if (!HOST_REGEX.test(host)) {
      errors.push('host must match ^[a-z0-9.-]+$');
    }
    if (isSite) {
      const siteHosts = policy.siteHosts ?? [];
      if (!siteHosts.includes(host)) {
        errors.push(`host '${host}' is not in policy.siteHosts`);
      }
    } else {
      if (!policy.allowedHosts.includes(host)) {
        errors.push(`host '${host}' is not in policy.allowedHosts`);
      }
    }
  }

  // Redirect options
  let redirectExactFrom: string | undefined;
  let redirectTo: string | undefined;

  if (isSite) {
    const hasFrom = 'redirectExactFrom' in raw && raw.redirectExactFrom !== undefined;
    const hasTo = 'redirectTo' in raw && raw.redirectTo !== undefined;

    if (hasFrom || hasTo) {
      if (!hasFrom || typeof raw.redirectExactFrom !== 'string' || !raw.redirectExactFrom.startsWith('/')) {
        errors.push('redirectExactFrom must be a string starting with /');
      } else {
        redirectExactFrom = raw.redirectExactFrom;
      }

      if (
        !hasTo ||
        typeof raw.redirectTo !== 'string' ||
        !raw.redirectTo.startsWith('/') ||
        /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.redirectTo)
      ) {
        errors.push('redirectTo must be a relative path starting with /');
      } else {
        redirectTo = raw.redirectTo;
      }

      if (hasFrom && !hasTo) {
        errors.push('redirectExactFrom requires redirectTo');
      }
      if (hasTo && !hasFrom) {
        errors.push('redirectTo requires redirectExactFrom');
      }
    }
  } else {
    if (raw.redirectExactFrom !== undefined || raw.redirectTo !== undefined) {
      errors.push('redirect options are only supported for site routes');
    }
  }

  // Rule 5: target must be an http://<IPv4 literal>:<port> URL
  let parsedTargetIp: number | null = null;
  if (typeof raw.target === 'string') {
    const targetMatch = target.match(/^http:\/\/([^:/]+):(\d+)$/);
    if (!targetMatch) {
      errors.push(
        options.aliasTargets
          ? 'target must be an http://<IPv4 literal or alias>:<port> URL'
          : 'target must be an http://<IPv4 literal>:<port> URL'
      );
    } else {
      const hostPart = targetMatch[1];
      const portPart = Number(targetMatch[2]);
      if (portPart < 1 || portPart > 65535) {
        errors.push('target port must be between 1 and 65535');
      }
      const ip = parseIpv4(hostPart);
      if (ip === null && options.aliasTargets && ALIAS_RE.test(hostPart)) {
        if (isKitReservedName(hostPart)) {
          errors.push(`target alias '${hostPart}' is a reserved kit name`);
        } else if (!ownerValid || !(policy.ownerTargets?.[owner] ?? []).includes(hostPart)) {
          errors.push(`target alias '${hostPart}' is not in ownerTargets for owner '${owner}'`);
        }
      } else if (ip === null) {
        errors.push('target host must be a valid IPv4 literal');
      } else {
        parsedTargetIp = ip;
        // Check denyIps
        for (const denyCidr of denyIps) {
          if (ipMatchesCidr(ip, denyCidr)) {
            errors.push(`target IP is in denied range '${denyCidr}'`);
            break;
          }
        }

        // Check owner CIDRs
        if (ownerValid) {
          const allowedCidrs = policy.ownerCidrs[owner];
          if (!allowedCidrs || allowedCidrs.length === 0) {
            errors.push(`no allowed CIDRs defined for owner '${owner}'`);
          } else {
            const inAllowedCidr = allowedCidrs.some(cidr => ipMatchesCidr(ip, cidr));
            if (!inAllowedCidr) {
              errors.push(`target IP is outside allowed CIDRs for owner '${owner}'`);
            }
          }
        }
      }
    }
  }

  // Access check
  let access: 'private' | 'public' = 'private';
  if ('access' in raw && raw.access !== undefined) {
    if (raw.access !== 'private' && raw.access !== 'public') {
      errors.push("access must be 'private' or 'public'");
    } else {
      access = raw.access;
      if (access === 'public' && ownerValid && !publicOwners.includes(owner)) {
        errors.push(`owner '${owner}' is not allowed to register public routes`);
      }
    }
  }

  // stripPrefix: defaults to false for site routes (--strip to enable), true for /p routes
  let stripPrefix = isSite ? false : true;
  if ('stripPrefix' in raw && raw.stripPrefix !== undefined) {
    if (typeof raw.stripPrefix !== 'boolean') {
      errors.push('stripPrefix must be a boolean');
    } else {
      stripPrefix = raw.stripPrefix;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const spec: RouteSpec = {
    id,
    owner,
    host,
    pathPrefix,
    target,
    access,
    stripPrefix,
    kind,
  };
  if (redirectExactFrom !== undefined) {
    spec.redirectExactFrom = redirectExactFrom;
  }
  if (redirectTo !== undefined) {
    spec.redirectTo = redirectTo;
  }

  return { ok: true, spec };
}
