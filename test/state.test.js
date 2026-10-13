import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { itemHash, keyFingerprint, remember } from '../src/state.js';

const item = { author: 'Test <test@example.org>', pubDate: 'Mon, 05 Oct 2026 10:00:00 GMT', title: 'Objet inventé' };

test('empreinte = HMAC-SHA-256(clé, auteur|date|objet)', () => {
  const expected = createHmac('sha256', 'cle-de-test').update(`${item.author}|${item.pubDate}|${item.title}`).digest('hex');
  assert.equal(itemHash(item, 'cle-de-test'), expected);
});

test('même clé : stable ; autre clé : empreinte différente', () => {
  assert.equal(itemHash(item, 'k1'), itemHash(item, 'k1'));
  assert.notEqual(itemHash(item, 'k1'), itemHash(item, 'k2'));
});

test('l’empreinte change si l’auteur, la date ou l’objet change', () => {
  const base = itemHash(item, 'k');
  assert.notEqual(base, itemHash({ ...item, author: 'Autre <autre@example.org>' }, 'k'));
  assert.notEqual(base, itemHash({ ...item, pubDate: 'Tue, 06 Oct 2026 10:00:00 GMT' }, 'k'));
  assert.notEqual(base, itemHash({ ...item, title: 'Autre objet' }, 'k'));
});

test('empreinte de clé : stable, courte, différente selon la clé, sans la clé', () => {
  const a = keyFingerprint('ma-cle-secrete-123');
  assert.equal(a, keyFingerprint('ma-cle-secrete-123'));
  assert.notEqual(a, keyFingerprint('autre-cle'));
  assert.equal(a.length, 16);
  assert.ok(!a.includes('ma-cle-secrete'));
});

test('remember : nouveaux en tête, sans doublon, borné', () => {
  assert.deepEqual(remember(['a', 'b'], ['c', 'a'], 10), ['c', 'a', 'b']);
  assert.equal(remember(['a', 'b', 'c'], ['d'], 2).length, 2);
});
