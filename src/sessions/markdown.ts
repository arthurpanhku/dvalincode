import type { Session } from './store.js';
import type { ChatMessage } from '../providers/types.js';

/**
 * Render a session's conversation as a portable Markdown transcript — a
 * downloadable record of an AI interaction (files, decisions, tool calls and
 * results all inline). Pure function over the session, so it's trivially
 * testable and reused by both the CLI and the web "Download Markdown" button.
 */
export function renderSessionMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# DvalinCode session — \`${session.id}\``);
  lines.push('');
  lines.push(`- Created: ${session.createdAt}`);
  lines.push(`- Updated: ${session.updatedAt}`);
  lines.push(`- Workspace: \`${session.cwd}\``);
  if (session.goal) lines.push(`- Goal: ${session.goal}`);
  if (session.summary) lines.push(`- Summary: ${session.summary}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  const turns = session.messages.filter(m => m.role !== 'system');
  if (turns.length === 0) {
    lines.push('_No messages in this session._');
    return lines.join('\n') + '\n';
  }

  for (const msg of turns) {
    lines.push(...renderMessage(msg));
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function renderMessage(msg: ChatMessage): string[] {
  switch (msg.role) {
    case 'user':
      return [`## 🧑 User`, '', msg.content.trim() || '_(empty)_'];

    case 'assistant': {
      const out = [`## 🤖 Assistant`, ''];
      if (msg.content.trim()) out.push(msg.content.trim());
      for (const call of msg.tool_calls ?? []) {
        out.push('', `**Tool call:** \`${call.name}\``, '', '```json', prettyArgs(call.arguments), '```');
      }
      if (!msg.content.trim() && (!msg.tool_calls || msg.tool_calls.length === 0)) {
        out.push('_(empty)_');
      }
      return out;
    }

    case 'tool': {
      const label = msg.name ? `🔧 Tool result — \`${msg.name}\`` : '🔧 Tool result';
      // Strip the "[Tool x result]:\n" / "[Tool x error]: " framing the runner adds.
      const body = msg.content
        .replace(/^\[Tool \w+ result\]:\n?/, '')
        .replace(/^\[Tool \w+ error\]:\s?/, '')
        .trimEnd();
      return [`### ${label}`, '', '```', body || '(no output)', '```'];
    }

    default:
      return [`## ${msg.role}`, '', msg.content.trim()];
  }
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}
