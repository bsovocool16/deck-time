import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanTranscript, Dictation, dictationPrompt, dropPromptEcho, NO_SOUND, whisperReason } from '../src/dictation.js';

function fakeProc({ stdout = '', stderr = '', code = 0 } = {}) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => setImmediate(() => p.emit('exit', 0));
  if (stdout !== null) {
    setImmediate(() => {
      p.stdout.emit('data', stdout);
      if (stderr) p.stderr.emit('data', stderr);
      p.emit('exit', code);
    });
  }
  return p;
}

function setup(transcript, peak = 0.42) {
  const model = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')), 'model.bin');
  fs.writeFileSync(model, '');
  const calls = [];
  const notes = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'rec' && args.includes('trim')) return fakeProc({ stdout: '' }); // mic test exits on its own
    if (cmd === 'rec') return fakeProc({ stdout: null });
    if (cmd === 'sox' && args.includes('stat')) return fakeProc({ stdout: '', stderr: `Maximum amplitude:     ${peak}\n` });
    if (cmd === 'sox') return fakeProc({ stdout: '' });
    return fakeProc({ stdout: transcript });
  };
  const config = { dictation: { recorder: 'rec', sox: 'sox', whisper: 'whisper-cli', model, device: '' } };
  const d = new Dictation({ getConfig: () => config, onText: (t, ctx) => notes.push([t, ctx.matterId]), spawnImpl });
  return { d, calls, notes };
}

test('record then transcribe appends a note for the matter running at start', async () => {
  const { d, calls, notes } = setup(' Call with opposing counsel regarding the NDA.\n');
  d.start({ matterId: 7, prompt: 'Legal billing notes for Alpha.' });
  assert.equal(d.status, 'recording');
  assert.deepEqual(calls[0].args.slice(0, 6), ['-q', '-c', '1', '-r', '16000', '-b']);
  const text = await d.stop();
  assert.equal(text, 'Call with opposing counsel regarding the NDA.');
  assert.deepEqual(notes, [['Call with opposing counsel regarding the NDA.', 7]]);
  assert.equal(d.snapshot().last.text, 'Call with opposing counsel regarding the NDA.');
  assert.equal(d.snapshot().last.matter_id, 7);
  assert.equal(d.status, 'idle');
  assert.deepEqual(calls[1].args.slice(1), ['-n', 'stat']);
  assert.deepEqual(calls[2].args.slice(2), ['pad', '0.5', '0.3']);
  assert.ok(calls[3].args.includes('--prompt'));
  assert.match(calls[3].args[3], /-pad\.wav$/);
});

test('silence produces no note', async () => {
  const { d, notes } = setup('[BLANK_AUDIO]\n');
  d.start({ matterId: 1 });
  assert.equal(await d.stop(), '');
  assert.equal(notes.length, 0);
  assert.equal(d.error, 'Heard nothing');
});

test('missing model is a clear error', () => {
  const d = new Dictation({ getConfig: () => ({ dictation: { model: '/nope.bin' } }), onText() {} });
  assert.throws(() => d.start(), /Whisper model not found/);
});

test('cannot start twice', () => {
  const { d } = setup('x');
  d.start({});
  assert.throws(() => d.start({}), /recording/);
});

test('cleanTranscript strips timestamps and sound tags', () => {
  assert.equal(cleanTranscript('[00:00:00.000 --> 00:00:02.000]  Reviewed the SPA.\n(keyboard clicking)\n[MUSIC]\n and markup.'), 'Reviewed the SPA. and markup.');
});

test('a silent recording says so instead of transcribing', async () => {
  const { d, calls, notes } = setup('Acme / Globex Merger.', 0.0001);
  d.start({ matterId: 1, prompt: 'Legal billing notes for Acme / Globex Merger.' });
  assert.equal(await d.stop(), '');
  assert.equal(notes.length, 0);
  assert.equal(d.error, NO_SOUND);
  assert.equal(calls.some((c) => c.cmd === 'whisper-cli'), false);
});

test('a transcript that only echoes the prompt is dropped', async () => {
  assert.equal(dropPromptEcho('Acme / Globex Merger.', 'Legal billing notes for Acme / Globex Merger.'), '');
  assert.equal(dropPromptEcho('Legal billing notes for Acme / Globex Merger.', 'Legal billing notes for Acme / Globex Merger.'), '');
  assert.equal(dropPromptEcho('Reviewed the Acme disclosure schedules.', 'Legal billing notes for Acme / Globex Merger.'), 'Reviewed the Acme disclosure schedules.');
  const { d, notes } = setup(' Acme / Globex Merger.\n');
  d.start({ matterId: 1, prompt: 'Legal billing notes for Acme / Globex Merger.' });
  assert.equal(await d.stop(), '');
  assert.equal(notes.length, 0);
});

test('microphone test reports whether sound arrived', async () => {
  let { d, calls } = setup('', 0.2);
  assert.deepEqual(await d.testMic(1), { peak: 0.2, heard: true });
  assert.deepEqual(calls[0].args.slice(-3), ['trim', '0', '1']);
  assert.equal(d.status, 'idle');
  ({ d } = setup('', 0.00002));
  assert.equal((await d.testMic(1)).heard, false);
});

test('a silent dictation emits nosound', async () => {
  const { d } = setup('x', 0.0001);
  let fired = false;
  d.on('nosound', () => (fired = true));
  d.start({ matterId: 1 });
  await d.stop();
  assert.equal(fired, true);
});

test('dictation prompt carries matter names and legal vocabulary', () => {
  const acme = { name: 'Acme / Globex Merger' };
  const { prompt, echoes } = dictationPrompt(acme, { matters: [acme, { name: 'Initech Credit Facility' }] });
  assert.match(prompt, /^Legal billing notes for Acme \/ Globex Merger\. Terms: /);
  assert.match(prompt, /disclosure schedules/);
  assert.match(prompt, /Initech Credit Facility/);
  assert.deepEqual(echoes, ['Legal billing notes for Acme / Globex Merger.', 'Acme / Globex Merger']);
  assert.ok(prompt.length <= 900);
  const custom = dictationPrompt(acme, { vocabulary: 'Hooli, Pied Piper\nearnout' });
  assert.match(custom.prompt, /Terms: Hooli, Pied Piper, earnout\.$/);
});

test('a real short dictation that matches a vocabulary word is kept', () => {
  const { echoes } = dictationPrompt({ name: 'Acme' });
  assert.equal(dropPromptEcho('Disclosure schedules.', echoes), 'Disclosure schedules.');
  assert.equal(dropPromptEcho('Acme.', echoes), '');
});

test('if whisper rejects its arguments, retry once without the prompt and report its own reason', async () => {
  const model = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')), 'model.bin');
  fs.writeFileSync(model, '');
  const calls = [];
  const usage = 'error: unknown argument: --frobnicate\n\nusage: whisper-cli [options] file0 file1 ...\n  -h, --help [default] show this help message and exit\n';
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'rec') return fakeProc({ stdout: null });
    if (cmd === 'sox' && args.includes('stat')) return fakeProc({ stdout: '', stderr: 'Maximum amplitude: 0.5\n' });
    if (cmd === 'sox') return fakeProc({ stdout: '' });
    return args.includes('--prompt') ? fakeProc({ stdout: '', stderr: usage, code: 1 }) : fakeProc({ stdout: ' Reviewed the seller disclosure schedules.\n' });
  };
  const notes = [];
  const d = new Dictation({ getConfig: () => ({ dictation: { recorder: 'rec', sox: 'sox', whisper: 'whisper-cli', model } }), onText: (t) => notes.push(t), spawnImpl });
  const quiet = console.error;
  console.error = () => {};
  try {
    d.start({ matterId: 1, prompt: 'Legal billing notes for Acme. Terms: seller.', echoes: ['Acme'] });
    assert.equal(await d.stop(), 'Reviewed the seller disclosure schedules.');
  } finally {
    console.error = quiet;
  }
  const whisperCalls = calls.filter((c) => c.cmd === 'whisper-cli');
  assert.equal(whisperCalls.length, 2);
  assert.equal(whisperCalls[1].args.includes('--prompt'), false);
  assert.deepEqual(notes, ['Reviewed the seller disclosure schedules.']);
  assert.equal(whisperReason(usage, 1), 'error: unknown argument: --frobnicate');
  assert.equal(whisperReason('', 3), 'exit code 3');
});

// ---------- browser capture: the open window records ----------

/** A 16-bit mono WAV of `seconds` of a tone at `level` (0..1). */
function wav(level, seconds = 0.2, rate = 16000) {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * level * 32767), 44 + i * 2);
  return b;
}

function browserSetup(transcript, { windows = 1 } = {}) {
  const { d, calls, notes } = setup(transcript);
  d.getConfig().dictation.capture = 'browser';
  d.recorders = () => windows;
  const events = [];
  d.on('capture', (e) => events.push(e));
  return { d, calls, notes, events };
}

test('browser capture: the window records, the server transcribes; no sox involved', async () => {
  const { d, calls, notes, events } = browserSetup(' Reviewed the disclosure schedules.\n');
  d.start({ matterId: 4, prompt: 'Legal billing notes.' });
  assert.equal(d.status, 'recording');
  assert.deepEqual(events.map((e) => e.action), ['start']);
  const id = events[0].id;
  assert.equal(d.snapshot().capture, 'browser');

  const stopping = d.stop();
  assert.deepEqual(events.map((e) => e.action), ['start', 'stop']);
  assert.equal(d.status, 'transcribing');
  d.receiveAudio(id, wav(0.3));
  assert.equal(await stopping, 'Reviewed the disclosure schedules.');
  assert.deepEqual(notes, [['Reviewed the disclosure schedules.', 4]]);
  assert.deepEqual(calls.map((c) => c.cmd), ['whisper-cli']); // no rec, no sox
  assert.equal(d.status, 'idle');
});

test('browser capture: no open window, a silent recording, a blocked mic, or a stale upload', async () => {
  let { d, events } = browserSetup('x', { windows: 0 });
  assert.throws(() => d.start({ matterId: 1 }), /Open deck-time in your browser/);

  ({ d, events } = browserSetup('should not be used'));
  d.start({ matterId: 1 });
  const stopping = d.stop();
  d.receiveAudio(events[0].id, wav(0.0005));
  assert.equal(await stopping, '');
  assert.match(d.error, /No sound was recorded\. Check that this site may use the microphone/);

  ({ d, events } = browserSetup('x'));
  d.start({ matterId: 1 });
  d.fail(events[0].id, 'The browser blocked the microphone.');
  assert.equal(d.status, 'idle');
  assert.equal(d.error, 'The browser blocked the microphone.');
  assert.throws(() => d.receiveAudio(events[0].id, wav(0.3)), /No dictation is waiting/);
});

test('wavPeak reads the loudest sample of a WAV', async () => {
  const { wavPeak } = await import('../src/dictation.js');
  assert.ok(Math.abs(wavPeak(wav(0.5)) - 0.5) < 0.01);
  assert.equal(wavPeak(Buffer.from('not a wav at all, definitely not a wav')), null);
});
