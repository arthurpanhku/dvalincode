import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { UserQuestion } from '../core/context.js';
import type { Tool } from './types.js';

export const askUserTool: Tool<UserQuestion> = {
  name: 'ask_user',
  description: 'Ask the user one question with distinct options when a decision is needed to continue.',
  access: 'read',
  inputSchema: z.object({
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(5)
      .refine(options => new Set(options).size === options.length, 'Use distinct options'),
  }).strict(),
  async run(input, context) {
    if (!context.askUser) {
      context.audit?.append({ type: 'user_question', outcome: 'unavailable', optionCount: input.options.length });
      return { title: 'User question unavailable', output: 'This run cannot ask interactive questions. Include the question in your final response.' };
    }
    const choice = await context.askUser(randomUUID(), input);
    const label = typeof choice === 'number' && Number.isInteger(choice) ? input.options[choice] : undefined;
    context.audit?.append({ type: 'user_question', outcome: label ? 'answered' : 'skipped', optionCount: input.options.length });
    return { title: 'User question', output: label ? `The user selected option ${choice! + 1}: ${label}` : 'The user skipped the question.' };
  },
};
