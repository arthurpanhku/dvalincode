import { z } from 'zod';

export const remoteMcpServerConfigSchema = z
  .object({
    id: z.string().trim().min(1, 'MCP server id must not be empty'),
    url: z.url('MCP server url must be a valid URL'),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const localMcpServerConfigSchema = z
  .object({
    id: z.string().trim().min(1, 'MCP server id must not be empty'),
    command: z.string().trim().min(1, 'MCP server command must not be empty'),
    args: z.array(z.string()),
    enabled: z.boolean().optional(),
  })
  .strict();

export const mcpServerConfigSchema = z.union([
  remoteMcpServerConfigSchema,
  localMcpServerConfigSchema,
]);

export type RemoteMcpServerConfig = z.infer<typeof remoteMcpServerConfigSchema>;
export type LocalMcpServerConfig = z.infer<typeof localMcpServerConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/** Parse one remote or local MCP config entry at the configuration boundary. */
export function parseMcpServerConfig(input: unknown): McpServerConfig {
  return mcpServerConfigSchema.parse(input);
}

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
export function enabledServers(servers: McpServerConfig[] | undefined): RemoteMcpServerConfig[] {
  return (servers ?? []).filter(
    (server): server is RemoteMcpServerConfig => server.enabled === true && 'url' in server,
  );
}
