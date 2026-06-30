import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dvalinHome } from '../memory/store.js';

export type SkillManifest = {
  name: string;
  title: string;
  description: string;
  version: string;
  builtIn?: boolean;
  tools?: string[];
};

export type SkillBundle = {
  app: 'dvalincode-skill';
  version: 1;
  manifest: SkillManifest;
  files: Record<string, string>;
};

export type SkillSummary = SkillManifest & {
  installed: boolean;
};

const BUNDLE_VERSION = 1;
const SKILL_MD = 'SKILL.md';

const BUILT_IN_SKILLS: SkillBundle[] = [
  {
    app: 'dvalincode-skill',
    version: BUNDLE_VERSION,
    manifest: {
      name: 'secure-code-scan',
      title: 'Secure Code Scan',
      description: 'Scan the current workspace for high-signal security risks and persist findings as remediation cases.',
      version: '1.0.0',
      builtIn: true,
      tools: ['run_security_scan', 'list_remediation_cases'],
    },
    files: {
      [SKILL_MD]: [
        '# Secure Code Scan',
        '',
        'Use this skill when the user wants to inspect a project for security risks before editing code.',
        '',
        'Workflow:',
        '1. Call `run_security_scan` for the current workspace.',
        '2. Review returned findings and persisted remediation cases.',
        '3. Prioritize high-severity findings and explain false-positive uncertainty.',
        '4. Do not edit files as part of scanning; hand off to the remediation skill for fixes.',
      ].join('\n'),
    },
  },
  {
    app: 'dvalincode-skill',
    version: BUNDLE_VERSION,
    manifest: {
      name: 'secure-code-remediation',
      title: 'Secure Code Remediation',
      description: 'Prepare isolated worktrees and guide minimal, test-backed fixes for security findings.',
      version: '1.0.0',
      builtIn: true,
      tools: ['list_remediation_cases', 'prepare_remediation_worktree', 'run_check', 'git_diff'],
    },
    files: {
      [SKILL_MD]: [
        '# Secure Code Remediation',
        '',
        'Use this skill when the user wants to fix a security finding or close a remediation case.',
        '',
        'Workflow:',
        '1. Call `list_remediation_cases` and select an open or worktree-ready case.',
        '2. Call `prepare_remediation_worktree` before editing if the case has no worktree.',
        '3. Inspect the affected file and directly related callers/tests.',
        '4. Make the smallest behavior-preserving fix that removes the vulnerability class.',
        '5. Run targeted checks with `run_check` and summarize changed files, verification, and remaining risk.',
      ].join('\n'),
    },
  },
];

export function skillsRoot(): string {
  return path.join(dvalinHome(), 'skills');
}

function safeSkillName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!safe) throw new Error('Skill name is required');
  return safe;
}

function sanitizeRelPath(rel: string): string | null {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  if (parts.some(part => part === '.' || part === '..' || !part)) return null;
  return parts.join(path.sep);
}

function validateBundle(value: unknown): SkillBundle {
  const bundle = value as Partial<SkillBundle> | undefined;
  if (!bundle || bundle.app !== 'dvalincode-skill' || bundle.version !== BUNDLE_VERSION) {
    throw new Error('Not a DvalinCode skill bundle');
  }
  if (!bundle.manifest || typeof bundle.manifest.name !== 'string' || typeof bundle.manifest.description !== 'string') {
    throw new Error('Skill manifest is invalid');
  }
  if (!bundle.files || typeof bundle.files !== 'object' || typeof bundle.files[SKILL_MD] !== 'string') {
    throw new Error('Skill bundle must include SKILL.md');
  }
  const name = safeSkillName(bundle.manifest.name);
  return {
    app: 'dvalincode-skill',
    version: BUNDLE_VERSION,
    manifest: {
      name,
      title: bundle.manifest.title || name,
      description: bundle.manifest.description,
      version: bundle.manifest.version || '1.0.0',
      builtIn: !!bundle.manifest.builtIn,
      tools: Array.isArray(bundle.manifest.tools) ? bundle.manifest.tools.filter(item => typeof item === 'string') : [],
    },
    files: Object.fromEntries(Object.entries(bundle.files).filter(([, content]) => typeof content === 'string')) as Record<string, string>,
  };
}

export function builtInSkillBundles(): SkillBundle[] {
  return BUILT_IN_SKILLS;
}

export async function ensureBuiltInSkills(): Promise<void> {
  for (const bundle of BUILT_IN_SKILLS) {
    await installSkillBundle(bundle);
  }
}

export async function installSkillBundle(raw: unknown): Promise<SkillSummary> {
  const bundle = validateBundle(raw);
  const dir = path.join(skillsRoot(), bundle.manifest.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'skill.json'), JSON.stringify(bundle.manifest, null, 2) + '\n', 'utf-8');

  for (const [rel, content] of Object.entries(bundle.files)) {
    const safeRel = sanitizeRelPath(rel);
    if (!safeRel) continue;
    const target = path.join(dir, safeRel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf-8');
  }

  return { ...bundle.manifest, installed: true };
}

export async function listSkills(): Promise<SkillSummary[]> {
  await ensureBuiltInSkills();
  const root = skillsRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: SkillSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'skill.json'), 'utf-8')) as SkillManifest;
      skills.push({ ...manifest, name: safeSkillName(manifest.name), installed: true });
    } catch {
      // Skip malformed skill directories.
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(name: string): Promise<SkillBundle> {
  await ensureBuiltInSkills();
  const safe = safeSkillName(name);
  const dir = path.join(skillsRoot(), safe);
  const manifest = JSON.parse(await readFile(path.join(dir, 'skill.json'), 'utf-8')) as SkillManifest;
  const files: Record<string, string> = {};

  for await (const rel of walk(dir, '')) {
    if (rel === 'skill.json') continue;
    files[rel] = await readFile(path.join(dir, rel), 'utf-8');
  }

  return {
    app: 'dvalincode-skill',
    version: BUNDLE_VERSION,
    manifest: { ...manifest, name: safe },
    files,
  };
}

export async function deleteSkill(name: string): Promise<void> {
  const safe = safeSkillName(name);
  const manifest = await readSkill(safe);
  if (manifest.manifest.builtIn) {
    throw new Error('Built-in skills cannot be deleted');
  }
  await rm(path.join(skillsRoot(), safe), { recursive: true, force: true });
}

async function* walk(base: string, rel: string): AsyncGenerator<string> {
  const dir = path.join(base, rel);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(base, childRel);
    const info = await stat(childAbs).catch(() => null);
    if (!info) continue;
    if (entry.isDirectory()) {
      yield* walk(base, childRel);
    } else if (entry.isFile() && info.size <= 512 * 1024) {
      yield childRel;
    }
  }
}
