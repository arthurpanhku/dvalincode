// DvalinCode desktop GUI — a native window over the same engine/server as the
// web GUI and TUI. Starts the embedded server on an ephemeral localhost port
// (no browser), then opens an OS-native webview (WKWebView / WebView2 /
// WebKitGTK via webview-bun) pointed at it. This entry is built only with Bun
// (`bun build --compile`, together with webview-worker.ts); it is excluded
// from the tsc build because it imports `bun:ffi` transitively. The CLI binary
// never imports this file, so it stays webview-free.
//
// The server runs here on the main thread; the webview runs in a worker,
// because webview.run() blocks its thread until the window closes and would
// otherwise starve the server's event loop (blank window).
import { startServer } from '../server/index.js';

const { port } = await startServer({ host: '127.0.0.1', port: 0, open: false });

const worker = new Worker(new URL('./webview-worker.ts', import.meta.url).href);
worker.onmessage = () => process.exit(0); // window closed — tear everything down
worker.postMessage({ url: `http://127.0.0.1:${port}` });
