import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanTranscript, Dictation, dropPromptEcho, NO_SOUND } from '../src/dictation.js';

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
