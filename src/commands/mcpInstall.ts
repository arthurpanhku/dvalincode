import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { UsageError } from '../core/exitCodes.js';
import {
  MCP_CLIENT_IDS,
  codexMcpAddArgs,
  mergeDvalinServer,
  renderConfig,
  resolveInstallTarget,
  type JsonMcpClient,
  type JsonMcpClientId,
  type McpClientId,
  type MergeOutcome,
} from '../mcp/install.js';

const execFileAsync = promisify(execFile);

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
    .option('--global', "write the user-level config instead of the project's (Codex is always user-level)")
    .option('--print', 'show the resulting config without writing anything')
    .option('--workspace <dir>', 'workspace the server is allowed to read', '.')
    .option('--name <name>', 'name for the server entry', 'dvalin')
    .action(async (client: string, options: Options) => {
      const id = parseClientId(client);
      if (id === 'codex') {
        await installCodex(options);
        return;
      }
      const plan = await planJsonInstall(id, {
        root: process.cwd(),
        global: Boolean(options.global),
        workspace: options.workspace,
        name: options.name,
      });

      if (options.print) {
        console.log(`# ${plan.file}`);
        console.log(plan.rendered.trimEnd());
        return;
      }

      if (plan.action === 'unchanged') {
        console.log(`${plan.client.name} already has '${options.name}' configured: ${plan.file}`);
      } else {
        await writeJsonInstall(plan);
        const verb = plan.action === 'added' ? 'Added' : 'Replaced';
        console.log(`${verb} '${options.name}' in ${plan.file}`);
      }

      if (plan.client.followUp) console.log(`\n${plan.client.followUp}`);
    });
}

export type JsonInstallPlan = {
  client: JsonMcpClient;
  file: string;
  action: MergeOutcome['action'];
  rendered: string;
};

/** What installing into a JSON-configured client would write, without writing it. */
export async function planJsonInstall(
  id: JsonMcpClientId,
  options: { root: string; global: boolean; workspace: string; name: string },
): Promise<JsonInstallPlan> {
  const target = resolveInstallTarget(id, options.root, options.global);
  const existing = await readJsonIfPresent(target.file);
  const { config, action } = mergeDvalinServer(existing, target.client, options.workspace, options.name);
  return { client: target.client, file: target.file, action, rendered: renderConfig(config) };
}

export async function writeJsonInstall(plan: JsonInstallPlan): Promise<void> {
  if (plan.action === 'unchanged') return;
  await mkdir(path.dirname(plan.file), { recursive: true });
  await writeFile(plan.file, plan.rendered, 'utf8');
}

export async function installCodex(options: Pick<Options, 'print' | 'workspace' | 'name'>): Promise<void> {
  const args = codexMcpAddArgs(options.workspace, options.name);
  const rendered = ['codex', ...args].map(shellWord).join(' ');

  if (options.print) {
    console.log('# ~/.codex/config.toml (managed by the Codex CLI)');
    console.log(rendered);
    return;
  }

  try {
    await execFileAsync('codex', args);
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    if (missing) {
      throw new UsageError(`Codex CLI was not found. Install Codex, or run this command manually:\n${rendered}`);
    }
    throw new UsageError(`Codex could not add the MCP server: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`Added or updated '${options.name}' in Codex's user-level MCP configuration.`);
  console.log('Verify it with: `codex mcp get ' + options.name + ' --json`');
  console.log('\nStart a new Codex session, then ask it to run `dvalin_scan` on your uncommitted changes.');
}

export function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
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
