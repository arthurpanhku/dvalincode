import * as path from 'node:path';
import * as vscode from 'vscode';
import { groupByPath, missingScanners, Severity, summarize, type EditorFinding } from './findings.js';
import { runScan } from './scan.js';

const SOURCE = 'Dvalin';

/** Explicit, so a change to either enum surfaces here rather than silently mis-banding. */
function toVsSeverity(severity: Severity): vscode.DiagnosticSeverity {
  switch (severity) {
    case Severity.Error:
      return vscode.DiagnosticSeverity.Error;
    case Severity.Warning:
      return vscode.DiagnosticSeverity.Warning;
    case Severity.Information:
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
/** Findings per file URI, so a code action can recover the one under the cursor. */
const byUri = new Map<string, EditorFinding[]>();
let scanning = false;
let warnedMissing = false;

function config() {
  const c = vscode.workspace.getConfiguration('dvalin');
  return {
    command: c.get<string>('command', 'dvalincode'),
    scanners: c.get<string>('scanners', 'builtin'),
    scanOnSave: c.get<boolean>('scanOnSave', true),
    timeoutMs: c.get<number>('timeoutSeconds', 60) * 1000,
  };
}

function toDiagnostic(finding: EditorFinding): vscode.Diagnostic {
  const range = new vscode.Range(
    finding.range.startLine,
    finding.range.startCharacter,
    finding.range.endLine,
    finding.range.endCharacter,
  );
  const diagnostic = new vscode.Diagnostic(range, finding.message, toVsSeverity(finding.severity));
  diagnostic.source = SOURCE;
  // A linked code turns the rule id into a click-through to the CWE/rule page.
  diagnostic.code = finding.helpUri
    ? { value: finding.ruleId, target: vscode.Uri.parse(finding.helpUri) }
    : finding.ruleId;
  return diagnostic;
}

async function scanWorkspace(folder: vscode.WorkspaceFolder, silent: boolean): Promise<void> {
  if (scanning) return;
  scanning = true;
  status.text = '$(sync~spin) Dvalin';
  status.show();
  try {
    const { command, scanners, timeoutMs } = config();
    const outcome = await runScan({ command, cwd: folder.uri.fsPath, scanners, timeoutMs });

    if (!outcome.ok) {
      status.text = '$(warning) Dvalin';
      status.tooltip = outcome.message;
      // Only interrupt when the user asked for this scan. An on-save failure
      // that pops a modal every keystroke is worse than a quiet status bar.
      if (!silent) vscode.window.showErrorMessage(`Dvalin: ${outcome.message}`);
      return;
    }

    diagnostics.clear();
    byUri.clear();
    for (const [relative, findings] of groupByPath(outcome.result)) {
      const uri = vscode.Uri.file(path.join(folder.uri.fsPath, relative));
      diagnostics.set(uri, findings.map(toDiagnostic));
      byUri.set(uri.toString(), findings);
    }

    const summary = summarize(outcome.result);
    status.text = outcome.result.findings.length ? `$(shield) ${outcome.result.findings.length} Dvalin` : '$(shield) Dvalin';
    status.tooltip = summary;
    if (!silent) vscode.window.showInformationMessage(summary);

    const missing = missingScanners(outcome.result);
    if (missing.length && !warnedMissing) {
      warnedMissing = true;
      vscode.window.showInformationMessage(
        `Dvalin scanned with the built-in rules. Not installed: ${missing.join(', ')}.`,
      );
    }
  } finally {
    scanning = false;
  }
}

/**
 * Offers the repair path on a Dvalin squiggle. The fix runs in a terminal
 * rather than silently in the background: it uses the configured model, edits
 * files, and runs tests, so it should be something the user watches and can
 * interrupt — the same reason the CLI keeps it behind an explicit flag.
 */
class DvalinActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const ours = context.diagnostics.filter(d => d.source === SOURCE);
    if (!ours.length) return [];

    const findings = byUri.get(document.uri.toString()) ?? [];
    const hit = findings.find(f => f.range.startLine === range.start.line);

    const actions: vscode.CodeAction[] = [];

    const fix = new vscode.CodeAction('Dvalin: fix and verify this file', vscode.CodeActionKind.QuickFix);
    fix.diagnostics = ours;
    fix.command = {
      command: 'dvalin.fixFile',
      title: 'Dvalin: fix and verify this file',
      arguments: [document.uri],
    };
    actions.push(fix);

    if (hit?.helpUri) {
      const learn = new vscode.CodeAction(`Dvalin: what is ${hit.ruleId}?`, vscode.CodeActionKind.QuickFix);
      learn.command = {
        command: 'vscode.open',
        title: 'Open rule reference',
        arguments: [vscode.Uri.parse(hit.helpUri)],
      };
      actions.push(learn);
    }

    return actions;
  }
}

function fixFile(uri: vscode.Uri): void {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return;
  const { command, scanners } = config();
  const relative = path.relative(folder.uri.fsPath, uri.fsPath);

  const terminal = vscode.window.createTerminal({ name: 'Dvalin fix', cwd: folder.uri.fsPath });
  terminal.show();
  // --fix uses the configured model and edits files; --verify makes a clean
  // re-scan and passing tests a precondition. Shown, never run headless.
  terminal.sendText(`${command} dvalin . --scanners ${scanners} --fix --verify`);
  vscode.window.showInformationMessage(
    `Dvalin is repairing findings (including ${relative}) in a terminal. Re-run the scan when it finishes.`,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection('dvalin');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'dvalin.scan';
  context.subscriptions.push(diagnostics, status);

  const firstFolder = () => vscode.workspace.workspaceFolders?.[0];

  context.subscriptions.push(
    vscode.commands.registerCommand('dvalin.scan', async () => {
      const folder = firstFolder();
      if (!folder) {
        vscode.window.showWarningMessage('Dvalin: open a folder to scan.');
        return;
      }
      await scanWorkspace(folder, false);
    }),
    vscode.commands.registerCommand('dvalin.clear', () => {
      diagnostics.clear();
      byUri.clear();
      status.hide();
    }),
    vscode.commands.registerCommand('dvalin.fixFile', (uri: vscode.Uri) => fixFile(uri)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new DvalinActions(), {
      providedCodeActionKinds: DvalinActions.kinds,
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (!config().scanOnSave || document.uri.scheme !== 'file') return;
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (folder) void scanWorkspace(folder, true);
    }),
  );

  const folder = firstFolder();
  if (folder) void scanWorkspace(folder, true);
}

export function deactivate(): void {
  diagnostics?.dispose();
  status?.dispose();
}
