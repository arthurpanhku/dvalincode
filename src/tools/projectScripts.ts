import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';

const inputSchema = z.object({}).strict();

type ScriptInfo = {
  source: string;
  name: string;
  command: string;
};

export const projectScriptsTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'project_scripts',
  description: 'List known project scripts and checks from package.json, Makefile, and common Python project files.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  isUndoable: () => false,

  async run(_input, context) {
    const scripts = await detectScripts(context.cwd);
    if (scripts.length === 0) {
      return { title: 'project_scripts', output: 'No project scripts detected.' };
    }
    return {
      title: 'project scripts',
      output: scripts.map(script => `${script.source}:${script.name} — ${script.command}`).join('\n'),
      metadata: { scripts },
    };
  },
};

export async function detectScripts(cwd: string): Promise<ScriptInfo[]> {
  const scripts: ScriptInfo[] = [];
  const pkg = await readJson(path.join(cwd, 'package.json')) as { scripts?: Record<string, string> } | null;
  if (pkg?.scripts) {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      scripts.push({ source: 'package.json', name, command });
    }
  }

  if (await exists(path.join(cwd, 'Makefile'))) {
    const text = await readFile(path.join(cwd, 'Makefile'), 'utf-8').catch(() => '');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s|$)/);
      if (match && !match[1]?.startsWith('.')) {
        scripts.push({ source: 'Makefile', name: match[1], command: `make ${match[1]}` });
      }
    }
  }

  if (await exists(path.join(cwd, 'pyproject.toml'))) {
    scripts.push({ source: 'pyproject.toml', name: 'python-tests', command: 'pytest' });
    scripts.push({ source: 'pyproject.toml', name: 'python-typecheck', command: 'mypy .' });
  }

  return scripts;
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
