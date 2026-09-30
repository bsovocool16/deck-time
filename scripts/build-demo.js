// Builds the hosted demo: one self-contained HTML page with the real app's
// markup, styles and script, running against an in-browser mock of the server
// (demo/mock.js), plus a clickable Stream Deck Neo drawn with the plugin's key
// renderer. Output: demo/build/deck-time-demo.html
//
//   node scripts/build-demo.js

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ts = createRequire(path.join(root, 'plugin', 'package.json'))('typescript');

function must(text, find, replace) {
  if (!text.includes(find)) throw new Error(`build-demo: expected to find ${JSON.stringify(find.slice(0, 60))}`);
  return text.replace(find, replace);
}

/** Turn an ES module's source into a scoped block that returns its exports. */
function asModule(name, src, exportsList) {
  const body = src
    .replace(/^import .*$/gm, '')
    .replace(/^export (?=(async )?function|const|class|let)/gm, '');
  return `const ${name} = (() => {\n${body}\nreturn { ${exportsList.join(', ')} };\n})();\n`;
}

/** Pull one top-level function (and anything it needs) out of a source file. */
function extract(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = endMarker ? src.indexOf(endMarker, a) : src.length;
  if (a < 0 || b < 0) throw new Error(`build-demo: couldn't extract ${startMarker}`);
  return src.slice(a, b).replace(/^export /gm, '');
}

// ---------- shared logic from the real app ----------

const time = asModule('T', read('companion/src/time.js'), ['localDate', 'dayBounds', 'isDate', 'roundHours', 'formatDate']);
const codes = asModule('C', read('companion/src/codes.js'), ['ACTIVITY_CODES', 'TASK_SETS', 'codesFor']);
const exporter = asModule(
  'X',
  'const randomUUID = () => crypto.randomUUID();\n' + read('companion/src/export.js'),
  ['exportable', 'toTim', 'toCsv', 'validateForTim', 'parseTim'],
);
const aiSrc = read('companion/src/ai.js');
const split = `const A = (() => {\n${extract(aiSrc, '/**\n * Allocate a total across entries')}\nreturn { normalizeSplit };\n})();\n`;
const storeSrc = read('companion/src/store.js');
const block = `const B = (() => {\n${extract(storeSrc, '/**\n * Heuristic: does a narrative bundle', 'function validateMatter')}\nreturn { looksBlockBilled };\n})();\n`;

// The plugin's key renderer, so the virtual Neo shows exactly what the hardware will.
const renderJs = ts.transpileModule(read('plugin/src/render.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const render = `window.DeckRender = (() => {\n${renderJs.replace(/^export /gm, '')}\nreturn { matterKey, messageKey, stopKey, reviewKey, dictateKey, nextTaskKey, clock };\n})();\n`;

// ---------- page ----------

let html = read('companion/public/index.html');
let css = read('companion/public/styles.css');
let app = read('companion/public/app.js');

// The artifact skeleton supplies doctype/head/body; keep just our content.
const bodyInner = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));

// Dark tokens also apply when the viewer explicitly picks dark.
const darkBlock = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\}\s*\}/);
if (!darkBlock) throw new Error('build-demo: dark token block not found');
css += `\n:root[data-theme="dark"] {${darkBlock[1]}}\n`;

// confirm() is blocked in the artifact frame; use the in-page panel.
app = app.replace(/!confirm\(/g, '!await window.demoConfirm(');
// Exports open in an in-page panel rather than saving a file.
app = must(app, ' (also saved to ${out.savedTo})', '');

const intro = `
  <section class="demo-intro">
    <div class="wrap">
      <span class="eyebrow">Interactive demo</span>
      <div>
        <h1>Timekeeping from a Stream Deck, with your own words turned into billing narratives</h1>
        <p>Tap a matter to start its timer, say what you’re doing, and tap Next task when you switch. At the end of the day the notes become narratives, splits and task codes, exported as a file Intapp Time imports.</p>
        <p class="fine">Everything in the installed app runs on the attorney’s Mac: the timers, speech-to-text and the AI model. In this demo, dictation and AI are simulated, the matters are fictional, and changes stay in this browser tab.</p>
      </div>
      <div class="intro-actions"><button type="button" id="demo-reset">Reset demo</button></div>
    </div>
  </section>`;

const deck = `
      <div class="section-head">
        <h2>Stream Deck Neo</h2>
        <span class="hint">Click the keys. Five matters, Dictate, Next task and Stop, with the running timer on the info bar.</span>
      </div>
      <div class="demo-deck">
        <div class="deck-col">
          <div class="neo" id="neo" aria-label="Stream Deck Neo">
            <div class="neo-keys" id="neo-keys"></div>
            <div class="neo-foot">
              <button type="button" class="neo-touch" tabindex="-1" aria-hidden="true"></button>
              <div class="neo-bar" aria-live="off"><span id="neo-bar-title"></span><span id="neo-bar-value"></span></div>
              <button type="button" class="neo-touch" tabindex="-1" aria-hidden="true"></button>
            </div>
          </div>
          <div class="listen" id="listen" data-state="idle" aria-live="polite">
            <div class="listen-head"><span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span id="listen-label">Dictation</span></div>
            <div id="listen-text">Start a matter, then tap or hold Dictate and talk. Your words land in that matter’s notes, timestamped.</div>
          </div>
        </div>
        <aside class="tryit" aria-label="Try it">
          <div class="tryit-head"><h2>Try it</h2><span id="tryit-count"></span></div>
          <ol id="tryit-list"></ol>
          <span class="hint">Entries below update as you go. Everything is editable: notes, narratives, hours and codes.</span>
        </aside>
      </div>
      <div id="deck" hidden></div>`;

let body = must(bodyInner, '  <header class="topbar">', `${intro}\n  <header class="topbar">`);
body = body.replace(/      <div class="section-head">\s*<h2>Keys<\/h2>[\s\S]*?<div id="deck" class="deck"><\/div>/, deck);
if (!body.includes('id="neo"')) throw new Error('build-demo: keys section not replaced');
body = must(body, '<div id="toast"', '<div class="overlay" id="demo-overlay" hidden></div>\n  <div id="toast"');

const page = `<title>deck-time demo</title>
<meta name="description" content="Interactive demo of deck-time: Stream Deck matter timers, dictation, AI narratives and Intapp .TIM export.">
<style>
${css}
${read('demo/demo.css')}
</style>
${body}
<script>
${render}
(() => {
${time}${codes}${exporter}${split}${block}
${read('demo/mock.js')}
})();
</script>
<script>
${read('demo/neo.js')}
</script>
<script type="module">
${app}
</script>
`;

const out = path.join(root, 'demo', 'build', 'deck-time-demo.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`wrote ${path.relative(root, out)} (${(page.length / 1024).toFixed(0)} KB)`);
