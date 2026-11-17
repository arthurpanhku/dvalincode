import { describe, expect, it } from 'vitest';
import { encodePowerShell, folderPickerCommands, runPicker, windowsPickerScript } from '../src/server/folderPicker.js';

describe('folder picker', () => {
  it('runs the Windows picker through PowerShell with an encoded, UTF-8, topmost script', () => {
    const [picker] = folderPickerCommands('win32');
    expect(picker?.command).toBe('powershell.exe');
    expect(picker?.args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    const script = Buffer.from(picker!.args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toBe(windowsPickerScript());
    // Non-ASCII folder names survive; the dialog is owned by a topmost window, so it opens in front.
    expect(script).toContain('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false');
    expect(script).toContain('TopMost = $true');
    expect(script).toContain('$dialog.ShowDialog($owner)');
  });

  // Windows PowerShell waits on an open stdin pipe; `cat` stands in for it, and
  // under the old execFile call it never exited.
  it.runIf(process.platform !== 'win32')('closes stdin, so a picker that reads it still exits', async () => {
    await expect(runPicker({ command: 'cat', args: [] }, 5_000)).resolves.toBe('');
  });

  it.runIf(process.platform !== 'win32')('ends a picker that is left open', async () => {
    await expect(runPicker({ command: 'sleep', args: ['30'] }, 200)).rejects.toThrow(/waiting too long/);
  });

  it.runIf(process.platform !== 'win32')('treats a silent non-zero exit as a cancel', async () => {
    await expect(runPicker({ command: 'sh', args: ['-c', 'exit 1'] }, 5_000)).rejects.toThrow('No folder was chosen.');
  });

  // Runs in CI's Windows job: real Windows PowerShell, a Chinese path, no stdin.
  it.runIf(process.platform === 'win32')('gets a non-ASCII path back from Windows PowerShell intact', async () => {
    const utf8Output = windowsPickerScript().split('\n')[0];
    const script = `${utf8Output}\n[Console]::Out.Write("C:\\工作区\\项目")`;
    await expect(
      runPicker({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)] }, 60_000),
    ).resolves.toBe('C:\\工作区\\项目');
  }, 90_000);
});
