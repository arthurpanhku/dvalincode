import { describe, it, expect, beforeEach } from 'vitest';
import chalk from 'chalk';
import {
  summarizeToolInput,
  formatToolCall,
  formatToolError,
  colorizeDiff,
  formatToolResult,
  statusLine,
  approvalLine,
} from '../../src/tui/render.js';

// Default to no-color so structural assertions are deterministic.
beforeEach(() => {
  chalk.level = 0;
});

describe('summarizeToolInput', () => {
  it('prefers a meaningful key and truncates long values', () => {
    expect(summarizeToolInput({ filePath: 'src/index.ts' })).toBe('src/index.ts');
    expect(summarizeToolInput({ command: 'npm test' })).toBe('npm test');
    expect(summarizeToolInput({ pattern: 'export class' })).toBe('export class');
    const long = 'x'.repeat(200);
    expect(summarizeToolInput({ filePath: long }).length).toBeLessThanOrEqual(81);
    expect(summarizeToolInput({ filePath: long }).endsWith('…')).toBe(true);
  });

  it('falls back to JSON for objects without a known key', () => {
    expect(summarizeToolInput({ foo: 'bar' })).toContain('foo');
  });
});

describe('formatToolCall / formatToolError', () => {
  it('includes the tool name and an arg summary', () => {
    expect(formatToolCall('read_file', { filePath: 'a.ts' })).toContain('read_file');
    expect(formatToolCall('read_file', { filePath: 'a.ts' })).toContain('a.ts');
  });

  it('renders errors with the tool name and message', () => {
    expect(formatToolError('shell', 'boom')).toContain('shell');
    expect(formatToolError('shell', 'boom')).toContain('boom');
  });
});

describe('colorizeDiff', () => {
  it('preserves content and line count without color', () => {
    const input = '+ added\n- removed\n  kept';
    const out = colorizeDiff(input);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain('+ added');
    expect(out).toContain('- removed');
  });

  it('wraps add/remove lines in ANSI color when enabled', () => {
    chalk.level = 1;
    const out = colorizeDiff('+ added\n- removed');
    // ESC[ sequences present around the colored lines
    expect(out).toMatch(/\[/);
  });
});

describe('formatToolResult', () => {
  it('indents output and shows a fallback for empty results', () => {
    expect(formatToolResult('hello')).toBe('  hello');
    expect(formatToolResult('   ')).toContain('done');
  });
});

describe('statusLine / approvalLine', () => {
  it('shows the mode, provider, and cwd', () => {
    const s = statusLine('cowork', 'deepseek/deepseek-chat', '~/proj');
    expect(s).toContain('[cowork]');
    expect(s).toContain('deepseek/deepseek-chat');
    expect(s).toContain('~/proj');
  });

  it('shows the tool and the y/N affordance', () => {
    const a = approvalLine('write_file', { filePath: 'x.ts' });
    expect(a).toContain('write_file');
    expect(a).toContain('[y/N]');
  });
});
