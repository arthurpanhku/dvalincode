import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { EXIT, UsageError } from '../core/exitCodes.js';
import {
  CLAUDE_SKILL_SOURCE,
  CODEX_PLUGIN,
  SKILL_NAME,
  bundledClaudeSkill,
  claudeSkillFile,
  codexHasMarketplace,
  codexMarketplaceAddArgs,
  codexPluginAddArgs,
  codexSkillPlugin,
} from '../mcp/agentSkills.js';
import { AGENT_IDS, agentName, detectAgents, type AgentId, type DetectedAgent, type DvalinLocation } from '../mcp/agents.js';
import { CC_SWITCH_APPS, ccSwitchImportLink, codexMcpAddArgs } from '../mcp/install.js';
import { VERSION } from '../version.js';
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
    .description('Plan connecting Dvalin, plus its skill for Claude Code and Codex, to the agents found here; apply it only with --yes')
    .argument('[agents...]', `agents to connect (default: every one found without Dvalin or its skill): ${AGENT_IDS.join(', ')}`)
    .option('--yes', 'apply the plan')
    .option('--global', "use each agent's user-level config and skills folder instead of the project's (Codex and CC Switch are always user-level)")
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

      const shipped = await bundledClaudeSkill();
      // An agent picked by default may lack only one of the two; the other stays where it is.
      const picked = requested.length === 0;
      const steps: Step[] = [];
      for (const id of ids) {
        const agent = found.find(candidate => candidate.id === id);
        steps.push(picked && agent?.configured.length
          ? { id, summary: `already connected: ${locations(agent.configured, root)}` }
          : await planStep(id, found, options, root));
        if (agent?.skill) {
          steps.push(picked && agent.skill.length
            ? { id, summary: `skill ${SKILL_NAME}: already installed: ${locations(agent.skill, root)}` }
            : await planSkillStep(id, { root, global: Boolean(options.global), shipped }));
        }
      }

      console.log(options.yes ? 'Connecting Dvalin:' : 'Plan (nothing is written yet):');
      let previous: AgentId | undefined;
      for (const step of steps) {
        // An agent's skill goes on the line under its server.
        const first = step.id !== previous;
        const agent = found.find(candidate => candidate.id === step.id);
        const missing = !first || agent?.installed ? '' : '  (not found on this machine)';
        console.log(`  ${(first ? agentName(step.id) : '').padEnd(12)} ${step.summary}${missing}`);
        for (const line of step.details ?? []) console.log(`  ${''.padEnd(12)} ${line}`);
        previous = step.id;
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
 * that has no Dvalin entry anywhere yet or, where it gets one, no Dvalin skill.
 * CC Switch is only ever connected by name, because connecting it opens a
 * dialog in another application.
 */
export function selectAgents(found: DetectedAgent[], requested: string[]): AgentId[] {
  if (requested.length) return [...new Set(requested.map(parseAgentId))];
  return found
    .filter(agent => agent.installed && agent.id !== 'cc-switch' && (agent.configured.length === 0 || agent.skill?.length === 0))
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

type SkillPlanOptions = {
  root: string;
  /** Defaults to the user's home folder. */
  home?: string;
  global: boolean;
  /** The standalone Claude Code skill this build ships, if it ships one. */
  shipped: string | undefined;
};

/** Installing the Dvalin skill into an agent that gets one: Claude Code or Codex. */
export async function planSkillStep(id: AgentId, options: SkillPlanOptions): Promise<Step> {
  const home = options.home ?? homedir();
  return id === 'codex'
    ? planCodexSkill(home)
    : planClaudeSkill(claudeSkillFile(options.global ? home : options.root), options.root, options.shipped);
}

async function planClaudeSkill(file: string, root: string, shipped: string | undefined): Promise<Step> {
  const id = 'claude-code';
  const label = `skill ${SKILL_NAME}`;
  if (shipped === undefined) {
    return { id, summary: `${label}: skipped: this build carries no copy of it; \`npx dvalincode agents connect claude-code --yes\` installs it` };
  }

  const shown = displayPath(file, root);
  const existing = await currentText(file);
  if (existing !== undefined) {
    if (sameText(existing, shipped)) return { id, summary: `${label}: already installed: ${shown}` };
    return {
      id,
      summary: `${label}: skipped: ${shown} already exists and differs from this version's; left as is`,
      details: [`  To replace it, delete it and rerun. This version's skill: https://github.com/arthurpanhku/dvalincode/blob/v${VERSION}/${CLAUDE_SKILL_SOURCE}`],
    };
  }

  return {
    id,
    summary: `${label}: write ${shown} (the standalone Claude Code skill)`,
    apply: async () => {
      await mkdir(path.dirname(file), { recursive: true });
      // `wx`: a file that appeared there since the plan fails the write instead of being replaced.
      await writeFile(file, shipped, { encoding: 'utf8', flag: 'wx' });
      return [`Added skill ${SKILL_NAME}: ${file}`, 'Claude Code loads it in its next session.'];
    },
  };
}

async function planCodexSkill(home: string): Promise<Step> {
  const id = 'codex';
  const label = `skill ${SKILL_NAME}`;
  const config = await readFile(path.join(home, '.codex', 'config.toml'), 'utf8').catch(() => '');
  const installed = codexSkillPlugin(config);
  if (installed) return { id, summary: `${label}: already installed: Codex plugin ${installed}` };

  // Codex refuses to add a second marketplace under the same name, so one
  // added earlier, from a checkout or another tag, is used as it is.
  const commands = codexHasMarketplace(config) ? [codexPluginAddArgs()] : [codexMarketplaceAddArgs(), codexPluginAddArgs()];
  const source = commands.length === 1 ? 'from the dvalincode-local marketplace Codex already has' : `from GitHub at v${VERSION}`;
  return {
    id,
    summary: `${label}: install the dvalin-security plugin ${source}  (Codex's own plugin commands; user-level)`,
    details: commands.map(args => `  ${['codex', ...args].map(shellWord).join(' ')}`),
    apply: async () => {
      for (const args of commands) await runCodex(args);
      return [`Installed ${CODEX_PLUGIN} in Codex. Start a new Codex session to load its ${SKILL_NAME} skill.`];
    },
  };
}

async function runCodex(args: string[]): Promise<void> {
  const command = ['codex', ...args].map(shellWord).join(' ');
  try {
    await execFileAsync('codex', args);
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    if (missing) throw new Error(`Codex CLI was not found. Install Codex, then run: ${command}`);
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    throw new Error(`${command} failed: ${stderr || message(error)}`);
  }
}

/** The text at `file`, or undefined when nothing is there. Anything unreadable there reads as different text. */
async function currentText(file: string): Promise<string | undefined> {
  try {
    await lstat(file);
  } catch {
    return undefined;
  }
  return readFile(file, 'utf8').catch(() => '');
}

/** Equal but for line endings, which a Windows checkout may have changed. */
function sameText(a: string, b: string): boolean {
  return a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');
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
      console.log(`      Dvalin: ${locations(agent.configured, root)}`);
    } else if (agent.installed) {
      console.log('      Dvalin: not connected');
    }
    if (agent.skill?.length) {
      console.log(`      Skill:  ${locations(agent.skill, root)}`);
    } else if (agent.skill && agent.installed) {
      console.log('      Skill:  not installed');
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

function locations(entries: DvalinLocation[], root: string): string {
  return entries.map(entry => `${entry.scope} ${displayPath(entry.file, root)}`).join(', ');
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
