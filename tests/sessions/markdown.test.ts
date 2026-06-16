import { describe, it, expect } from 'vitest';
import { renderSessionMarkdown } from '../../src/sessions/markdown.js';
import type { Session } from '../../src/sessions/store.js';

function session(messages: Session['messages']): Session {
  return {
    id: 'dc_test',
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T01:00:00.000Z',
    cwd: '/repo',
    messages,
  };
}

describe('renderSessionMarkdown', () => {
  it('renders header metadata', () => {
    const md = renderSessionMarkdown(session([]));
    expect(md).toContain('# DvalinCode session — `dc_test`');
    expect(md).toContain('Workspace: `/repo`');
    expect(md).toContain('_No messages in this session._');
  });

  it('renders user / assistant / tool turns and skips system', () => {
    const md = renderSessionMarkdown(session([
      { role: 'system', content: 'you are a bot' },
      { role: 'user', content: 'add a test' },
      {
        role: 'assistant',
        content: 'On it.',
        tool_calls: [{ id: 't1', name: 'write_file', arguments: '{"filePath":"a.ts"}' }],
      },
      { role: 'tool', name: 'write_file', content: '[Tool write_file result]:\nCreated a.ts', tool_call_id: 't1' },
    ]));

    expect(md).not.toContain('you are a bot');
    expect(md).toContain('## 🧑 User');
    expect(md).toContain('add a test');
    expect(md).toContain('## 🤖 Assistant');
    expect(md).toContain('**Tool call:** `write_file`');
    expect(md).toContain('"filePath": "a.ts"'); // pretty-printed args
    expect(md).toContain('🔧 Tool result — `write_file`');
    expect(md).toContain('Created a.ts');
    expect(md).not.toContain('[Tool write_file result]'); // framing stripped
  });
});
