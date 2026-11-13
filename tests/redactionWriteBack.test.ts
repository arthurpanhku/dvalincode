import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDvalinContext } from '../src/core/context.js';
import { REDACTION_PLACEHOLDER, redactToolText } from '../src/core/redactSecrets.js';
import { applyPatchTool } from '../src/tools/applyPatch.js';
import { editFileTool } from '../src/tools/editFile.js';
import { writeFileTool } from '../src/tools/writeFile.js';

const SECRET = `sk-proj-${'a1B2c3D4e5'.repeat(4)}`;
const CONFIG = `export const config = {\n  apiKey: '${SECRET}',\n  retries: 3,\n};\n`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'dvalin-redaction-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(relative: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
  writeFileSync(path.join(dir, relative), content, 'utf8');
}

function read(relative: string): string {
  return readFileSync(path.join(dir, relative), 'utf8');
}

const context = () => createDvalinContext({ cwd: dir, approvalMode: 'full-auto' });

describe('redaction placeholders never reach disk', () => {
  it('refuses a whole-file rewrite built from what the model was shown', async () => {
    put('config.ts', CONFIG);
    // What the model sees after read_file: the key is replaced by the placeholder.
    const shown = redactToolText(CONFIG).text;
    expect(shown).toContain(REDACTION_PLACEHOLDER);
    const rewrite = shown.replace('retries: 3', 'retries: 5');

    await expect(writeFileTool.run({ filePath: 'config.ts', content: rewrite }, context())).rejects.toThrow(
      /Refusing to write config\.ts/,
    );
    expect(read('config.ts')).toBe(CONFIG);
  });

  it('refuses to create a file with a placeholder, before creating any directory', async () => {
    await expect(
      writeFileTool.run({ filePath: 'fresh/copy.ts', content: `const key = '${REDACTION_PLACEHOLDER}';\n` }, context()),
    ).rejects.toThrow(/Refusing to write fresh\/copy\.ts/);
    expect(existsSync(path.join(dir, 'fresh'))).toBe(false);
  });

  it('refuses an edit that adds a placeholder, but allows edits where the text was already there', async () => {
    put('settings.ts', CONFIG);
    await expect(
      editFileTool.run(
        editFileTool.inputSchema.parse({ filePath: 'settings.ts', oldString: `'${SECRET}'`, newString: `'${REDACTION_PLACEHOLDER}'` }),
        context(),
      ),
    ).rejects.toThrow(/Refusing to write settings\.ts/);
    expect(read('settings.ts')).toBe(CONFIG);

    // A file that legitimately contains the literal text (docs, tests) can still be edited.
    put('docs.md', `Secrets appear as ${REDACTION_PLACEHOLDER} in tool output.\n`);
    await editFileTool.run(
      editFileTool.inputSchema.parse({ filePath: 'docs.md', oldString: 'Secrets appear', newString: 'Credentials appear' }),
      context(),
    );
    expect(read('docs.md')).toBe(`Credentials appear as ${REDACTION_PLACEHOLDER} in tool output.\n`);
  });

  it('refuses a multi-file patch when any file would gain a placeholder, changing none of them', async () => {
    put('a.ts', 'export const a = 1;\n');
    put('b.ts', CONFIG);
    const input = applyPatchTool.inputSchema.parse({
      files: [
        { filePath: 'a.ts', oldString: 'a = 1', newString: 'a = 2' },
        { filePath: 'b.ts', oldString: `'${SECRET}'`, newString: `'${REDACTION_PLACEHOLDER}'` },
      ],
    });
    await expect(applyPatchTool.run(input, context())).rejects.toThrow(/Refusing to write b\.ts/);
    expect(read('a.ts')).toBe('export const a = 1;\n');
    expect(read('b.ts')).toBe(CONFIG);
  });
});
