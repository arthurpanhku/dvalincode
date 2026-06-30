import { z } from 'zod';
import { readSkill } from '../skills/store.js';
import type { Tool } from './types.js';

const inputSchema = z.object({
  name: z.string().min(1),
}).strict();

type Input = z.infer<typeof inputSchema>;

export const readSkillTool: Tool<Input> = {
  name: 'read_skill',
  description: 'Read an installed DvalinCode skill, including its SKILL.md instructions.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  async run(input) {
    const bundle = await readSkill(input.name);
    const skillMd = bundle.files['SKILL.md'] ?? '(SKILL.md missing)';
    return {
      title: `Skill ${bundle.manifest.name}`,
      output: skillMd,
      metadata: {
        manifest: bundle.manifest,
        files: Object.keys(bundle.files),
      },
    };
  },
};
