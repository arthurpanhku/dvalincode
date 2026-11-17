import { spawn } from 'node:child_process';

/** A picker waits on a person, so the limit is generous; it only ends a dialog left open. */
const PICKER_TIMEOUT_MS = 10 * 60_000;

export type PickerCommand = { command: string; args: string[] };

/**
 * The Windows folder picker as a PowerShell script.
 *
 * - Its output is UTF-8. Windows PowerShell otherwise writes in the OEM code
 *   page, so a folder named in Chinese (or any non-ASCII script) reached Node
 *   garbled and could not be opened.
 * - An invisible topmost owner brings the dialog to the front. A dialog with no
 *   owner, raised by a background process, can open behind the app window, and
 *   the app then seems to hang while it waits.
 */
export function windowsPickerScript(): string {
  return [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "Choose a DvalinCode workspace"',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    '$owner.Dispose()',
  ].join('\n');
}

/** PowerShell's -EncodedCommand form: base64 of UTF-16LE, so no quoting can break the script. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** The pickers to try on this platform, in order. */
export function folderPickerCommands(platform: NodeJS.Platform = process.platform, cwd = process.cwd()): PickerCommand[] {
  if (platform === 'darwin') {
    return [{ command: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "Choose a DvalinCode workspace")'] }];
  }
  if (platform === 'win32') {
    return [{
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodePowerShell(windowsPickerScript())],
    }];
  }
  return [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=DvalinCode workspace'] },
    { command: 'kdialog', args: ['--getexistingdirectory', cwd, 'DvalinCode workspace'] },
  ];
}

/**
 * Run a picker and return what it prints.
 *
 * Its stdin is closed. Windows PowerShell does not exit while stdin is an open
 * pipe, and that is what `execFile` leaves it, so the request used to hang even
 * after a folder was chosen. `windowsHide` keeps a console window from flashing up.
 */
export function runPicker({ command, args }: PickerCommand, timeoutMs = PICKER_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('The folder picker was closed after waiting too long. Try again, or enter the path.'));
      else if (code === 0) resolve(stdout.replace(/^﻿/, '').trim());
      // zenity reports Cancel as a silent non-zero exit.
      else reject(new Error(stderr.trim() || 'No folder was chosen.'));
    });
  });
}

/** Ask the person to choose a folder with the platform's own dialog. */
export async function pickFolder(): Promise<string> {
  for (const picker of folderPickerCommands()) {
    let chosen: string;
    try {
      chosen = await runPicker(picker);
    } catch (error) {
      // A picker that is not installed falls through to the next (Linux has two).
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!chosen) throw new Error('No folder was chosen.');
    return chosen;
  }
  throw new Error('No folder picker is available. Enter the workspace path manually.');
}
