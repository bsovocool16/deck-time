import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanTranscript, Dictation } from '../src/dictation.js';

function fakeProc({ stdout = '', code = 0 } = {}) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => setImmediate(() => p.emit('exit', 0));
  if (stdout !== null) {
    setImmediate(() => {
      p.stdout.emit('data', stdout);
      p.emit('exit', code);
    });
  }
  return p;
}

function setup(transcript) {
  const model = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')), 'model.bin');
  fs.writeFileSync(model, '');
  const calls = [];
  const notes = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'rec') return fakeProc({ stdout: null });
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
  assert.equal(d.status, 'idle');
  assert.deepEqual(calls[1].args.slice(2), ['pad', '0.5', '0.3']);
  assert.ok(calls[2].args.includes('--prompt'));
  assert.match(calls[2].args[3], /-pad\.wav$/);
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
