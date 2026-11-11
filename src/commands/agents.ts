import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { EXIT, UsageError } from '../core/exitCodes.js';
import { AGENT_IDS, agentName, detectAgents, type AgentId, type DetectedAgent } from '../mcp/agents.js';
import { CC_SWITCH_APPS, ccSwitchImportLink, codexMcpAddArgs } from '../mcp/install.js';
import { installCodex, planJsonInstall, shellWord, writeJsonInstall } from './mcpInstall.js';

const execFileAsync = promisify(execFile);

type ConnectOptions = {
  yes?: boolean;
  global?: boolean;
  workspace: string;
  name: string;
};

type Step = {
  id: AgentId;
  /** What connecting would do, in one line. */
  summary: string;
  /** Lines shown under the summary, such as a full link. */
  details?: string[];
  /** Absent when there is nothing to do. Returns the lines to print. */
  apply?: () => Promise<string[]>;
};

export function registerAgentsCommand(program: Command): void {
  const agents = program
    .command('agents')
    .description('Find the coding agents on this machine and connect Dvalin to them');

  agents
    .command('list', { isDefault: true })
    .description('Show the coding agents found here and where Dvalin is connected')
    .option('--json', 'print the result as JSON')
    .option('--name <name>', 'server entry name to look for', 'dvalin')
    .action(async (options: { json?: boolean; name: string }) => {
      const root = process.cwd();
      const found = await detectAgents({ root, serverName: options.name });
      if (options.json) {
        console.log(JSON.stringify(found, null, 2));
        return;
      }
      printAgents(found, root);
    });

  agents
    .command('connect')
    .description('Plan connecting Dvalin to the agents found here; apply it only with --yes')
    .argument('[agents...]', `agents to connect (default: every one found without Dvalin): ${AGENT_IDS.join(', ')}`)
    .option('--yes', 'apply the plan')
    .option('--global', "use each agent's user-level config instead of the project's (Codex and CC Switch are always user-level)")
    .option('--workspace <dir>', 'workspace the server is allowed to read', '.')
    .option('--name <name>', 'name for the server entry', 'dvalin')
    .action(async (requested: string[], options: ConnectOptions) => {
      const root = process.cwd();
      const found = await detectAgents({ root, serverName: options.name });
      const ids = selectAgents(found, requested);

      if (ids.length === 0) {
        const installed = found.filter(agent => agent.installed && agent.id !== 'cc-switch');
        console.log(installed.length
          ? 'Dvalin is already connected to every agent found here. `dvalin agents` shows where.'
          : `No supported coding agent was found on this machine. Name one to configure it anyway: dvalin agents connect <${AGENT_IDS.join('|')}>`);
        printCcSwitchHint(found, ids);
        return;
      }

      const steps: Step[] = [];
      for (const id of ids) steps.push(await planStep(id, found, options, root));

      console.log(options.yes ? 'Connecting Dvalin:' : 'Plan (nothing is written yet):');
      for (const step of steps) {
        const agent = found.find(candidate => candidate.id === step.id);
        const missing = agent?.installed ? '' : '  (not found on this machine)';
        console.log(`  ${agentName(step.id).padEnd(12)} ${step.summary}${missing}`);
        for (const line of step.details ?? []) console.log(`  ${''.padEnd(12)} ${line}`);
      }

      if (!options.yes) {
        console.log('\nReview it, then rerun with --yes to apply it.');
        printCcSwitchHint(found, ids);
        return;
      }

      let failed = 0;
      for (const step of steps) {
        if (!step.apply) continue;
        console.log('');
        try {
          for (const line of await step.apply()) console.log(line);
        } catch (error) {
          failed += 1;
          console.error(`✗ ${agentName(step.id)}: ${message(error)}`);
        }
      }
      printCcSwitchHint(found, ids);
      if (failed) process.exitCode = EXIT.runtimeError;
    });
}

/**
 * The agents a `connect` covers: the ones named, or else every installed agent
 * that has no Dvalin entry anywhere yet. CC Switch is only ever connected by
 * name, because connecting it opens a dialog in another application.
 */
export function selectAgents(found: DetectedAgent[], requested: string[]): AgentId[] {
  if (requested.length) return [...new Set(requested.map(parseAgentId))];
  return found
    .filter(agent => agent.installed && agent.id !== 'cc-switch' && agent.configured.length === 0)
    .map(agent => agent.id);
}

/** The installed agents CC Switch can sync an MCP server into. */
export function ccSwitchTargets(found: DetectedAgent[]): DetectedAgent[] {
  return found.filter(agent => agent.installed && ccSwitchApp(agent.id) !== undefined);
}

function ccSwitchApp(id: AgentId): string | undefined {
  return id === 'cc-switch' ? undefined : CC_SWITCH_APPS[id];
}

async function planStep(id: AgentId, found: DetectedAgent[], options: ConnectOptions, root: string): Promise<Step> {
  if (id === 'cc-switch') return planCcSwitch(found, options);

  if (id === 'codex') {
    const command = ['codex', ...codexMcpAddArgs(options.workspace, options.name)].map(shellWord).join(' ');
    return {
      id,
      summary: `run ${command}  (Codex's own config writer; user-level)`,
      apply: async () => {
        await installCodex({ workspace: options.workspace, name: options.name });
        return [];
      },
    };
  }

  try {
    const plan = await planJsonInstall(id, {
      root,
      global: Boolean(options.global),
      workspace: options.workspace,
      name: options.name,
    });
    const file = displayPath(plan.file, root);
    if (plan.action === 'unchanged') return { id, summary: `already connected: ${file}` };
    return {
      id,
      summary: plan.action === 'added' ? `add '${options.name}' to ${file}` : `replace '${options.name}' in ${file}`,
      apply: async () => {
        await writeJsonInstall(plan);
        const verb = plan.action === 'added' ? 'Added' : 'Replaced';
        return [`${verb} '${options.name}' in ${plan.file}`, ...(plan.client.followUp ? [plan.client.followUp] : [])];
      },
    };
  } catch (error) {
    return { id, summary: `skipped: ${message(error)}` };
  }
}

function planCcSwitch(found: DetectedAgent[], options: ConnectOptions): Step {
  const targets = ccSwitchTargets(found);
  if (targets.length === 0) {
    return {
      id: 'cc-switch',
      summary: 'skipped: none of the agents CC Switch syncs MCP into (Claude Code, Codex, Gemini CLI, OpenCode) was found',
    };
  }
  const apps = targets.map(agent => ccSwitchApp(agent.id)!);
  const link = ccSwitchImportLink(apps, options.workspace, options.name);
  return {
    id: 'cc-switch',
    summary: `open CC Switch's import dialog for ${targets.map(agent => agent.name).join(', ')}; CC Switch asks before it writes anything`,
    details: [link],
    apply: async () => {
      try {
        await openUrl(link);
      } catch (error) {
        throw new Error(`could not open the link (${message(error)}). Open it yourself, with the CC Switch desktop app installed:\n${link}`);
      }
      return ['Opened CC Switch. Confirm the import there; it then writes Dvalin into each app it listed.'];
    },
  };
}

function printAgents(found: DetectedAgent[], root: string): void {
  console.log('Coding agents on this machine');
  for (const agent of found) {
    console.log(`  ${agent.installed ? '✓' : '·'} ${agent.name.padEnd(12)} ${agent.installed ? agent.evidence.join(', ') : 'not found'}`);
    if (agent.id === 'cc-switch') {
      if (agent.installed) console.log('      can sync Dvalin into the agents it manages: dvalin agents connect cc-switch');
      continue;
    }
    if (agent.configured.length) {
      console.log(`      Dvalin: ${agent.configured.map(entry => `${entry.scope} ${displayPath(entry.file, root)}`).join(', ')}`);
    } else if (agent.installed) {
      console.log('      Dvalin: not connected');
    }
    if (agent.unreadable.length) {
      console.log(`      could not read: ${agent.unreadable.map(file => displayPath(file, root)).join(', ')}`);
    }
  }

  const pending = selectAgents(found, []);
  console.log('');
  console.log(pending.length
    ? `Next: \`dvalin agents connect\` plans Dvalin for ${pending.map(agentName).join(', ')}.`
    : 'Nothing to connect: every agent found here already has Dvalin.');
}

function printCcSwitchHint(found: DetectedAgent[], ids: AgentId[]): void {
  const ccSwitch = found.find(agent => agent.id === 'cc-switch');
  if (!ccSwitch?.installed || ids.includes('cc-switch')) return;
  console.log('CC Switch is installed. To manage Dvalin from CC Switch instead, run `dvalin agents connect cc-switch`.');
}

function parseAgentId(value: string): AgentId {
  if ((AGENT_IDS as string[]).includes(value)) return value as AgentId;
  throw new UsageError(`Unknown agent '${value}'. Expected one of: ${AGENT_IDS.join(', ')}.`);
}

/** Relative to the project when inside it, `~/...` when under home, absolute otherwise. */
function displayPath(file: string, root: string): string {
  for (const [base, prefix] of [[root, ''], [homedir(), '~/']] as const) {
    const relative = path.relative(base, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return `${prefix}${relative.split(path.sep).join('/')}`;
    }
  }
  return file;
}

async function openUrl(url: string): Promise<void> {
  if (process.platform === 'darwin') await execFileAsync('open', [url]);
  // Not `cmd /c start`: cmd would split the link at its `&`s.
  else if (process.platform === 'win32') await execFileAsync('rundll32', ['url.dll,FileProtocolHandler', url]);
  else await execFileAsync('xdg-open', [url]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
