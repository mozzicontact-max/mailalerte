import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNtfyNotifier, encodeHeader } from '../src/notifiers/ntfy.js';
import { noSleep } from './helpers.js';

test('encodeHeader : ASCII inchangé, accents en RFC 2047', () => {
  assert.equal(encodeHeader('Hello'), 'Hello');
  const encoded = encodeHeader('Examen reporté');
  assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const b64 = encoded.slice('=?UTF-8?B?'.length, -2);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'Examen reporté');
});

test('POST sur /<topic> avec Title, Priority et corps UTF-8', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const n = createNtfyNotifier({ topic: 'topic-test', fetchImpl, sleep: noSleep });
  await n.send({ title: 'Cours annulé', message: 'Moodle · Maths', priority: 5, clickUrl: 'https://example.org/' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.sh/topic-test');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Priority, '5');
  assert.equal(calls[0].init.headers.Click, 'https://example.org/');
  assert.match(calls[0].init.headers.Title, /^=\?UTF-8\?B\?/);
  assert.equal(calls[0].init.body, 'Moodle · Maths');
  assert.equal(calls[0].init.redirect, 'manual');
});

test('erreur 500 : 2 nouvelles tentatives puis échec réessayable', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const notifier = createNtfyNotifier({ topic: 't', fetchImpl, sleep: noSleep });
  await assert.rejects(notifier.send({ title: 'x', message: 'y', priority: 3 }), (e) => e.retryable === true);
  assert.equal(n, 3);
});

test('erreur 400 : refus définitif, aucune nouvelle tentative', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { status: 400, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const notifier = createNtfyNotifier({ topic: 't', fetchImpl, sleep: noSleep });
  await assert.rejects(notifier.send({ title: 'x', message: 'y', priority: 3 }), (e) => e.retryable === false);
  assert.equal(n, 1);
});

test('topic manquant : erreur claire', () => {
  assert.throws(() => createNtfyNotifier({ topic: '' }), /NTFY_TOPIC/);
});
