// The macOS menu bar for the desktop window.
//
// webview creates no menu bar, and on macOS the menu bar is what turns ⌘C, ⌘V,
// ⌘X, ⌘A, ⌘Z and ⌘Q into actions: without one those keys do nothing in the
// composer, and the app cannot be quit from the keyboard. Each item sends a
// standard Cocoa action (copy:, terminate:, …) up the responder chain, where
// WKWebView, NSWindow and NSApplication already implement them.

/** `null` is a separator line. */
export type MacMenuItem = { title: string; action: string; key: string } | null;
export type MacMenu = { title: string; items: MacMenuItem[] };

/**
 * `key` is the ⌘ shortcut; an uppercase letter adds ⇧, as Cocoa reads it.
 * ⌘N is left out on purpose: the page uses it for "New chat", so it must reach
 * the page.
 */
export function macMenuBar(appName: string): MacMenu[] {
  return [
    {
      title: appName,
      items: [
        { title: `Hide ${appName}`, action: 'hide:', key: 'h' },
        null,
        { title: `Quit ${appName}`, action: 'terminate:', key: 'q' },
      ],
    },
    {
      title: 'Edit',
      items: [
        { title: 'Undo', action: 'undo:', key: 'z' },
        { title: 'Redo', action: 'redo:', key: 'Z' },
        null,
        { title: 'Cut', action: 'cut:', key: 'x' },
        { title: 'Copy', action: 'copy:', key: 'c' },
        { title: 'Paste', action: 'paste:', key: 'v' },
        { title: 'Select All', action: 'selectAll:', key: 'a' },
      ],
    },
    {
      title: 'Window',
      items: [
        { title: 'Minimize', action: 'performMiniaturize:', key: 'm' },
        { title: 'Close', action: 'performClose:', key: 'w' },
      ],
    },
  ];
}

/**
 * Builds `menus` through the Objective-C runtime and makes them the app's main
 * menu. Call it after the webview exists (creating it sets up NSApp) and before
 * `run()`. Nothing created here is released: the menus live as long as the app.
 */
export async function installMacMenuBar(menus: MacMenu[]): Promise<void> {
  const { dlopen, FFIType } = await import('bun:ffi');
  const { ptr, u64 } = FFIType;
  const libobjc = '/usr/lib/libobjc.A.dylib';
  // Objects and selectors travel as BigInt (u64), not as `ptr`. A short
  // NSString such as @"Copy" is a tagged pointer that uses all 64 bits, more
  // than a JS number holds exactly, and passing a rounded one back crashes.
  const runtime = dlopen(libobjc, {
    objc_getClass: { args: [ptr], returns: u64 },
    sel_registerName: { args: [ptr], returns: u64 },
  }).symbols;
  // objc_msgSend has no fixed signature: each call must use the signature of
  // the method it sends, so it is bound once per signature used below.
  const send0 = dlopen(libobjc, { objc_msgSend: { args: [u64, u64], returns: u64 } }).symbols.objc_msgSend;
  const send1 = dlopen(libobjc, { objc_msgSend: { args: [u64, u64, u64], returns: u64 } }).symbols.objc_msgSend;
  const send3 = dlopen(libobjc, { objc_msgSend: { args: [u64, u64, u64, u64, u64], returns: u64 } }).symbols.objc_msgSend;
  const sendCString = dlopen(libobjc, { objc_msgSend: { args: [u64, u64, ptr], returns: u64 } }).symbols.objc_msgSend;

  const cString = (text: string) => Buffer.from(`${text}\0`);
  const cls = (name: string) => runtime.objc_getClass(cString(name));
  const sel = (name: string) => runtime.sel_registerName(cString(name));
  const nsString = (text: string) =>
    sendCString(send0(cls('NSString'), sel('alloc')), sel('initWithUTF8String:'), cString(text));
  const newMenu = (title: string) => send1(send0(cls('NSMenu'), sel('alloc')), sel('initWithTitle:'), nsString(title));
  const newItem = (title: string, action: string | null, key: string) =>
    send3(
      send0(cls('NSMenuItem'), sel('alloc')),
      sel('initWithTitle:action:keyEquivalent:'),
      nsString(title),
      action === null ? 0n : sel(action),
      nsString(key),
    );

  const menuBar = newMenu('');
  for (const menu of menus) {
    const submenu = newMenu(menu.title);
    for (const item of menu.items) {
      const entry = item === null ? send0(cls('NSMenuItem'), sel('separatorItem')) : newItem(item.title, item.action, item.key);
      send1(submenu, sel('addItem:'), entry);
    }
    const holder = newItem(menu.title, null, '');
    send1(holder, sel('setSubmenu:'), submenu);
    send1(menuBar, sel('addItem:'), holder);
  }
  send1(send0(cls('NSApplication'), sel('sharedApplication')), sel('setMainMenu:'), menuBar);
}
