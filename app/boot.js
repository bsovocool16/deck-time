// Starts deck-time inside the page.
//
// In the installed desktop app (with full access) the companion keeps its data
// in a folder on this computer, runs whisper.cpp / Ollama there, and the app
// adds a menu bar timer, global shortcuts and notifications. Anywhere else
// (a browser, Claude's artifact panel) it offers to install, or runs a
// try-it copy in memory with the fictional demo matters.
//
// The review UI (companion/public/app.js) is unchanged: its fetch('/api/...')
// and EventSource('/api/events') are answered here by the companion itself.
{
  const $ = (s) => document.querySelector(s);
  const rt = (window.__deckRuntime ??= {});
  const APP_HOME = { win32: 'AppData/Roaming/deck-time-app', other: '.deck-time-app' };
  const FULL_HOME = { win32: 'AppData/Roaming/deck-time', other: '.deck-time' };
  const IMPORT_FILES = ['deck-time.db', 'config.json', 'corrections.jsonl', 'code-memory.jsonl', 'teacher.json'];
  const EXTRA_PERMS = ['menu-bar', 'shortcuts', 'notifications'];

  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => ((resolveReady = res), (rejectReady = rej)));
  ready.catch(() => {});
  let desktop = null; // the desktop API, in the installed app
  let mode = null; // 'local' | 'try'
  let homeShown = '';
  let downloadsDir = '';

  // ---------- the API, answered in the page ----------

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, init);
    const server = await ready;
    const r = await server.request((init.method || 'GET').toUpperCase(), url, init.body ? String(init.body) : '');
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };

  class LocalEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.onmessage = this.onerror = this.onopen = null;
      let buf = '';
      ready.then((server) => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.close = ((close) => () => {
          this.readyState = 2;
          close();
        })(
          server.subscribe(url, (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let type = 'message';
              const data = [];
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) type = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              }
              const ev = new MessageEvent(type, { data: data.join('\n') });
              if (type === 'message') this.onmessage?.(ev);
              this.dispatchEvent(ev);
            }
          }),
        );
      });
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = LocalEventSource;

  const api = async (path, method = 'GET', body) => {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  };

  // ---------- shell screens ----------

  const show = (screen) => {
    $('#shell').hidden = false;
    $('#shell').dataset.screen = screen;
  };
  const fail = (e) => {
    console.error(e);
    $('#shell-error').textContent = String(e?.message || e);
    show('error');
    rejectReady(e);
  };
  const reveal = () => {
    $('#shell').hidden = true;
    $('#app-root').hidden = false;
  };

  // ---------- in-page dialogs (confirm() opens nothing here) ----------

  function ask(message) {
    return new Promise((resolve) => {
      $('#ask-text').textContent = message;
      $('#ask').hidden = false;
      const done = (v) => {
        $('#ask').hidden = true;
        $('#ask-yes').onclick = $('#ask-no').onclick = null;
        document.removeEventListener('keydown', key, true);
        resolve(v);
      };
      const key = (ev) => {
        if (ev.key === 'Escape') (ev.preventDefault(), done(false));
        if (ev.key === 'Enter') (ev.preventDefault(), done(true));
      };
      $('#ask-yes').onclick = () => done(true);
      $('#ask-no').onclick = () => done(false);
      document.addEventListener('keydown', key, true);
      $('#ask-yes').focus();
    });
  }

  let savedTimer;
  function savedNotice(title, where, onShow) {
    $('#saved-title').textContent = title;
    $('#saved-path').textContent = where;
    $('#saved-show').hidden = !onShow;
    $('#saved-show').onclick = onShow;
    $('#saved').hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('#saved').hidden = true), 12000);
  }
  $('#saved-close').onclick = () => ($('#saved').hidden = true);

  const tidy = (p) => (rt.homedir && p.startsWith(rt.homedir) ? `~${p.slice(rt.homedir.length)}` : p);

  async function exported(out) {
    const n = `${out.count} entr${out.count === 1 ? 'y' : 'ies'}`;
    if (mode === 'local' || mode === 'client') {
      const copy = `${downloadsDir}/${out.filename}`;
      let where = out.savedTo;
      try {
        if (await desktop.fs.exists(downloadsDir)) {
          await desktop.fs.writeFile(copy, out.body, 'utf8');
          where = copy;
        }
      } catch (e) {
        console.error(e);
      }
      return savedNotice(`Exported ${n}`, tidy(where), () => desktop.shell.showItemInFolder(where).catch(() => {}));
    }
    const downloads = await window.claude?.use?.('downloads').catch(() => null);
    if (downloads) {
      try {
        await downloads.save({ filename: out.filename, data: out.body });
        return savedNotice(`Exported ${n}`, out.filename);
      } catch (e) {
        if (e?.code === 'cancelled' || /cancel|declin/i.test(e?.message ?? '')) return;
      }
    }
    savedNotice(`Exported ${n}`, 'Install the app to save .TIM files to your computer.');
  }

  window.deckApp = { confirm: ask, exported };

  // ---------- icon ----------

  function drawIcon(size = 256, { template = false } = {}) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const s = size / 256;
    const rr = (x, y, w, h, r) => {
      g.beginPath();
      g.roundRect(x * s, y * s, w * s, h * s, r * s);
    };
    if (template) {
      g.fillStyle = '#000';
      [[28, 28], [140, 28], [28, 140], [140, 140]].forEach(([x, y], i) => {
        rr(x, y, 88, 88, 18);
        if (i === 0) g.fill();
        else {
          g.lineWidth = 16 * s;
          g.strokeStyle = '#000';
          rr(x + 8, y + 8, 72, 72, 12);
          g.stroke();
        }
      });
      return c.toDataURL('image/png');
    }
    const bg = g.createLinearGradient(0, 0, 0, size);
    bg.addColorStop(0, '#2a2a27');
    bg.addColorStop(1, '#111110');
    g.fillStyle = bg;
    rr(8, 8, 240, 240, 54);
    g.fill();
    const keys = [
      { x: 40, y: 40, live: true, color: '#3fa36f' },
      { x: 136, y: 40, color: '#2f5d8a' },
      { x: 40, y: 136, color: '#b5623a' },
      { x: 136, y: 136, color: '#8a6fb5' },
    ];
    for (const k of keys) {
      g.fillStyle = k.live ? '#f2f2ef' : '#0b0b0b';
      rr(k.x, k.y, 80, 80, 16);
      g.fill();
      g.fillStyle = k.color;
      rr(k.x + 14, k.y + 16, 22, 7, 3);
      g.fill();
      if (k.live) {
        g.strokeStyle = '#151514';
        g.lineWidth = 7 * s;
        g.lineCap = 'round';
        g.beginPath();
        g.arc((k.x + 40) * s, (k.y + 48) * s, 17 * s, -Math.PI / 2, Math.PI * 0.9);
        g.stroke();
        g.beginPath();
        g.moveTo((k.x + 40) * s, (k.y + 48) * s);
        g.lineTo((k.x + 40) * s, (k.y + 38) * s);
        g.stroke();
      } else {
        g.fillStyle = '#3a3a36';
        rr(k.x + 14, k.y + 50, 40, 6, 3);
        g.fill();
      }
    }
    return c.toDataURL('image/png');
  }
  const paintShellIcon = () => {
    const c = $('#shell-icon');
    const img = new Image();
    img.onload = () => c.getContext('2d').drawImage(img, 0, 0, 256, 256);
    img.src = drawIcon(256);
  };

  // ---------- start ----------

  async function startBackend(home) {
    if (!rt.SQL) {
      const bin = Uint8Array.from(atob(window.__sqlWasm), (ch) => ch.charCodeAt(0));
      rt.SQL = await window.initSqlJs({ wasmBinary: bin });
    }
    const B = window.__loadDeckBackend();
    const { server } = await B.start({ home });
    return server;
  }

  async function bootTry() {
    mode = 'try';
    show('loading');
    try {
      Object.assign(rt, {
        disk: null,
        platform: /Win/.test(navigator.platform) ? 'win32' : 'darwin',
        homedir: '/try',
        tmpdir: '/try/tmp',
        env: { DECK_TIME_HOME: '/try/deck-time', PATH: '' },
        onPersistError: console.error,
      });
      const server = await startBackend('/try/deck-time');
      resolveReady(server);
      // Fictional matters; demo day is the app's own way of showing it without client names.
      await api('/api/workspace', 'POST', { workspace: 'demo' });
      $('#try-bar').hidden = false;
      document.documentElement.classList.add('is-try');
      reveal();
      desktopSettings();
    } catch (e) {
      fail(e);
    }
  }

  async function shellPath(platform) {
    const fallback = platform === 'win32' ? '' : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    try {
      const r = platform === 'win32' ? await desktop.childProcess.exec('echo %PATH%', { timeout: 5000 }) : await desktop.childProcess.exec("/bin/zsh -lc 'printf %s \"$PATH\"'", { timeout: 5000 });
      const got = r.stdout.trim();
      if (platform === 'win32') return got || fallback;
      const parts = new Set(got.split(':').filter(Boolean));
      for (const d of fallback.split(':')) parts.add(d);
      return [...parts].join(':');
    } catch {
      return fallback;
    }
  }

  // ---------- client mode: a window onto the deck-time the Stream Deck plugin runs ----------
  //
  // The Stream Deck plugin runs the companion itself (or uses `npm start`) and
  // talks to it at 127.0.0.1:7331. A page can't open a port, and its own fetch
  // can't reach localhost, so the app reaches that companion through curl,
  // which the desktop API can run. Same data (~/.deck-time), same live state,
  // so the physical keys and this window stay in step.
  const COMPANION = 'http://127.0.0.1:7331';
  const curlBin = () => (rt.platform === 'win32' ? 'curl.exe' : 'curl');

  function curl(args, input) {
    return new Promise((resolve, reject) => {
      const p = desktop.childProcess.spawn(curlBin(), args, {});
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `curl exited ${code}`))));
      if (input != null) p.stdin.write(input).then(() => p.stdin.end()).catch(() => {});
      else p.stdin.end().catch(() => {});
    });
  }

  const companionUp = () =>
    curl(['-s', '-o', rt.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code}', '-m', '2', `${COMPANION}/api/state`]).then(
      (code) => code.trim() === '200',
      () => false,
    );

  function clientServer() {
    return {
      async request(method, url, body) {
        const args = ['-s', '-S', '-X', method, '-H', 'Content-Type: application/json', '-w', '\n%{http_code}', '-m', '600'];
        if (body) args.push('--data-binary', '@-');
        args.push(COMPANION + url);
        try {
          const out = await curl(args, body || null);
          const cut = out.lastIndexOf('\n');
          return { status: +out.slice(cut + 1) || 502, body: out.slice(0, cut) };
        } catch (e) {
          return { status: 502, body: JSON.stringify({ error: 'deck-time is not running. Open the Stream Deck app (or npm start) and try again.' }) };
        }
      },
      subscribe(url, onChunk) {
        let closed = false;
        let proc = null;
        let down = 0;
        const open = () => {
          if (closed) return;
          proc = desktop.childProcess.spawn(curlBin(), ['-s', '-N', `${COMPANION}${url}`], {});
          proc.stdout.on('data', (d) => {
            down = 0;
            setLink(true);
            // The Review key: bring this window forward.
            if (d.includes('event: show')) desktop.window.show().catch(() => {});
            onChunk(d);
          });
          proc.on('error', () => {});
          proc.on('exit', () => {
            if (closed) return;
            if (++down > 1) setLink(false);
            setTimeout(open, Math.min(1000 * down, 5000));
          });
        };
        open();
        return () => {
          closed = true;
          proc?.kill().catch(() => {});
        };
      },
    };
  }

  function setLink(up) {
    const bar = $('#link-bar');
    if (bar) bar.hidden = up;
  }

  async function bootClient({ fullHome }) {
    mode = 'client';
    rt.env = { ...rt.env, DECK_TIME_HOME: fullHome };
    homeShown = rt.platform === 'win32' ? '%APPDATA%\\deck-time' : '~/.deck-time';
    resolveReady(clientServer());
    reveal();
    afterStart(rt.homeApp);
  }

  function waitForCompanion(fullHome) {
    show('waiting');
    $('#shell-standalone').onclick = async () => {
      prefs.standalone = true;
      await savePrefsTo(rt.homeApp);
      location.reload();
    };
    const tick = async () => {
      if (mode) return;
      if (await companionUp()) return bootClient({ fullHome });
      setTimeout(tick, 2000);
    };
    tick();
  }

  async function bootLocal() {
    show('loading');
    try {
      const platform = await desktop.os.platform();
      const info = await desktop.os.info();
      const homedir = info.homedir.replace(/\\/g, '/');
      const key = platform === 'win32' ? 'win32' : 'other';
      const home = `${homedir}/${APP_HOME[key]}`;
      const fullHome = `${homedir}/${FULL_HOME[key]}`;
      downloadsDir = `${homedir}/Downloads`;
      homeShown = platform === 'win32' ? `%APPDATA%\\deck-time-app` : `~/${APP_HOME.other}`;
      const PATH = await shellPath(platform);
      Object.assign(rt, {
        disk: desktop,
        platform,
        homedir,
        tmpdir: info.tmpdir.replace(/\\/g, '/'),
        env: { HOME: homedir, PATH, TMPDIR: info.tmpdir, DECK_TIME_HOME: home, ...(platform === 'win32' ? { APPDATA: `${homedir}/AppData/Roaming`, USERPROFILE: info.homedir, SystemRoot: 'C:\\Windows' } : {}) },
        onPersistError: (e) => {
          console.error(e);
          window.dispatchEvent(new CustomEvent('deck-persist-error', { detail: e }));
        },
        showWindow: () => desktop.window.show(),
        homeApp: home,
      });
      prefs = { ...PREFS, ...(await desktop.fs.readFile(`${home}/app.json`, 'utf8').then(JSON.parse).catch(() => ({}))) };
      if (!prefs.standalone) {
        if (await companionUp()) return bootClient({ fullHome });
        // deck-time is set up here (Stream Deck plugin or npm start) but not running yet.
        if (await desktop.fs.exists(`${fullHome}/deck-time.db`)) return waitForCompanion(fullHome);
      }
      mode = 'local';

      await desktop.fs.mkdir(home, { recursive: true });
      const fresh = !(await desktop.fs.exists(`${home}/deck-time.db`));
      if (fresh && (await desktop.fs.exists(`${fullHome}/deck-time.db`))) await offerImport(home, fullHome);
      // A Whisper model already downloaded for the full edition is used where it is.
      if (!(await desktop.fs.exists(`${home}/config.json`))) {
        const model = `${fullHome}/models/whisper/ggml-small.en.bin`;
        if (await desktop.fs.exists(model)) await desktop.fs.writeFile(`${home}/config.json`, JSON.stringify({ dictation: { model } }, null, 2), 'utf8');
      }

      const fs = window.__deckFs;
      await fs.preload(home);
      // Checked while the companion's modules load: where whisper.cpp and sox might be.
      const bins = ['whisper-cli', 'rec', 'sox'].flatMap((b) => (platform === 'win32' ? [`${b}.exe`, `${b}.cmd`, `${b}.bat`, b] : [b]));
      const dirs = [...new Set([...PATH.split(platform === 'win32' ? ';' : ':'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean))];
      await fs.probe([...dirs.flatMap((d) => bins.map((b) => `${d.replace(/\\/g, '/')}/${b}`)), `${home}/whisper/whisper-cli.exe`, `${home}/models/whisper/ggml-small.en.bin`]);

      const server = await startBackend(home);
      resolveReady(server);
      reveal();
      afterStart(home);
    } catch (e) {
      fail(e);
    }
  }

  function offerImport(home, fullHome) {
    return new Promise(async (resolve) => {
      $('#shell-full-home').textContent = rt.platform === 'win32' ? '%APPDATA%\\deck-time' : '~/.deck-time';
      const wal = await desktop.fs.stat(`${fullHome}/deck-time.db-wal`).catch(() => null);
      $('#shell-import-warn').hidden = !(wal?.size > 0);
      show('import');
      $('#shell-fresh').onclick = () => resolve();
      $('#shell-import').onclick = async () => {
        $('#shell-import').disabled = true;
        try {
          for (const f of IMPORT_FILES) {
            if (await desktop.fs.exists(`${fullHome}/${f}`)) await desktop.fs.copyFile(`${fullHome}/${f}`, `${home}/${f}`);
          }
          // The copy is a fresh start for the app: open in your own matters, not demo day.
          const cfg = await desktop.fs.readFile(`${home}/config.json`, 'utf8').then(JSON.parse).catch(() => null);
          if (cfg) await desktop.fs.writeFile(`${home}/config.json`, JSON.stringify({ ...cfg, workspace: 'real' }, null, 2), 'utf8');
        } catch (e) {
          console.error(e);
        }
        show('loading');
        resolve();
      };
    });
  }

  // ---------- desktop touches: icon, window, menu bar, shortcuts, notifications ----------

  const PREFS = { tray: true, shortcuts: true, notifications: true };
  let prefs = { ...PREFS };
  let prefsFile = '';
  let latest = null; // the companion's state, every second
  const perm = async (name) => (desktop?.permissions ? desktop.permissions.state(name).catch(() => 'unavailable') : 'unavailable');

  async function afterStart(home) {
    prefsFile = `${rt.homeApp ?? home}/app.json`;
    prefs = { ...PREFS, ...(await desktop.fs.readFile(prefsFile, 'utf8').then(JSON.parse).catch(() => ({}))) };
    document.documentElement.classList.add('is-app', `is-${rt.platform === 'win32' ? 'win' : 'mac'}`);
    window.addEventListener('pagehide', () => rt.saveAll?.());
    window.addEventListener('beforeunload', () => rt.saveAll?.());
    window.addEventListener('deck-persist-error', (ev) => savedNotice("Couldn't save to disk", String(ev.detail?.message ?? ev.detail)));
    if (!prefs.placed) {
      prefs.placed = true;
      savePrefs();
      desktop.window.place({ anchor: 'center', width: 1280, height: 880 }).catch(() => {});
    }
    // Live state for the menu bar and notifications.
    let buf = '';
    (await ready).subscribe('/api/events', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!block.startsWith('data:')) continue;
        try {
          latest = JSON.parse(block.slice(5));
          onState(latest);
        } catch {}
      }
    });
    await applyExtras();
    desktopSettings();
  }

  const savePrefs = () => desktop.fs.writeFile(prefsFile, JSON.stringify(prefs, null, 2), 'utf8').catch(() => {});
  const savePrefsTo = (home) => desktop.fs.mkdir(home, { recursive: true }).then(() => desktop.fs.writeFile(`${home}/app.json`, JSON.stringify(prefs, null, 2), 'utf8')).catch(() => {});

  async function applyExtras() {
    if (prefs.tray && (await perm('menu-bar')) === 'granted') {
      trayOn = true;
      lastTray = '';
      onState(latest);
    } else {
      trayOn = false;
      desktop.tray.remove().catch(() => {});
    }
    await desktop.globalShortcut.unregisterAll().catch(() => {});
    if (prefs.shortcuts && (await perm('shortcuts')) === 'granted') {
      for (let n = 1; n <= 8; n++) desktop.globalShortcut.register(`Control+Shift+${n}`, () => pressKey(n - 1)).catch(() => {});
    }
  }

  const clockText = (ms) => {
    const m = Math.floor(ms / 60000);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  };
  const keyMatter = (s) => (s.kind === 'matter' ? latest?.matters.find((m) => m.id === s.matter_id) : null);

  /** One key of the deck, as the Stream Deck would press it. */
  async function pressKey(slot) {
    const s = latest?.deck?.[slot];
    if (!s) return;
    try {
      if (s.kind === 'matter') await api('/api/timer/toggle', 'POST', { matter_id: s.matter_id });
      else if (s.kind === 'dictate') await api('/api/dictation/toggle', 'POST');
      else if (s.kind === 'next-task') await api('/api/timer/next-task', 'POST', {});
      else if (s.kind === 'stop') await api('/api/timer/stop', 'POST');
      else if (s.kind === 'review') await api('/api/app/show', 'POST', { view: 'review' });
    } catch (e) {
      if (prefs.notifications && (await perm('notifications')) === 'granted') desktop.notification.show({ body: e.message.slice(0, 300) }).catch(() => {});
    }
  }

  let trayOn = false;
  let lastTray = '';
  let trayIcon = '';
  let askedOvernight = null;
  function onState(st) {
    if (!st) return;
    if (trayOn) {
      const run = st.running;
      const m = run ? st.matters.find((x) => x.id === run.matter_id) : null;
      const title = run ? `${(m?.label || m?.name || 'Timer').slice(0, 18)} ${clockText(st.now - run.start_ms)}` : '';
      const deckSig = JSON.stringify([st.deck, st.matters.map((x) => [x.id, x.label, x.name]), run?.matter_id, st.dictation?.status]);
      const sig = title + deckSig;
      if (sig !== lastTray) {
        lastTray = sig;
        trayIcon ||= drawIcon(36, { template: true });
        const items = st.deck
          .map((s, i) => {
            const km = keyMatter(s);
            if (km) return { label: `${i + 1}  ${km.label || km.name}`, type: 'checkbox', checked: run?.matter_id === km.id, click: () => pressKey(i) };
            return null;
          })
          .filter(Boolean);
        desktop.tray
          .set({
            icon: trayIcon,
            title,
            toolTip: run ? `${m?.name ?? ''}, running ${clockText(st.now - run.start_ms)}. Today ${st.total_hours.toFixed(1)} h` : `Today ${st.total_hours.toFixed(1)} h`,
            menu: [
              ...(items.length ? items : [{ label: 'No matters on keys yet', enabled: false }]),
              { type: 'separator' },
              { label: 'Next task', enabled: !!run, click: () => api('/api/timer/next-task', 'POST', {}).catch(() => {}) },
              { label: st.dictation?.status === 'recording' ? 'Stop dictating' : 'Dictate', enabled: !!run && !!st.dictation && !st.dictation.missing, click: () => api('/api/dictation/toggle', 'POST').catch(() => {}) },
              { label: 'Stop timer', enabled: !!run, click: () => api('/api/timer/stop', 'POST').catch(() => {}) },
              { type: 'separator' },
              { label: 'Show deck-time', click: () => desktop.window.show().catch(() => {}) },
            ],
          })
          .catch(() => {});
      }
    }
    // A timer from last night: the page asks; nudge too if the window is out of sight.
    const on = st.overnight?.segment_id ?? st.overnight?.id ?? (st.overnight ? 'yes' : null);
    if (on && on !== askedOvernight && !document.hasFocus() && prefs.notifications) {
      askedOvernight = on;
      perm('notifications').then((p) => p === 'granted' && desktop.notification.show({ body: 'A deck-time timer ran overnight. Open deck-time to say when you stopped.' }).catch(() => {}));
    }
  }

  // ---------- Settings → This app ----------

  function desktopSettings() {
    const box = $('#desktop-settings');
    if (!box) return;
    if (mode === 'try') {
      box.innerHTML = `<h3>Install as an app</h3><p class="wide">This copy runs in the page and forgets everything when you close it. Installed from the Claude desktop app, deck-time keeps your time in a folder on your computer, shows the running timer in the menu bar, and takes keyboard shortcuts from any app.</p><div class="wide"><button type="button" class="primary" id="ds-install" hidden>Install as app</button></div>`;
      wireInstall($('#ds-install'));
      return;
    }
    box.innerHTML = `
      <h3>This app</h3>
      <div class="wide ds-row"><span>Your matters, time and settings are in <code id="ds-home"></code>. Exports go there and to Downloads.</span><button type="button" id="ds-folder">Show folder</button></div>
      <label class="check wide"><input type="checkbox" id="ds-deck"> Work with the Stream Deck: use the deck-time the Stream Deck app runs, and its data in <code>${rt.platform === 'win32' ? '%APPDATA%\\deck-time' : '~/.deck-time'}</code></label>
      <p class="wide settings-note">${mode === 'client' ? 'Connected. The physical keys and this window show the same timers. Dictation and the teacher follow that deck-time: set "edition": "full" in its config.json to turn them on there.' : 'Off: this app keeps its own data and the Stream Deck keys don\'t reach it.'}</p>
      <label class="check wide"><input type="checkbox" id="ds-tray"> Show the running timer in the ${rt.platform === 'win32' ? 'system tray' : 'menu bar'}</label>
      <label class="check wide"><input type="checkbox" id="ds-shortcuts"> Keyboard shortcuts from any app: <kbd>Control</kbd>+<kbd>Shift</kbd>+<kbd>1</kbd> to <kbd>8</kbd> press keys 1 to 8</label>
      <label class="check wide"><input type="checkbox" id="ds-notify"> Notify me when a timer ran overnight</label>
      <p class="wide settings-note" id="ds-perm-note" hidden></p>
      <div class="wide"><button type="button" id="ds-manage" class="quiet">App permissions…</button></div>`;
    $('#ds-home').textContent = homeShown;
    $('#ds-deck').checked = !prefs.standalone;
    $('#ds-deck').onchange = async () => {
      prefs.standalone = !$('#ds-deck').checked;
      await savePrefsTo(rt.homeApp);
      location.reload();
    };
    $('#ds-folder').onclick = () => desktop.shell.openPath(rt.env.DECK_TIME_HOME).catch(() => desktop.shell.showItemInFolder(`${rt.env.DECK_TIME_HOME}/config.json`).catch(() => {}));
    $('#ds-manage').onclick = () => desktop.permissions.manage().then(() => applyExtras().then(desktopSettings)).catch(() => {});
    const wire = (id, key, permName) => {
      const el = $(id);
      el.checked = !!prefs[key];
      el.onchange = async () => {
        prefs[key] = el.checked;
        savePrefs();
        if (el.checked && (await perm(permName)) === 'prompt') await desktop.permissions.request([permName]).catch(() => {});
        await applyExtras();
        note();
      };
    };
    wire('#ds-tray', 'tray', 'menu-bar');
    wire('#ds-shortcuts', 'shortcuts', 'shortcuts');
    wire('#ds-notify', 'notifications', 'notifications');
    const note = async () => {
      const off = [];
      for (const [k, p, label] of [['tray', 'menu-bar', 'the menu bar timer'], ['shortcuts', 'shortcuts', 'shortcuts'], ['notifications', 'notifications', 'notifications']]) {
        if (prefs[k] && ['denied', 'unavailable'].includes(await perm(p))) off.push(label);
      }
      $('#ds-perm-note').hidden = !off.length;
      $('#ds-perm-note').textContent = off.length ? `Not allowed for this app yet: ${off.join(', ')}. Use App permissions to turn them on.` : '';
    };
    note();
  }

  async function wireInstall(btn) {
    const state = await desktop?.install?.state().catch(() => 'unavailable');
    if (!btn) return state;
    btn.hidden = state !== 'available';
    btn.onclick = () => desktop.install.request().catch(console.error);
    return state;
  }

  // ---------- which screen ----------

  async function main() {
    paintShellIcon();
    $('#shell-try').onclick = bootTry;
    $('#shell-try-2').onclick = bootTry;
    $('#try-install').onclick = () => desktop?.install?.request().catch(console.error);
    $('#shell-retry').onclick = () => location.reload();

    desktop = (await window.claude?.use?.('desktop').catch(() => null)) ?? null;
    if (!desktop?.fs) {
      const state = await wireInstall($('#shell-install'));
      $('#try-install').hidden = state !== 'available';
      if (state === 'installed') $('#shell-install-note').textContent = 'deck-time is installed on this computer: open it from your Dock, Launchpad or Start menu. Trying it here uses fictional matters, and nothing is saved.';
      else if (state !== 'available') $('#shell-install-note').textContent = 'To install it as an app, open this page in the Claude desktop app and choose Install as app. Trying it here uses fictional matters, and nothing is saved.';
      return show('welcome');
    }

    desktop.app.dock.setIcon(drawIcon(256)).catch(() => {});
    const platform = await desktop.os.platform().catch(() => 'darwin');
    if (platform === 'darwin') {
      // Set once; the same options every load, or the window would rebuild forever.
      const want = { titleBarStyle: 'hiddenInset', minWidth: 760, minHeight: 560 };
      desktop.window
        .getOptions()
        .then(({ applied }) => {
          if (Object.entries(want).some(([k, v]) => applied?.[k] !== v)) {
            let last = 0;
            try {
              last = +sessionStorage.getItem('deck-time-window') || 0;
              sessionStorage.setItem('deck-time-window', String(Date.now()));
            } catch {}
            if (Date.now() - last > 15000) return desktop.window.setOptions(want);
          }
        })
        .catch(() => {});
    }

    const access = await perm('full-access');
    if (access === 'granted') return bootLocal();
    if (access === 'prompt') {
      $('#shell-home').textContent = platform === 'win32' ? '%APPDATA%\\deck-time-app' : '~/.deck-time-app';
      show('allow');
      $('#shell-allow').onclick = async () => {
        $('#shell-allow').disabled = true;
        const got = await desktop.permissions.request(['full-access', ...EXTRA_PERMS]).catch(() => null);
        $('#shell-allow').disabled = false;
        if (got?.['full-access'] === 'granted') bootLocal();
        else show('denied');
      };
      return;
    }
    if (access === 'unavailable') $('#shell-denied-why').textContent = "Full access isn't available for this app right now. If you just installed it, quit and reopen it. Otherwise your organization may not allow it.";
    show('denied');
    $('#shell-manage').onclick = () =>
      desktop.permissions
        .manage()
        .then(async () => ((await perm('full-access')) === 'granted' ? bootLocal() : null))
        .catch(() => {});
  }

  main().catch(fail);
}
