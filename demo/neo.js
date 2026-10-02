// Demo-only UI: a clickable Stream Deck Neo (drawn with the plugin's own key
// renderer), a live dictation readout, a "Try it" checklist, and in-page
// panels for export and confirmations (the artifact frame blocks downloads
// and confirm()).

(() => {
  const R = window.DeckRender;
  const demo = window.deckDemo;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const post = (path, body = {}) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      return data;
    });

  function flash(msg, isError = true) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(flash.t);
    flash.t = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  // ---------- Neo ----------

  const keysEl = $('#neo-keys');
  const barTitle = $('#neo-bar-title');
  const barValue = $('#neo-bar-value');
  const slots = Array.from({ length: 8 }, (_, i) => {
    const b = document.createElement('button');
    b.className = 'neo-key';
    b.type = 'button';
    b.innerHTML = '<img alt="" draggable="false">';
    keysEl.appendChild(b);
    return b;
  });
  const lastSrc = new Array(8).fill('');

  // Same drawing rules as the plugin's "deck-time Key" action.
  function paint(state) {
    const run = state.running;
    const d = state.dictation;
    state.deck.forEach((s, i) => {
      const m = s.kind === 'matter' ? state.matters.find((x) => x.id === s.matter_id) : null;
      if (m) {
        const live = run?.matter_id === m.id;
        return setKey(i, R.matterKey({ label: m.label || m.name, color: m.color, live, elapsedMs: live ? state.now - run.start_ms : 0, todayMs: m.today_ms }), `Key ${i + 1}: ${m.name}, ${live ? 'running, press to stop' : 'press to start'}`, { matter: m.id, kind: 'matter' });
      }
      if (s.kind === 'dictate') {
        const img = d.status === 'recording' ? R.dictateKey('recording', state.now - d.started_at) : d.status === 'transcribing' ? R.dictateKey('transcribing') : R.dictateKey(run ? 'idle' : 'disabled');
        return setKey(i, img, `Key ${i + 1}: Dictate, tap to start and tap again to stop`, { kind: 'dictate' });
      }
      if (s.kind === 'next-task') return setKey(i, R.nextTaskKey(run ? { active: true, task: run.tasks_today, elapsedMs: state.now - run.start_ms, color: run.matter.color } : { active: false }), `Key ${i + 1}: Next task`, { kind: 'next-task' });
      if (s.kind === 'stop') return setKey(i, R.stopKey(!!run, state.total_hours), `Key ${i + 1}: Stop`, { kind: 'stop' });
      if (s.kind === 'review') return setKey(i, R.reviewKey(), `Key ${i + 1}: Review`, { kind: 'review' });
      setKey(i, R.messageKey('Empty', 'drop a matter'), `Key ${i + 1}: empty`, { kind: 'empty' });
    });

    barTitle.textContent = run ? run.matter.label || run.matter.name : 'No timer running';
    barValue.textContent = run ? R.clock(state.now - run.start_ms) : `${state.total_hours.toFixed(1)}h today`;
    $('#neo').classList.toggle('is-live', !!run);
  }

  function setKey(i, src, label, data) {
    const b = slots[i];
    if (lastSrc[i] !== src) {
      b.firstChild.src = src;
      lastSrc[i] = src;
    }
    b.setAttribute('aria-label', label);
    b.dataset.slot = i; // drop target for the app's sidebar
    b.dataset.matter = data.matter ?? '';
    b.dataset.action = data.kind ?? '';
  }

  // While the app's sidebar is placing a matter, a key click assigns instead of pressing.
  const placingNow = () => document.querySelector('#deck')?.classList.contains('placing');
  new MutationObserver(() => $('#neo').classList.toggle('placing', placingNow())).observe($('#deck'), { attributes: true, attributeFilter: ['class'] });

  // Every key is a tap; Dictate toggles (tap to start, tap again to stop).
  keysEl.addEventListener('pointerdown', async (ev) => {
    const b = ev.target.closest('.neo-key');
    if (!b || placingNow()) return;
    b.classList.add('down');
    try {
      if (b.dataset.matter) await post('/api/timer/toggle', { matter_id: +b.dataset.matter });
      else if (b.dataset.action === 'review') document.querySelector('#entries').scrollIntoView({ behavior: 'smooth', block: 'start' });
      else if (b.dataset.action === 'next-task') await post('/api/timer/next-task');
      else if (b.dataset.action === 'stop') await post('/api/timer/stop');
      else if (b.dataset.action === 'dictate') await post('/api/dictation/toggle');
    } catch (e) {
      flash(e.message);
    }
  });
  const release = () => document.querySelectorAll('.neo-key.down').forEach((k) => k.classList.remove('down'));
  keysEl.addEventListener('pointerup', release);
  keysEl.addEventListener('pointerleave', release);
  keysEl.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.closest('.neo-key')) {
      ev.preventDefault();
      ev.target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      ev.target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    }
  });

  // ---------- dictation readout ----------

  const listen = $('#listen');
  const listenText = $('#listen-text');
  const listenLabel = $('#listen-label');
  let typer = null;

  function showListening({ matter, phrase }) {
    clearInterval(typer);
    listen.dataset.state = 'recording';
    listenLabel.textContent = `Listening · ${matter.label || matter.name}`;
    listenText.textContent = '';
    const words = phrase.split(' ');
    let i = 0;
    const perWord = Math.max(110, Math.min(260, (1400 + phrase.length * 45) / (words.length + 2)));
    typer = setInterval(() => {
      if (i >= words.length) return clearInterval(typer);
      listenText.textContent += (i ? ' ' : '') + words[i++];
    }, perWord);
  }

  function showDictated({ text, matter }) {
    clearInterval(typer);
    listen.dataset.state = 'done';
    listenLabel.textContent = `Added to ${matter.name} notes`;
    listenText.textContent = `“${text}”`;
  }

  // ---------- try-it checklist ----------

  const STEPS = [
    ['deck-changed', 'Drag a matter from the list onto a key'],
    ['started', 'Tap a matter key to start its timer'],
    ['dictated', 'Dictate what you’re doing (tap Dictate, talk, tap again)'],
    ['next-task', 'Tap Next task when you switch to a new task'],
    ['dictated2', 'Dictate again for the new task'],
    ['stopped', 'Stop the timer'],
    ['split-applied', 'Split Acme into tasks (its client prohibits block billing)'],
    ['drafted', 'Draft a narrative from your notes'],
    ['exported', 'Export the day as an Intapp .TIM file'],
  ];
  const done = new Set();
  let dictations = 0;

  function renderSteps() {
    $('#tryit-list').innerHTML = STEPS.map(
      ([k, text]) => `<li class="${done.has(k) ? 'done' : ''}"><span class="tick" aria-hidden="true"></span><span>${esc(text)}</span>${done.has(k) ? '<span class="sr-only"> (done)</span>' : ''}</li>`,
    ).join('');
    $('#tryit-count').textContent = `${done.size} of ${STEPS.length}`;
  }

  // ---------- export + confirm panels ----------

  const overlay = $('#demo-overlay');
  function openPanel(html) {
    overlay.innerHTML = `<div class="demo-panel" role="dialog" aria-modal="true">${html}</div>`;
    overlay.hidden = false;
    overlay.querySelector('button')?.focus();
  }
  function closePanel() {
    overlay.hidden = true;
    overlay.innerHTML = '';
  }
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay || ev.target.closest('[data-close]')) closePanel();
  });
  document.addEventListener('keydown', (ev) => ev.key === 'Escape' && !overlay.hidden && closePanel());

  function showExport({ filename, body, count, format }) {
    openPanel(`
      <div class="demo-panel-head"><h2>${esc(filename)}</h2><span class="hint">${count} entr${count === 1 ? 'y' : 'ies'}</span></div>
      <p>${
        format === 'csv'
          ? 'A spreadsheet copy of the day.'
          : 'This is the file Intapp Time imports (Import Time → Load entries from file). Each line is one entry: <code>am</code> is the time in seconds, <code>ma</code> the client.matter, <code>na</code> the narrative, <code>u5</code>/<code>u6</code> the task and activity codes.'
      }</p>
      <div class="file"><pre id="export-body">${esc(body)}</pre></div>
      <div class="demo-panel-actions"><button type="button" id="copy-export">Copy file contents</button><button type="button" class="primary" data-close>Done</button></div>`);
    $('#copy-export').addEventListener('click', async (ev) => {
      try {
        await navigator.clipboard.writeText(body);
        ev.target.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents($('#export-body'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        ev.target.textContent = 'Selected: press ⌘C';
      }
    });
  }

  window.demoConfirm = (message) =>
    new Promise((resolve) => {
      openPanel(`<p class="confirm-text">${esc(message).replace(/\n/g, '<br>')}</p>
        <div class="demo-panel-actions"><button type="button" data-answer="no">Cancel</button><button type="button" class="primary" data-answer="yes">Continue</button></div>`);
      overlay.querySelectorAll('[data-answer]').forEach((b) =>
        b.addEventListener('click', () => {
          closePanel();
          resolve(b.dataset.answer === 'yes');
        }),
      );
    });

  window.demoShowExport = () => {}; // export panel opens from the 'exported' event instead

  // ---------- wire up ----------

  demo.on((event, detail) => {
    if (event === 'state' || event === 'tick') return paint(detail);
    if (event === 'listening') showListening(detail);
    if (event === 'dictated') {
      showDictated(detail);
      dictations += 1;
      done.add(dictations >= 2 && done.has('next-task') ? 'dictated2' : 'dictated');
    }
    if (event === 'exported') showExport(detail);
    if (event === 'reset') {
      done.clear();
      dictations = 0;
      listen.dataset.state = 'idle';
      listenLabel.textContent = 'Dictation';
      listenText.textContent = 'Start a matter, then tap Dictate, talk, and tap it again to finish. Your words land in that matter’s notes, timestamped.';
    }
    if (['deck-changed', 'started', 'next-task', 'stopped', 'split-applied', 'drafted', 'exported'].includes(event)) done.add(event);
    renderSteps();
  });

  $('#demo-reset').addEventListener('click', () => {
    demo.reset();
    flash('Demo reset to the sample day', false);
  });

  paint(demo.state());
  renderSteps();
})();
