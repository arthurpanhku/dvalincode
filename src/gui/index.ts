// DvalinCode desktop GUI — a native window over the same engine/server as the
// web GUI and TUI. This entry is built only with Bun (`bun build --compile`);
// it is excluded from the tsc build because it imports `bun:ffi` transitively.
// The CLI binary never imports this file, so it stays webview-free.
//
// Two processes, one binary. webview.run() must block the MAIN thread — macOS
// only renders UI created on the main thread, so the webview cannot live in a
// worker (the window silently never appears). But a blocked main thread also
// starves the embedded server's event loop (blank window). So the binary
// re-spawns itself with DVALINCODE_GUI_ROLE=server to run the HTTP server as a
// child process, and the parent keeps the webview on its own main thread.

import { basename } from 'node:path';

if (process.env.DVALINCODE_GUI_ROLE === 'server') {
  const { startServer } = await import('../server/index.js');
  await startServer({ host: '127.0.0.1', port: 0, open: false });
} else {
  const { maybeInstallGuiUpdate } = await import('./updater.js');
  if (await maybeInstallGuiUpdate()) process.exit(0);

  const { Webview } = await import('webview-bun');

  // Re-spawn ourselves as the server child. In a `bun build --compile` binary
  // `process.execPath` is the compiled app, and relaunching it re-runs this
  // embedded entry (which then takes the server branch above). Under
  // `bun run src/gui/index.ts` (dev), `process.execPath` is the Bun runtime, so
  // spawning it with no script just prints Bun's help and exits — the server
  // never starts. Pass this module's path in that case so Bun executes it.
  const underBunRuntime = /^bun/i.test(basename(process.execPath));
  const serverCmd = underBunRuntime ? [process.execPath, import.meta.path] : [process.execPath];

  const child = Bun.spawn(serverCmd, {
    env: { ...process.env, DVALINCODE_GUI_ROLE: 'server' },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  process.on('exit', () => child.kill());

  // The server prints "…http://localhost:<port>" once it's listening. Keep
  // draining stdout afterwards so the child never blocks on a full pipe.
  let resolveUrl: (url: string) => void;
  const urlPromise = new Promise<string>((resolve) => (resolveUrl = resolve));
  (async () => {
    const decoder = new TextDecoder();
    let buffered: string | null = '';
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk);
      process.stdout.write(text);
      if (buffered !== null) {
        buffered += text;
        const match = buffered.match(/localhost:(\d+)/);
        if (match) {
          resolveUrl(`http://127.0.0.1:${match[1]}`);
          buffered = null;
        }
      }
    }
  })();

  const url = await Promise.race([
    urlPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
  ]);
  if (!url) {
    console.error('dvalincode-gui: embedded server did not start within 30s.');
    child.kill();
    process.exit(1);
  }

  const webview = new Webview(false, { width: 1280, height: 832, hint: 0 /* NONE — resizable */ });
  webview.title = 'DvalinCode';
  webview.navigate(url);
  webview.run(); // blocks the main thread until the window is closed

  // Window closed — the 'exit' handler kills the server child.
  process.exit(0);
}
