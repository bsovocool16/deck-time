// Bring the deck-time page forward when you press Review on the Stream Deck,
// in whatever browser or installed web app you already have it open in,
// instead of opening a new window in your default browser.
//
// Pages say how they're running when they connect (installed app or tab, and
// which browser). Raising a window is the operating system's job:
// - macOS: `open -b <bundle id>` activates an app without opening anything new.
//   An installed web app (Safari "Add to Dock", Chrome/Edge "Install") is found
//   by the deck-time address in its Info.plist.
// - Windows: activate the window whose title mentions deck-time.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSERS = {
  safari: 'com.apple.Safari',
  firefox: 'org.mozilla.firefox',
  chrome: 'com.google.Chrome',
  edge: 'com.microsoft.edgemac',
  brave: 'com.brave.Browser',
  arc: 'company.thebrowser.Browser',
};

/** Which browser a page is running in, from its user agent. */
export function browserOf(ua = '') {
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return '';
}

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout))));

/** Installed web apps (macOS) whose start address is deck-time's. Returns bundle ids. */
export async function findWebApps(origin, dirs = defaultAppDirs()) {
  const hosts = new Set([origin, origin.replace('127.0.0.1', 'localhost'), origin.replace('localhost', '127.0.0.1')]);
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith('.app'))) {
      const plist = path.join(dir, name, 'Contents', 'Info.plist');
      if (!fs.existsSync(plist)) continue;
      const json = await run('plutil', ['-convert', 'json', '-o', '-', plist]);
      if (!json) continue;
      try {
        const info = JSON.parse(json);
        const text = JSON.stringify(info); // plutil escapes slashes; re-serialize to match plain URLs
        if ([...hosts].some((h) => text.includes(h)) && info.CFBundleIdentifier) found.push(info.CFBundleIdentifier);
      } catch {
        // not a plist we can read
      }
    }
  }
  return found;
}

// Looking costs a plutil call per app, so remember the answer for a few minutes.
let cache = { origin: '', at: 0, apps: [] };
async function cachedWebApps(origin) {
  if (cache.origin !== origin || Date.now() - cache.at > 5 * 60_000) cache = { origin, at: Date.now(), apps: await findWebApps(origin) };
  return cache.apps;
}

function defaultAppDirs() {
  const home = os.homedir();
  return [path.join(home, 'Applications'), path.join(home, 'Applications', 'Chrome Apps.localized'), path.join(home, 'Applications', 'Edge Apps.localized')]; // where browsers install web apps
}

/**
 * Raise the app showing deck-time. page: { display: 'standalone' | 'browser', browser } of the
 * most recent page, or null if none is open. Returns true if something was raised or opened.
 */
export async function raise(page, origin) {
  if (process.platform === 'darwin') {
    if (!page || page.display === 'standalone') {
      // An installed web app: raise it if open, or launch it (rather than a browser tab) if not.
      const [app] = await cachedWebApps(origin);
      if (app && (await run('open', ['-b', app])) !== null) return true;
      if (!page) return false;
    }
    const bundle = BROWSERS[page.browser];
    return !!bundle && (await run('open', ['-b', bundle])) !== null;
  }
  if (process.platform === 'win32' && page) {
    const ps =
      "$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*deck-time*' } | Select-Object -First 1; " +
      "if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null; 'ok' }";
    return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]))?.includes('ok') ?? false;
  }
  return false;
}
