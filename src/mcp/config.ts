import type { McpServerConfig } from '../server/configStore.js';

/**
 * Resolve `${ENV}` placeholders in header values from the process environment.
 * Secrets therefore live in the environment, never in DvalinCode's config file
 * or audit trail. A missing variable resolves to an empty string (the request
 * will fail auth loudly rather than silently sending a literal `${VAR}`).
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  return out;
}

/** Servers that are explicitly enabled. Disabled/omitted servers are never connected. */
export function enabledServers(servers: McpServerConfig[] | undefined): McpServerConfig[] {
  return (servers ?? []).filter(s => s.enabled);
}
