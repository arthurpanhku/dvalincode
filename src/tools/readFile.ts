import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../core/workspace.js';
import { loadIgnorePatterns } from '../core/ignorefile.js';
import { sha256 } from '../audit/hash.js';
import type { Tool, ToolResult } from './types.js';

/** In a range read of a large file, longer lines are cut to this many characters. */
const MAX_RANGE_LINE_CHARS = 2_000;

const inputSchema = z
  .object({
    filePath: z.string().min(1),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const readFileTool: Tool<Input> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from inside the workspace.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  async run(input, context) {
    const ignorePatterns = await loadIgnorePatterns(context.cwd);
    for (const pattern of ignorePatterns) {
      if (
        input.filePath === pattern ||
        input.filePath.endsWith('/' + pattern) ||
        input.filePath.includes('/' + pattern + '/') ||
        input.filePath.startsWith(pattern + '/')
      ) {
        throw new Error(`File excluded by .dvalincodeignore: ${input.filePath}`);
      }
    }

    const resolvedPath = await resolveInsideWorkspace(context.cwd, input.filePath);
    const info = await stat(resolvedPath);

    if (info.isDirectory()) {
      throw new Error(`Cannot read a directory as a file: ${input.filePath}`);
    }

    if (info.size > context.maxBytes) {
      if (input.offset === undefined && input.limit === undefined) {
        throw new Error(
          `File is larger than the configured limit (${context.maxBytes} bytes); read it in parts with offset and limit (up to 1000 lines per call).`,
        );
      }
      return readLineRange(resolvedPath, input.filePath, input.offset ?? 0, input.limit ?? 1000, info.size);
    }

    const text = await readFile(resolvedPath, 'utf8');
    const lines = text.split(/\r?\n/);
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    const selected = lines.slice(start, end);
    const numbered = selected.map((line, index) => `${String(start + index + 1).padStart(4, ' ')} | ${line}`);

    return {
      title: `Read ${input.filePath}`,
      output: numbered.join('\n'),
      metadata: {
        path: input.filePath,
        bytes: info.size,
        totalLines: lines.length,
        offset: start,
        returnedLines: selected.length,
        sha256: sha256(text),
      },
    };
  },
};

/**
 * Lines [start, start + limit) of a file too large to load whole. The file is
 * streamed once: the requested lines are kept (long ones cut short), and the
 * whole file is hashed and counted so the result reports the same sha256 and
 * totalLines as a whole-file read would.
 */
async function readLineRange(
  resolvedPath: string,
  displayPath: string,
  start: number,
  limit: number,
  bytes: number,
): Promise<ToolResult> {
  const end = start + limit;
  const hash = createHash('sha256');
  const decoder = new TextDecoder();
  const selected: string[] = [];
  let line = 0;
  let current = '';
  let currentLength = 0;
  let lastChar = '';
  let clippedLines = 0;

  const inRange = (): boolean => line >= start && line < end;
  const take = (piece: string): void => {
    if (!piece) return;
    currentLength += piece.length;
    lastChar = piece[piece.length - 1];
    if (current.length < MAX_RANGE_LINE_CHARS) current += piece.slice(0, MAX_RANGE_LINE_CHARS - current.length);
  };
  const finishLine = (): void => {
    if (inRange()) {
      // A CRLF line ends in "\r": it is neither shown nor counted.
      const length = lastChar === '\r' ? currentLength - 1 : currentLength;
      const text = current.slice(0, Math.min(current.length, length));
      if (length > MAX_RANGE_LINE_CHARS) {
        clippedLines++;
        selected.push(`${text}… [line is ${length} characters]`);
      } else {
        selected.push(text);
      }
    }
    current = '';
    currentLength = 0;
    lastChar = '';
    line++;
  };

  for await (const chunk of createReadStream(resolvedPath)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    const text = decoder.decode(buffer, { stream: true });
    let from = 0;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', from)) {
      if (inRange()) take(text.slice(from, newline));
      finishLine();
      from = newline + 1;
    }
    if (inRange()) take(text.slice(from));
  }
  const rest = decoder.decode();
  if (inRange()) take(rest);
  finishLine();

  const numbered = selected.map((text, index) => `${String(start + index + 1).padStart(4, ' ')} | ${text}`);
  return {
    title: `Read ${displayPath}`,
    output: numbered.join('\n'),
    metadata: {
      path: displayPath,
      bytes,
      totalLines: line,
      offset: start,
      returnedLines: selected.length,
      sha256: hash.digest('hex'),
      clippedLines,
    },
  };
}
