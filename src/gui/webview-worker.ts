// Webview thread for the desktop GUI. webview.run() is a blocking FFI call for
// the lifetime of the window, so it must not share a thread with the embedded
// HTTP server — with both on one thread the server's event loop never runs and
// the window stays blank. The main thread (src/gui/index.ts) runs the server;
// this worker runs the window. This is the split webview-bun documents for
// running a web server alongside a webview.
import { Webview } from 'webview-bun';

declare var self: Worker;

self.onmessage = (event: MessageEvent<{ url: string }>) => {
  const webview = new Webview(false, { width: 1280, height: 832, hint: 0 /* NONE — resizable */ });
  webview.title = 'DvalinCode';
  webview.navigate(event.data.url);
  webview.run(); // blocks this thread until the window is closed
  self.postMessage('closed');
};
