// DvalinCode desktop GUI — a native window over the same engine/server as the
// web GUI and TUI. Starts the embedded server on an ephemeral localhost port
// (no browser), then opens an OS-native webview (WKWebView / WebView2 /
// WebKitGTK via webview-bun) pointed at it. This entry is built only with Bun
// (`bun build --compile`); it is excluded from the tsc build because it imports
// `bun:ffi` transitively. The CLI binary never imports this file, so it stays
// webview-free.
import { Webview } from 'webview-bun';
import { startServer } from '../server/index.js';

const { port } = await startServer({ host: '127.0.0.1', port: 0, open: false });

const webview = new Webview(false, { width: 1280, height: 832, hint: 0 /* NONE — resizable */ });
webview.title = 'DvalinCode';
webview.navigate(`http://127.0.0.1:${port}`);
webview.run();

// run() blocks until the window is closed; then tear everything down.
process.exit(0);
