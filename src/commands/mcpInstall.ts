import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { UsageError } from '../core/exitCodes.js';
import {
  MCP_CLIENT_IDS,
  mergeDvalinServer,
  renderConfig,
  resolveInstallTarget,
  type McpClientId,
} from '../mcp/install.js';

type Options = {
  global?: boolean;
  print?: boolean;
  workspace: string;
  name: string;
};

export function registerMcpInstallCommand(program: Command): void {
  program
    .command('mcp-install')
    .description(`Write the Dvalin MCP server into an editor's config: ${MCP_CLIENT_IDS.join(', ')}`)
    .argument('<client>', `editor to configure: ${MCP_CLIENT_IDS.join(', ')}`)
    .option('--global', "write the user-level config instead of the project's")
    .option('--print', 'show the resulting config without writing anything')
    .option('--workspace <dir>', 'workspace the server is allowed to read', '.')
    .option('--name <name>', 'name for the server entry', 'dvalin')
    .action(async (client: string, options: Options) => {
      const id = parseClientId(client);
      const root = process.cwd();
      const target = resolveInstallTarget(id, root, Boolean(options.global));

      const existing = await readJsonIfPresent(target.file);
      const { config, action } = mergeDvalinServer(existing, target.client, options.workspace, options.name);
      const rendered = renderConfig(config);

      if (options.print) {
        console.log(`# ${target.file}`);
        console.log(rendered.trimEnd());
        return;
      }

      if (action === 'unchanged') {
        console.log(`${target.client.name} already has '${options.name}' configured: ${target.file}`);
      } else {
        await mkdir(path.dirname(target.file), { recursive: true });
        await writeFile(target.file, rendered, 'utf8');
        const verb = action === 'added' ? 'Added' : 'Replaced';
        console.log(`${verb} '${options.name}' in ${target.file}`);
      }

      if (target.client.followUp) console.log(`\n${target.client.followUp}`);
    });
}

function parseClientId(value: string): McpClientId {
  if ((MCP_CLIENT_IDS as string[]).includes(value)) return value as McpClientId;
  throw new UsageError(`Unknown client '${value}'. Expected one of: ${MCP_CLIENT_IDS.join(', ')}.`);
}

/**
 * A malformed config is the user's file, not ours to silently replace — say so
 * and stop, rather than writing over whatever was there.
 */
async function readJsonIfPresent(file: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new UsageError(
      `${file} is not valid JSON, so it was left alone: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
