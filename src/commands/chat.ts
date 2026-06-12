import type { Command } from 'commander';
import type { ToolRegistry } from '../tools/registry.js';
import { ProviderManager } from '../providers/manager.js';
import { scanProject } from '../core/projectScanner.js';
import { AgentLoop } from '../agent/loop.js';
import { createDvalinContext } from '../core/context.js';
import { createSession, saveSession, loadSession, summarizeSession } from '../sessions/store.js';
import { readConfig } from '../server/configStore.js';

export function registerChatCommand(program: Command, registry: ToolRegistry): void {
  program
    .command('chat')
    .description('Chat with an AI coding assistant about the current project')
    .argument('<message...>', 'message to send')
    .option('--session <id>', 'resume an existing session by ID')
    .option('--provider <name>', 'provider name', 'deepseek')
    .option('--model <name>', 'model name')
    .option('--profile <name>', 'use a named provider profile from ~/.dvalincode/config.json')
    .action(async (messageParts: string[], options: { session?: string; provider: string; model?: string; profile?: string }) => {
      const message = messageParts.join(' ');
      const cwd = process.cwd();

      // Load or create session
      let session;
      if (options.session) {
        const loaded = await loadSession(options.session);
        if (!loaded) {
          console.error(`Session not found: ${options.session}`);
          process.exit(1);
        }
        session = loaded;
      } else {
        session = createSession(cwd);
      }

      // Set up provider. A named --profile (from ~/.dvalincode/config.json)
      // takes precedence over the --provider flag / env defaults.
      const manager = new ProviderManager().loadFromEnv();
      let providerName = options.provider;
      if (options.profile) {
        const config = await readConfig();
        try {
          providerName = manager.addProfile(config.profiles, options.profile);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
      const provider = manager.get(providerName);

      // Scan workspace for context
      const summary = await scanProject(cwd);

      // Build available tools description
      const tools = registry.list();
      const toolsDesc = tools
        .map((t) => `- ${t.name}: ${t.description} (access: ${t.access})`)
        .join('\n');

      // Build system prompt — include session summary if available for cross-session memory
      const sessionContext = session.summary
        ? `\nPrevious session summary: ${session.summary}\n`
        : '';

      const systemPrompt = [
        'You are DvalinCode, an AI coding assistant embedded in a CLI tool.',
        'The user is working on the following project. You can inspect files, run commands, and make changes.',
        '',
        `Project root: ${summary.root}`,
        `Files: ${summary.fileCount} files`,
        `Package manager(s): ${summary.packageManagers.join(', ') || 'none'}`,
        summary.signals.length > 0 ? `Signals: ${summary.signals.join(', ')}` : '',
        sessionContext,
        '',
        '=== HOW TO USE TOOLS ===',
        '',
        `You have ${tools.length} tools available. To use a tool, embed this syntax in your response:`,
        '',
        '@tool("tool_name", {"param": "value"})',
        '',
        'Examples:',
        `- @tool("list_files", {"pattern": "src/**/*.ts"}) — List TypeScript files in src/`,
        `- @tool("read_file", {"filePath": "src/index.ts"}) — Read a specific file`,
        `- @tool("search_text", {"pattern": "export class", "glob": "src/**/*.ts"}) — Search for text`,
        `- @tool("write_file", {"filePath": "src/new.ts", "content": "..."}) — Write a file (preview diff first)`,
        `- @tool("edit_file", {"filePath": "src/file.ts", "oldString": "old", "newString": "new"}) — Edit a file`,
        `- @tool("shell", {"command": "npm test"}) — Run a shell command`,
        '',
        'Available tools:',
        toolsDesc,
        '',
        'RULES:',
        '- Always use read tools first to understand the codebase before making changes.',
        '- For write_file and edit_file: the tool will report a diff. Review it.',
        '- For shell: only run commands that are safe and relevant.',
        '- If you need more context, use list_files and read_file to explore.',
        '- Prefer focused, surgical changes.',
      ]
        .filter(Boolean)
        .join('\n');

      // Create agent loop
      const loop = new AgentLoop({
        provider,
        registry,
        context: createDvalinContext({
          cwd,
          // Default: read-only for safety. User can opt in with --yes or config.
          allowWrite: false,
          allowExecute: false,
        }),
        systemPrompt,
      });

      // Process message through the state machine
      const result = await loop.processMessage(message, session.messages);

      // Update session with new messages
      session.messages = result.messages;
      session.updatedAt = new Date().toISOString();

      // Generate and save session summary for cross-session memory
      session.summary = summarizeSession(session);

      // Save session
      await saveSession(session);

      // Output results
      console.log(result.output);
      console.log('');
      console.log(
        `--- Session: ${session.id} | ${result.iterationsUsed > 1 ? `(${result.iterationsUsed} iterations) ` : ''}Model: ${provider.name} ---`,
      );
      if (session.summary) {
        console.log(`\n📋 Session summary: ${session.summary}`);
      }
    });
}
