import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { run } from '../src/main.js';
import { fakeFetch, fakeNotifier, noSleep, rssFeed } from './helpers.js';

const OLD = { title: 'Ancien sujet secret-A', excerpt: 'extrait secret-A', author: 'Alice Secrète <alice@example.org>' };
const URGENT = {
  title: 'Message très urgent secret-B',
  excerpt: 'extrait secret-B',
  author: 'Bob Secret <bob@example.org>',
  pubDate: 'Mon, 05 Oct 2026 11:00:00 GMT',
};
const NORMAL = {
  title: 'Question sur le TP secret-C',
  excerpt: 'extrait secret-C',
  author: 'Carole Secrète <carole@example.org>',
  pubDate: 'Mon, 05 Oct 2026 11:05:00 GMT',
};
const INFO1 = { title: '[etudiant] Info secret-D', author: 'x@example.org', pubDate: 'Mon, 05 Oct 2026 11:10:00 GMT' };
const INFO2 = { title: 'Newsletter secret-E', author: 'y@example.org', pubDate: 'Mon, 05 Oct 2026 11:11:00 GMT' };

let dir;
let logs;
let env;
const log = (line) => logs.push(line);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailalerte-'));
  logs = [];
  env = {
    UNIV_USER: 'etudiant@example.org',
    UNIV_PASSWORD: 'mot-de-passe-secret',
    NTFY_TOPIC: 'sujet-inventé-abc123',
    STATE_PATH: join(dir, 'state.json'),
  };
});

const feedOf = (...items) => fakeFetch(() => ({ status: 200, body: rssFeed(items) }));
const go = (fetchImpl, notifier) => run({ env, fetchImpl, notifier, log, sleep: noSleep });

test('premier lancement : tout est enregistré, aucune notification', async () => {
  const notifier = fakeNotifier();
  assert.equal(await go(feedOf(OLD, URGENT), notifier), 0);
  assert.equal(notifier.sent.length, 0);
  assert.ok(logs.some((l) => l.includes('Premier lancement')));
  assert.equal(JSON.parse(await readFile(env.STATE_PATH, 'utf8')).seen.length, 2);
});

test('mail urgent : notification immédiate, une seule fois', async () => {
  const notifier = fakeNotifier();
  await go(feedOf(OLD), notifier);
  await go(feedOf(URGENT, OLD), notifier);
  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0].title, URGENT.title);
  assert.equal(notifier.sent[0].priority, 5);

  await go(feedOf(URGENT, OLD), notifier); // mêmes mails : rien de nouveau
  assert.equal(notifier.sent.length, 1);
});

test('un urgent, un normal, deux infos → 2 notifications + 1 résumé', async () => {
  const notifier = fakeNotifier();
  await go(feedOf(OLD), notifier);
  await go(feedOf(INFO2, INFO1, NORMAL, URGENT, OLD), notifier);
  assert.deepEqual(
    notifier.sent.map((m) => m.priority),
    [5, 3, 2],
  );
  assert.equal(notifier.sent[2].title, 'Infos : 2 nouveaux messages');
  assert.ok(logs.some((l) => l.includes('Notifications envoyées : 3')));
});

test('les journaux ne contiennent aucun titre, extrait, expéditeur ni secret', async () => {
  const notifier = fakeNotifier();
  await go(feedOf(OLD), notifier);
  await go(feedOf(INFO2, INFO1, NORMAL, URGENT, OLD), notifier);
  await go(fakeFetch(() => ({ status: 401 })), notifier);

  const all = logs.join('\n');
  for (const forbidden of ['secret-', 'Secrète', 'Secret', 'alice@', 'bob@', 'etudiant@example.org', 'mot-de-passe', 'Basic ', 'abc123']) {
    assert.ok(!all.includes(forbidden), `le journal contient « ${forbidden} »`);
  }
});

test('401 : une seule notification « connexion refusée », échec à chaque fois', async () => {
  const notifier = fakeNotifier();
  const refused = fakeFetch(() => ({ status: 401 }));
  assert.equal(await go(refused, notifier), 1);
  assert.equal(await go(refused, notifier), 1);
  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0].title, 'Connexion refusée');
  assert.equal(refused.calls, 2); // aucune nouvelle tentative sur 401
});

test('403 traité comme 401 ; après une connexion réussie, l’alerte est ré-armée', async () => {
  const notifier = fakeNotifier();
  assert.equal(await go(fakeFetch(() => ({ status: 403 })), notifier), 1);
  assert.equal(await go(feedOf(OLD), notifier), 0); // premier lancement silencieux
  assert.equal(await go(fakeFetch(() => ({ status: 401 })), notifier), 1);
  assert.equal(notifier.sent.filter((m) => m.title === 'Connexion refusée').length, 2);
});

test('refus au tout premier passage : les anciens mails ne sont pas notifiés ensuite', async () => {
  const notifier = fakeNotifier();
  await go(fakeFetch(() => ({ status: 401 })), notifier);
  await go(feedOf(OLD, URGENT), notifier);
  assert.equal(notifier.sent.filter((m) => m.title !== 'Connexion refusée').length, 0);
});

test('panne ntfy temporaire : le mail n’est pas marqué vu et sera renvoyé', async () => {
  await go(feedOf(OLD), fakeNotifier());
  assert.equal(await go(feedOf(URGENT, OLD), fakeNotifier({ failWith: 'retryable' })), 1);

  const later = fakeNotifier();
  assert.equal(await go(feedOf(URGENT, OLD), later), 0);
  assert.equal(later.sent.length, 1);
});

test('refus définitif de ntfy : le mail est marqué vu (pas de boucle infinie)', async () => {
  await go(feedOf(OLD), fakeNotifier());
  assert.equal(await go(feedOf(URGENT, OLD), fakeNotifier({ failWith: 'permanent' })), 1);

  const later = fakeNotifier();
  await go(feedOf(URGENT, OLD), later);
  assert.equal(later.sent.length, 0);
});

test('timeout du flux : 3 tentatives au total puis échec', async () => {
  const f = fakeFetch(() => {
    throw Object.assign(new Error('x'), { name: 'TimeoutError' });
  });
  assert.equal(await go(f, fakeNotifier()), 1);
  assert.equal(f.calls, 3);
});

test('page HTML au lieu du RSS : échec, sans notification', async () => {
  const notifier = fakeNotifier();
  const html = fakeFetch(() => ({ status: 200, body: '<html><body>Connexion</body></html>' }));
  assert.equal(await go(html, notifier), 1);
  assert.equal(notifier.sent.length, 0);
});

test('l’historique est limité à 200 empreintes', async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ title: `Mail ${i}`, author: 'a@example.org', pubDate: `d${i}` }));
  await go(feedOf(...many), fakeNotifier());
  assert.equal(JSON.parse(await readFile(env.STATE_PATH, 'utf8')).seen.length, 200);
});

test('le fichier d’état ne contient ni texte de mail, ni secret, ni la clé', async () => {
  await go(feedOf(OLD, URGENT), fakeNotifier());
  const raw = await readFile(env.STATE_PATH, 'utf8');
  for (const forbidden of ['secret-', 'Secrète', 'alice@', 'bob@', 'mot-de-passe', 'abc123', 'example.org']) {
    assert.ok(!raw.includes(forbidden), `l'état contient « ${forbidden} »`);
  }
  assert.ok(JSON.parse(raw).seen.every((h) => /^[0-9a-f]{64}$/.test(h)));
});

test('NTFY_TOPIC manquant : arrêt net, aucune requête', async () => {
  delete env.NTFY_TOPIC;
  const f = feedOf(OLD);
  assert.equal(await go(f, fakeNotifier()), 1);
  assert.equal(f.calls, 0);
  assert.ok(logs.some((l) => l.includes('NTFY_TOPIC')));
});

test('changement de NTFY_TOPIC : réinitialisation silencieuse, pas de rafale d’anciens mails', async () => {
  const notifier = fakeNotifier();
  await go(feedOf(OLD, URGENT), notifier);
  assert.equal(notifier.sent.length, 0);

  env.NTFY_TOPIC = 'nouveau-sujet-inventé-xyz789';
  assert.equal(await go(feedOf(OLD, URGENT), notifier), 0);
  assert.equal(notifier.sent.length, 0);
  assert.ok(logs.some((l) => l.includes('Clé anti-doublons modifiée')));

  // et le fonctionnement normal reprend avec la nouvelle clé
  await go(feedOf(NORMAL, OLD, URGENT), notifier);
  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0].title, NORMAL.title);
});

test('l’alerte « connexion refusée » reste unique malgré le changement de clé', async () => {
  const notifier = fakeNotifier();
  const refused = fakeFetch(() => ({ status: 401 }));
  await go(refused, notifier);
  env.NTFY_TOPIC = 'autre-sujet-inventé-000';
  await go(refused, notifier);
  assert.equal(notifier.sent.length, 1);
});
