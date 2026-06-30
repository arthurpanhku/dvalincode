import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSkillBundle, listSkills, readSkill } from '../src/skills/store.js';

describe('skills store', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dvalin-skills-'));
    originalHome = process.env.DVALINCODE_HOME;
    process.env.DVALINCODE_HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.DVALINCODE_HOME;
    } else {
      process.env.DVALINCODE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  });

  it('installs built-in security skills when listing', async () => {
    const skills = await listSkills();
    const names = skills.map(skill => skill.name);

    expect(names).toContain('secure-code-scan');
    expect(names).toContain('secure-code-remediation');
    expect(skills.find(skill => skill.name === 'secure-code-scan')?.builtIn).toBe(true);
  });

  it('imports and reads a custom skill bundle', async () => {
    await installSkillBundle({
      app: 'dvalincode-skill',
      version: 1,
      manifest: {
        name: 'Review Helper',
        title: 'Review Helper',
        description: 'Review code with local team conventions.',
        version: '1.0.0',
        tools: ['read_file'],
      },
      files: {
        'SKILL.md': '# Review Helper\n\nRead the code before commenting.\n',
        'references/rules.md': 'Keep feedback actionable.\n',
      },
    });

    const bundle = await readSkill('review-helper');

    expect(bundle.manifest.name).toBe('review-helper');
    expect(bundle.files['SKILL.md']).toContain('Review Helper');
    expect(bundle.files['references/rules.md']).toContain('actionable');
  });

  it('ignores skill bundle files that would escape the skill directory', async () => {
    await installSkillBundle({
      app: 'dvalincode-skill',
      version: 1,
      manifest: {
        name: 'Traversal Helper',
        title: 'Traversal Helper',
        description: 'Try to escape the skill directory.',
        version: '1.0.0',
      },
      files: {
        'SKILL.md': '# Traversal Helper\n',
        '../escaped.txt': 'nope',
        '/absolute.txt': 'nope',
        'safe/notes.md': 'ok',
      },
    });

    const bundle = await readSkill('traversal-helper');

    expect(bundle.files['safe/notes.md']).toBe('ok');
    await expect(access(path.join(home, 'escaped.txt'))).rejects.toThrow();
  });
});
