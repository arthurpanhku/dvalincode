import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { macMenuBar } from '../src/gui/macMenu.js';

describe('Desktop shell: macOS menu bar', () => {
  const items = macMenuBar('DvalinCode').flatMap((menu) => menu.items).filter((item) => item !== null);
  const actionFor = new Map(items.map((item) => [item.key, item.action]));

  it('binds the editing shortcuts to the Cocoa editing actions', () => {
    expect(actionFor.get('z')).toBe('undo:');
    expect(actionFor.get('Z')).toBe('redo:'); // uppercase = ⇧⌘Z
    expect(actionFor.get('x')).toBe('cut:');
    expect(actionFor.get('c')).toBe('copy:');
    expect(actionFor.get('v')).toBe('paste:');
    expect(actionFor.get('a')).toBe('selectAll:');
  });

  it('quits, hides, minimizes and closes from the keyboard', () => {
    expect(actionFor.get('q')).toBe('terminate:');
    expect(actionFor.get('h')).toBe('hide:');
    expect(actionFor.get('m')).toBe('performMiniaturize:');
    expect(actionFor.get('w')).toBe('performClose:');
  });

  it('leaves ⌘N to the page, which uses it for New chat', () => {
    expect(actionFor.has('n')).toBe(false);
    expect(actionFor.has('N')).toBe(false);
  });

  it('binds each shortcut once', () => {
    expect(actionFor.size).toBe(items.length);
  });
});

describe('Desktop shell: embedded server child', () => {
  const sessionsDir = mkdtempSync(path.join(tmpdir(), 'dvalin-gui-server-'));
  afterAll(() => rmSync(sessionsDir, { recursive: true, force: true }));

  it('serves while the window process holds its stdin, and exits once that closes', { timeout: 30_000 }, async () => {
    const entry = fileURLToPath(new URL('../src/gui/index.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      env: {
        ...process.env,
        DVALINCODE_GUI_ROLE: 'server',
        DVALINCODE_SERVER_TOKEN: 'gui-server-test-token-0123456789',
        DVALINCODE_SESSIONS_DIR: sessionsDir,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const exited = once(child, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (/localhost:\d+/.test(output)) resolve();
        });
        child.on('exit', (code) => reject(new Error(`server exited before listening (code ${code}): ${output}`)));
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.exitCode).toBeNull();

      // What the OS does to the pipe when the window process ends, however it ends.
      child.stdin.end();
      const [code] = await exited;
      expect(code).toBe(0);
    } finally {
      child.kill();
    }
  });
});
