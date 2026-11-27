// Builds deck-time as one self-contained page that installs as a desktop app
// from Claude (Install as app). The companion's own code runs in the page:
// Node's modules are swapped for the stand-ins in ./shim, SQLite runs as
// WebAssembly (sql.js), and the real review UI (companion/public) talks to it
// without a network. Output: app/build/deck-time.html
//
//   cd app && npm install && npm run build

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const shim = (f) => path.join(here, 'shim', f);
const must = (text, find, replace) => {
  if (!text.includes(find)) throw new Error(`build: expected to find ${JSON.stringify(find.slice(0, 70))}`);
  return text.split(find).join(replace);
};

// ---------- the companion, bundled for the page ----------

const aliases = {
  'node:fs': shim('fs.js'),
  'node:sqlite': shim('sqlite.js'),
  'node:http': shim('http.js'),
  'node:child_process': shim('child_process.js'),
  'node:os': shim('os.js'),
  'node:url': shim('url.js'),
  'node:crypto': shim('crypto.js'),
  'node:path': shim('path.js'),
  'node:events': 'events',
};
const nodeShims = {
  name: 'node-shims',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => {
      const to = aliases[args.path];
      if (!to) throw new Error(`build: no stand-in for ${args.path} (imported by ${args.importer})`);
      return to.startsWith('/') ? { path: to } : b.resolve(to, { resolveDir: here, kind: args.kind });
    });
    // The Review key raises this app's window instead of a browser's.
    b.onResolve({ filter: /\/window\.js$/ }, (args) => (args.importer.includes(`${path.sep}companion${path.sep}`) ? { path: shim('window.js') } : undefined));
  },
};

export async function bundleBackend() {
  const out = await esbuild.build({
    entryPoints: [path.join(here, 'backend.js')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'DeckBackend',
    platform: 'browser',
    target: 'es2022',
    plugins: [nodeShims],
    inject: [shim('process.js'), shim('buffer.js'), shim('fetch.js')],
    define: { 'import.meta.url': '"file:///app/companion/src/module.js"' },
    legalComments: 'none',
    logLevel: 'warning',
  });
  // Wrapped in a function: the companion's modules read the environment as they
  // load, so they must load only after boot.js has set it up.
  return `window.__loadDeckBackend = () => {\n${out.outputFiles[0].text}\nreturn DeckBackend;\n};`;
}

async function bundleSqlJs() {
  // sql.js's own browser build defines window.initSqlJs.
  const sqljs = fs.readFileSync(path.join(here, 'node_modules/sql.js/dist/sql-wasm.js'), 'utf8');
  const fsBoot = await esbuild.build({
    stdin: { contents: "import { preload, probe } from './shim/fs.js'; window.__deckFs = { preload, probe };", resolveDir: here },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
  });
  const wasm = fs.readFileSync(path.join(here, 'node_modules/sql.js/dist/sql-wasm.wasm')).toString('base64');
  return `${sqljs}\n${fsBoot.outputFiles[0].text}\nwindow.__sqlWasm = "${wasm}";`;
}

// ---------- page ----------

async function buildPage() {
  const html = read('companion/public/index.html');
  let css = read('companion/public/styles.css');
  let app = read('companion/public/app.js');

  let body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));
  // Settings: "Use as an app" (browser install tips) becomes this app's own section.
  body = body.replace(/<div class="grid-form install-tip">[\s\S]*?<\/div>\n/, '<div class="grid-form" id="desktop-settings"></div>\n');
  if (!body.includes('id="desktop-settings"')) throw new Error('build: install tips not replaced');
  body = must(body, 'Mirrors the Stream Deck. Click a key to use it; drag to rearrange. Keys 1–8 on the keyboard work too.', 'Click a key to use it; drag to rearrange. Keys 1–8 work in this window, and Control+Shift+1–8 from any app.');
  body = must(body, ' Keys marked with a dot are set in the Stream Deck app; put a deck-time Key action on them to arrange them from here.', '');

  // confirm() opens nothing in an artifact; ask in the page instead.
  app = app.replace(/!confirm\(/g, '!await window.deckApp.confirm(');
  // Exports are saved to disk by the companion (and a copy to Downloads) rather than downloaded by the browser.
  app = must(
    app,
    `  const blob = new Blob([out.body], { type: 'text/plain' });`,
    `  if (window.deckApp?.exported) { await window.deckApp.exported(out); return; }\n  const blob = new Blob([out.body], { type: 'text/plain' });`,
  );
  // Browser storage can be missing in an artifact.
  app = app.replace("if (t === 'auto') localStorage.removeItem('deck-time-theme');\n    else localStorage.setItem('deck-time-theme', t);", "try { if (t === 'auto') localStorage.removeItem('deck-time-theme');\n    else localStorage.setItem('deck-time-theme', t); } catch {}");

  const [backend, sqljs] = await Promise.all([bundleBackend(), bundleSqlJs()]);
  const shell = fs.readFileSync(path.join(here, 'shell.html'), 'utf8');
  const shellCss = fs.readFileSync(path.join(here, 'shell.css'), 'utf8');
  const boot = fs.readFileSync(path.join(here, 'boot.js'), 'utf8');

  const page = `<title>deck-time</title>
<meta name="description" content="Matter timers, instant billing narratives and Intapp Time export, running on this computer.">
<meta name="claude:viewport-fit-sides" content="cover">
<script type="application/json" id="claude-artifacts-manifest">{"permissions": ["full-access", "menu-bar", "shortcuts", "notifications"]}</script>
<style>
${css}
${shellCss}
</style>
${shell}
<div id="app-root" hidden>
${body}
</div>
<script>
${sqljs}
</script>
<script>
${backend}
</script>
<script>
${boot}
</script>
<script type="module">
${app}
</script>
`;
  const out = path.join(here, 'build', 'deck-time.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);
  console.log(`wrote ${path.relative(root, out)} (${(page.length / 1024).toFixed(0)} KB)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPage();
