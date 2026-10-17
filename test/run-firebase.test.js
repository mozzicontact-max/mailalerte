import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { run } from '../src/main.js';
import { secretFragments } from '../src/mask.js';
import { LEAKY_TEXT, fakeFetch, fakeFirebaseBackend, fakeNotifier, firebaseFailure, noSleep, rssFeed } from './helpers.js';

// Toutes les données ci-dessous sont inventées.
const OLD = { title: 'Ancien sujet secret-A', excerpt: 'extrait secret-A', author: 'Alice Secrète <alice@example.org>' };
const URGENT = {
  title: 'Message très urgent secret-B',
  excerpt: 'extrait <b>secret-B</b>',
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
const MOODLE = {
  title: 'Nouveau contenu de Mathématiques',
  excerpt: 'Mathématiques -> Forums -> Annonces -> Sujet de TD',
  author: 'Camille Exemple (via Moodle Artois) <ne-pas-repondre@moodle.example.org>',
  pubDate: 'Mon, 05 Oct 2026 11:20:00 GMT',
};

const NOW = new Date('2026-10-17T12:00:00Z');
const FORBIDDEN_IN_LOGS = [
  'secret-', 'Secrète', 'Secret', 'alice@', 'bob@', 'etudiant@example.org', 'mot-de-passe', 'Basic ', 'abc123',
  LEAKY_TEXT, 'compte-de-service-secret', 'uid-test-1', 'token-1',
];

let dir;
let logs;
let env;
const log = (line) => logs.push(line);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailalerte-fb-'));
  logs = [];
  env = {
    UNIV_USER: 'etudiant@example.org',
    UNIV_PASSWORD: 'mot-de-passe-secret',
    NTFY_TOPIC: 'sujet-inventé-abc123',
    STATE_PATH: join(dir, 'state.json'),
    FIREBASE_SERVICE_ACCOUNT: '{"private_key":"compte-de-service-secret"}',
    FIREBASE_UID: 'uid-test-1',
  };
});

const feedOf = (...items) => fakeFetch(() => ({ status: 200, body: rssFeed(items) }));
const refused = () => fakeFetch(() => ({ status: 401 }));
const go = (fetchImpl, notifier, backend) => run({ env, fetchImpl, notifier, firebaseBackend: backend, log, sleep: noSleep, now: () => NOW });
const stateOf = async () => JSON.parse(await readFile(env.STATE_PATH, 'utf8'));
const lastStatus = (backend) => backend.status.at(-1);

// ------------------------------------------------------------ première synchronisation

test('premier lancement : mails écrits dans Firestore SANS push, ntfy silencieux, état écrit', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  assert.equal(await go(feedOf(OLD, URGENT), notifier, backend), 0);

  assert.equal(notifier.sent.length, 0);
  assert.equal(backend.mails.size, 2);
  assert.equal(backend.pushes.length, 0);
  assert.ok(!backend.calls.includes('sendPush') && !backend.calls.includes('listDevices'));
  assert.deepEqual(backend.status, [{ mailbox: 'e***@example.org', ok: true }]);
  assert.equal(backend.closed, true);

  const state = await stateOf();
  assert.equal(state.firebaseSeeded, true);
  assert.equal(state.fbSeen.length, 2);
  assert.ok(logs.some((l) => l.includes('Premier lancement')));
  assert.ok(logs.some((l) => l.includes('première synchronisation')));
});

test('mise à niveau : un état ntfy déjà existant déclenche la synchronisation silencieuse, sans rien notifier', async () => {
  const notifier = fakeNotifier();
  const withoutFirebase = { ...env };
  delete env.FIREBASE_SERVICE_ACCOUNT;
  delete env.FIREBASE_UID;
  await go(feedOf(OLD), notifier, fakeFirebaseBackend()); // ancien fonctionnement : état sans firebaseSeeded
  env = withoutFirebase;

  const backend = fakeFirebaseBackend();
  await go(feedOf(URGENT, OLD), notifier, backend); // un mail arrive en même temps qu'on active Firebase
  assert.equal(notifier.sent.length, 1); // ntfy : normal
  assert.equal(backend.mails.size, 2); // Firestore reçoit tout le flux...
  assert.equal(backend.pushes.length, 0); // ...mais aucun push pour la synchronisation
  assert.equal((await stateOf()).firebaseSeeded, true);
});

test('échec de la première synchronisation : le drapeau n’est pas posé, nouvelle tentative au passage suivant', async () => {
  const backend = fakeFirebaseBackend();
  backend.fail.createMail = firebaseFailure(7);
  assert.equal(await go(feedOf(OLD, URGENT), fakeNotifier(), backend), 1);
  assert.equal((await stateOf()).firebaseSeeded, false);
  assert.equal(backend.pushes.length, 0);

  backend.fail.createMail = null;
  assert.equal(await go(feedOf(OLD, URGENT), fakeNotifier(), backend), 0);
  assert.equal(backend.mails.size, 2);
  assert.equal((await stateOf()).firebaseSeeded, true);
  assert.equal(backend.pushes.length, 0);
});

test('changement de NTFY_TOPIC (clé des empreintes) : nouvelle synchronisation silencieuse, aucun push', async () => {
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD, URGENT), fakeNotifier(), backend);
  env.NTFY_TOPIC = 'nouveau-sujet-inventé-xyz789';
  assert.equal(await go(feedOf(OLD, URGENT), fakeNotifier(), backend), 0);
  assert.equal(backend.pushes.length, 0);
  assert.equal((await stateOf()).firebaseSeeded, true);
});

// ------------------------------------------------------------ fonctionnement normal

test('mail urgent : ntfy ET Firebase (document + push), une seule fois', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  await go(feedOf(URGENT, OLD), notifier, backend);

  assert.equal(notifier.sent.length, 1);
  assert.equal(backend.mails.size, 2);
  assert.equal(backend.pushes.length, 1);
  const [push] = backend.pushes;
  assert.equal(push.notification.title, URGENT.title);
  assert.equal(push.notification.body, 'Bob Secret : extrait secret-B'); // « expéditeur : aperçu », sans HTML
  assert.equal(push.android.priority, 'high');
  assert.equal(push.android.ttl, 6 * 60 * 60 * 1000);
  assert.deepEqual(push.android.notification, { channelId: 'mails_urgent_v3', icon: 'ic_stat_mailalerte', color: '#D8453F' });
  assert.match(push.data.mailId, /^[0-9a-f]{32}$/);

  const doc = backend.mails.get(push.data.mailId);
  assert.equal(doc.title, URGENT.title);
  assert.equal(doc.sender, 'Bob Secret');
  assert.equal(doc.level, 'urgent');
  assert.equal(doc.preview, 'extrait secret-B'); // sans HTML
  assert.equal(doc.matiere, null);
  assert.equal(doc.read, false);
  assert.equal(doc.receivedAt.toISOString(), '2026-10-05T11:00:00.000Z');

  await go(feedOf(URGENT, OLD), notifier, backend); // mêmes mails : rien de nouveau
  assert.equal(notifier.sent.length, 1);
  assert.equal(backend.pushes.length, 1);
  assert.equal(backend.mails.size, 2);
});

test('mail Moodle : matière et expéditeur nettoyé dans le document', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  await go(feedOf(MOODLE, OLD), notifier, backend);
  const doc = [...backend.mails.values()].find((m) => m.matiere);
  assert.equal(doc.matiere, 'Mathématiques');
  assert.equal(doc.sender, 'Camille Exemple');
  assert.equal(doc.level, 'normal');
  assert.equal(backend.pushes[0].notification.body, 'Camille Exemple : Mathématiques -> Forums -> Annonces -> Sujet de TD');
  assert.deepEqual(backend.pushes[0].android.notification, { channelId: 'mails_normal_v3', icon: 'ic_stat_mailalerte' });
  // ntfy, lui, garde son texte d'origine
  assert.equal(notifier.sent[0].message, 'Moodle · Mathématiques');
});

test('mêmes règles d’envoi que ntfy : un urgent, un normal, deux infos -> 2 push + 1 résumé', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  await go(feedOf(INFO2, INFO1, NORMAL, URGENT, OLD), notifier, backend);

  assert.deepEqual(notifier.sent.map((m) => m.priority), [5, 3, 2]);
  assert.deepEqual(
    backend.pushes.map((p) => p.android.notification.channelId),
    ['mails_urgent_v3', 'mails_normal_v3', 'mails_digest_v3'],
  );
  assert.deepEqual(backend.pushes.map((p) => p.android.priority), ['high', 'high', 'normal']);
  assert.deepEqual(backend.pushes.map((p) => 'color' in p.android.notification), [true, false, false], 'rouge : urgent seulement');
  assert.ok(backend.pushes.every((p) => p.android.ttl === 21600000 && p.android.notification.icon === 'ic_stat_mailalerte'));
  // résumé : « N nouveaux mails » et les expéditeurs, le plus récent d'abord (INFO2 = Y, INFO1 = X)
  assert.deepEqual(backend.pushes[2].notification, { title: '2 nouveaux mails', body: 'Y, X' });
  // ntfy est inchangé : même titre de résumé qu'avant
  assert.equal(notifier.sent[2].title, 'Infos : 2 nouveaux messages');
  assert.equal(backend.mails.size, 5); // 1 ancien + 4 nouveaux
  assert.equal([...backend.mails.values()].filter((m) => m.level === 'digest').length, 2);
  // le résumé ouvre le mail le plus récent des deux infos (INFO2, 11:11)
  assert.equal(backend.mails.get(backend.pushes[2].data.mailId).title, INFO2.title);
});

// ------------------------------------------------------------ état de surveillance

test('état de surveillance écrit à CHAQUE exécution, même sans nouveau mail', async () => {
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), fakeNotifier(), backend);
  await go(feedOf(OLD), fakeNotifier(), backend);
  await go(feedOf(OLD), fakeNotifier(), backend);
  assert.equal(backend.status.length, 3);
  assert.ok(backend.status.every((s) => s.ok === true && s.mailbox === 'e***@example.org'));
});

test('flux en échec : état écrit avec ok=false (401, délai dépassé, page HTML)', async () => {
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), fakeNotifier(), backend);

  assert.equal(await go(refused(), fakeNotifier(), backend), 1);
  assert.equal(lastStatus(backend).ok, false);

  const timeout = fakeFetch(() => {
    throw Object.assign(new Error('x'), { name: 'TimeoutError' });
  });
  assert.equal(await go(timeout, fakeNotifier(), backend), 1);
  assert.equal(backend.status.length, 3);
  assert.equal(lastStatus(backend).ok, false);

  const html = fakeFetch(() => ({ status: 200, body: '<html><body>Connexion</body></html>' }));
  assert.equal(await go(html, fakeNotifier(), backend), 1);
  assert.equal(lastStatus(backend).ok, false);

  assert.equal(await go(feedOf(OLD), fakeNotifier(), backend), 0);
  assert.equal(lastStatus(backend).ok, true);
  assert.equal(backend.closed, true);
});

test('« connexion refusée » : ntfy alerté une fois, mais aucun push ni document Firebase', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  await go(refused(), notifier, backend);
  assert.equal(notifier.sent.length, 1);
  assert.equal(backend.pushes.length, 0);
  assert.equal(backend.mails.size, 1);
});

// ------------------------------------------------------------ indépendance

test('Firebase en panne : ntfy part quand même et le mail est marqué vu côté ntfy ; Firebase rattrape ensuite sans doublon ntfy', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);

  backend.fail.createMail = firebaseFailure(14);
  backend.fail.writeStatus = firebaseFailure(14);
  assert.equal(await go(feedOf(URGENT, OLD), notifier, backend), 1);
  assert.equal(notifier.sent.length, 1); // ntfy est parti
  assert.equal(backend.pushes.length, 0);

  backend.fail = {};
  assert.equal(await go(feedOf(URGENT, OLD), notifier, backend), 0);
  assert.equal(notifier.sent.length, 1); // ntfy : pas de doublon
  assert.equal(backend.pushes.length, 1); // Firebase : le mail arrive enfin
  assert.equal(backend.mails.size, 2);

  await go(feedOf(URGENT, OLD), notifier, backend);
  assert.equal(backend.pushes.length, 1);
});

test('ntfy en panne : Firebase reçoit quand même le mail ; ntfy retente seul, sans doublon Firebase', async () => {
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), fakeNotifier(), backend);

  assert.equal(await go(feedOf(URGENT, OLD), fakeNotifier({ failWith: 'retryable' }), backend), 1);
  assert.equal(backend.pushes.length, 1);
  assert.equal(backend.mails.size, 2);

  const later = fakeNotifier();
  assert.equal(await go(feedOf(URGENT, OLD), later, backend), 0);
  assert.equal(later.sent.length, 1);
  assert.equal(backend.pushes.length, 1);
});

test('Firebase injoignable : une seule série d’échecs écrite, le reste attend, ntfy intact', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  backend.calls.length = 0;
  backend.fail.writeStatus = firebaseFailure(14);

  assert.equal(await go(feedOf(URGENT, OLD), notifier, backend), 1);
  assert.equal(notifier.sent.length, 1);
  assert.ok(!backend.calls.includes('createMail'));
  assert.ok(logs.some((l) => l.includes('service injoignable')));
});

test('NTFY_ENABLED=false : plus aucun envoi ntfy, Firebase continue ; réactiver ne renvoie pas les anciens mails', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);

  env.NTFY_ENABLED = 'false';
  assert.equal(await go(feedOf(URGENT, OLD), notifier, backend), 0);
  assert.equal(notifier.sent.length, 0);
  assert.equal(backend.pushes.length, 1);

  env.NTFY_ENABLED = 'true';
  await go(feedOf(URGENT, OLD), notifier, backend);
  assert.equal(notifier.sent.length, 0); // le mail avait été marqué « vu » en silence
});

test('NTFY_ENABLED vide (variable GitHub non définie) = ntfy actif', async () => {
  const notifier = fakeNotifier();
  env.NTFY_ENABLED = '';
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  await go(feedOf(URGENT, OLD), notifier, backend);
  assert.equal(notifier.sent.length, 1);
});

test('NTFY_ENABLED=false sans Firebase : rien n’est envoyé, mais le flux est lu et l’état tenu', async () => {
  delete env.FIREBASE_SERVICE_ACCOUNT;
  delete env.FIREBASE_UID;
  env.NTFY_ENABLED = 'false';
  const notifier = fakeNotifier();
  assert.equal(await go(feedOf(OLD), notifier), 0);
  assert.equal(await go(feedOf(URGENT, OLD), notifier), 0);
  assert.equal(notifier.sent.length, 0);
});

// ------------------------------------------------------------ configuration

test('Firebase non configuré : comportement identique à avant, aucun appel Firebase', async () => {
  delete env.FIREBASE_SERVICE_ACCOUNT;
  delete env.FIREBASE_UID;
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  assert.equal(await go(feedOf(URGENT, OLD), notifier, backend), 0);
  assert.equal(notifier.sent.length, 1);
  assert.deepEqual(backend.calls, []);
  assert.ok(!logs.some((l) => l.includes('Firebase')));
});

test('un seul des deux secrets Firebase : signalé, ntfy fonctionne, échec visible', async () => {
  delete env.FIREBASE_UID;
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  assert.equal(await go(feedOf(URGENT, OLD), notifier, backend), 1);
  assert.equal(notifier.sent.length, 1);
  assert.deepEqual(backend.calls, []);
  assert.ok(logs.some((l) => l.includes('configuration incomplète (FIREBASE_SERVICE_ACCOUNT et FIREBASE_UID')));
});

test('FIREBASE_UID invalide (chemin Firestore) : refusé', async () => {
  env.FIREBASE_UID = 'abc/../autre';
  const backend = fakeFirebaseBackend();
  assert.equal(await go(feedOf(OLD), fakeNotifier(), backend), 1);
  assert.deepEqual(backend.calls, []);
  assert.ok(logs.some((l) => l.includes('FIREBASE_UID invalide')));
});

test('JSON du compte de service illisible : catégorie « identifiants », rien du contenu dans le journal', async () => {
  env.FIREBASE_SERVICE_ACCOUNT = '{pas du json compte-de-service-secret';
  // pas de backend injecté : le vrai (firebase-admin) est utilisé et doit refuser le JSON
  const notifier = fakeNotifier();
  assert.equal(await run({ env, fetchImpl: feedOf(OLD), notifier, log, sleep: noSleep, now: () => NOW }), 1);
  assert.ok(logs.some((l) => l.includes('identifiants illisibles')));
  assert.ok(!logs.join('\n').includes('compte-de-service-secret'));
});

// ------------------------------------------------------------ nettoyage

test('nettoyage : mails de plus de 30 jours, 100 au plus, à chaque exécution réussie', async () => {
  const backend = fakeFirebaseBackend();
  backend.removeCount = 12;
  await go(feedOf(OLD), fakeNotifier(), backend);
  assert.equal(backend.cleanups.length, 1);
  assert.equal(backend.cleanups[0].limit, 100);
  assert.equal(backend.cleanups[0].olderThan.toISOString(), '2026-09-17T12:00:00.000Z');
  assert.ok(logs.some((l) => l.includes('12 ancien(s) mail(s) supprimé(s)')));
});

test('échec du nettoyage : signalé mais non bloquant', async () => {
  const backend = fakeFirebaseBackend();
  backend.fail.deleteOldMails = firebaseFailure(7);
  assert.equal(await go(feedOf(OLD), fakeNotifier(), backend), 0);
  assert.ok(logs.some((l) => l.includes('nettoyage')));
});

// ------------------------------------------------------------ appareils

test('jeton invalide : l’appareil est supprimé, signalé par un nombre', async () => {
  const backend = fakeFirebaseBackend({ devices: ['token-1', 'token-mort'] });
  backend.pushResult = (token) => (token === 'token-mort' ? { ok: false, code: 'messaging/registration-token-not-registered' } : { ok: true });
  await go(feedOf(OLD), fakeNotifier(), backend);
  assert.equal(await go(feedOf(URGENT, OLD), fakeNotifier(), backend), 0);
  assert.deepEqual(backend.deletedDevices, ['token-mort']);
  assert.ok(logs.some((l) => l.includes('Appareils supprimés : 1')));
});

// ------------------------------------------------------------ confidentialité

test('journaux : ni titre, ni expéditeur, ni secret, ni jeton, ni texte d’erreur de Firebase', async () => {
  const notifier = fakeNotifier();
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD), notifier, backend);
  await go(feedOf(INFO2, INFO1, NORMAL, URGENT, OLD), notifier, backend);
  await go(refused(), notifier, backend);

  for (const code of [7, 14, 5, 3, 16, undefined]) {
    backend.fail = { createMail: firebaseFailure(code), writeStatus: firebaseFailure(code), deleteOldMails: firebaseFailure(code) };
    await go(feedOf(MOODLE, OLD), notifier, backend);
  }
  backend.fail = { sendPush: firebaseFailure('messaging/third-party-auth-error') };
  await go(feedOf(URGENT, OLD), notifier, backend);

  const all = logs.join('\n');
  assert.ok(all.includes('Firebase'));
  for (const forbidden of FORBIDDEN_IN_LOGS) assert.ok(!all.includes(forbidden), `le journal contient « ${forbidden} »`);
});

test('état conservé : uniquement des empreintes, jamais de texte de mail', async () => {
  const backend = fakeFirebaseBackend();
  await go(feedOf(OLD, URGENT), fakeNotifier(), backend);
  const raw = await readFile(env.STATE_PATH, 'utf8');
  for (const forbidden of ['secret-', 'Secrète', 'alice@', 'example.org', 'uid-test-1', 'compte-de-service-secret', 'e***']) {
    assert.ok(!raw.includes(forbidden), `l'état contient « ${forbidden} »`);
  }
  const state = JSON.parse(raw);
  assert.ok(state.seen.every((h) => /^[0-9a-f]{64}$/.test(h)));
  assert.ok(state.fbSeen.every((h) => /^[0-9a-f]{64}$/.test(h)));
});

test('ancien fichier d’état (sans champs Firebase) : relu sans erreur', async () => {
  delete env.FIREBASE_SERVICE_ACCOUNT;
  delete env.FIREBASE_UID;
  await go(feedOf(OLD), fakeNotifier());
  const old = await stateOf();
  delete old.fbSeen;
  delete old.firebaseSeeded;
  await writeFile(env.STATE_PATH, JSON.stringify(old), 'utf8');
  assert.equal(await go(feedOf(OLD), fakeNotifier()), 0);
});

// ------------------------------------------------------------ masquage dans GitHub Actions
//
// Le compte de service est fabriqué ICI, à l'exécution : une vraie clé RSA tirée au hasard, jamais
// écrite dans un fichier ni dans le dépôt (aucun PEM, même factice, ne figure dans les sources).
const MASK = '::add-mask::';
const { privateKey: GENERATED_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ACCOUNT = {
  type: 'service_account',
  project_id: 'projet-inventé',
  private_key_id: randomBytes(20).toString('hex'),
  private_key: GENERATED_KEY,
  client_email: `robot-${randomBytes(4).toString('hex')}@projet-inventé.iam.gserviceaccount.com`,
  client_id: String(BigInt(`0x${randomBytes(8).toString('hex')}`)),
};
const SERVICE_ACCOUNT = JSON.stringify(ACCOUNT, null, 2); // plusieurs lignes, comme le fichier téléchargé
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

test('masquage : la clé privée est multiligne, et masquée LIGNE PAR LIGNE', () => {
  const keyLines = lines(ACCOUNT.private_key);
  assert.ok(keyLines.length > 10, 'la clé de test doit être multiligne');
  const fragments = new Set(secretFragments(SERVICE_ACCOUNT));
  for (const line of keyLines) assert.ok(fragments.has(line), 'une ligne de la clé n’est pas masquée');
  // et jamais en bloc : aucun fragment ne contient de saut de ligne
  assert.ok([...fragments].every((f) => !/[\r\n]/.test(f)));
});

test('masquage : forme avec les « \\n » échappés (telle qu’écrite dans le JSON), sur une seule ligne', () => {
  const escaped = JSON.stringify(ACCOUNT.private_key).slice(1, -1);
  assert.ok(escaped.includes('\\n') && !escaped.includes('\n')); // barre oblique + n, pas de vrai saut de ligne
  assert.ok(secretFragments(SERVICE_ACCOUNT).includes(escaped));
});

test('masquage : private_key_id, client_email et client_id (texte ou nombre) sont masqués', () => {
  const fragments = secretFragments(SERVICE_ACCOUNT);
  for (const field of ['private_key_id', 'client_email', 'client_id']) assert.ok(fragments.includes(ACCOUNT[field]), `${field} non masqué`);
  assert.ok(secretFragments(JSON.stringify({ client_id: 123456789012 })).includes('123456789012'));
  assert.ok(!fragments.includes(ACCOUNT.project_id)); // l'identifiant de projet n'est pas un secret
});

test('masquage : valeur multiligne quelconque ; lignes de 4 caractères masquées, plus courtes non (limite documentée)', () => {
  const body = randomBytes(96).toString('base64'); // 128 caractères
  const value = `${body.slice(0, 64)}\n${body.slice(64)}\nAb+/\nxyz\n`;
  const fragments = secretFragments(JSON.stringify({ private_key: value }));
  for (const line of lines(value).filter((l) => l.length >= 4)) assert.ok(fragments.includes(line));
  assert.ok(!fragments.includes('xyz'));
});

test('masquage : JSON illisible -> chaque ligne masquée ; absent -> rien', () => {
  assert.deepEqual(secretFragments('{ceci n’est pas du json\nsecret-sur-ligne-2'), ['{ceci n’est pas du json', 'secret-sur-ligne-2']);
  assert.deepEqual(secretFragments(undefined), []);
});

test('dans GitHub Actions : une commande ::add-mask:: par ligne, avant tout autre affichage, et rien en clair ailleurs', async (t) => {
  const printed = [];
  t.mock.method(console, 'log', (...args) => printed.push(args.join(' ')));
  env.GITHUB_ACTIONS = 'true';
  env.FIREBASE_SERVICE_ACCOUNT = SERVICE_ACCOUNT;
  // le journal du programme (`log`) doit rester propre même quand Firebase échoue
  const backend = fakeFirebaseBackend();
  backend.fail.writeStatus = firebaseFailure(7);
  await go(feedOf(OLD), fakeNotifier(), backend);

  // chaque affichage tient sur UNE ligne : une commande ne peut pas « déborder » en clair
  assert.ok(printed.every((entry) => !/[\r\n]/.test(entry)), 'un affichage contient un saut de ligne');

  const masked = new Set(printed.filter((l) => l.startsWith(MASK)).map((l) => l.slice(MASK.length)));
  for (const line of lines(ACCOUNT.private_key)) assert.ok(masked.has(line), 'ligne de clé sans commande add-mask');
  assert.ok(masked.has(JSON.stringify(ACCOUNT.private_key).slice(1, -1)), 'forme échappée sans commande add-mask');
  for (const field of ['private_key_id', 'client_email', 'client_id']) assert.ok(masked.has(ACCOUNT[field]), `${field} sans commande add-mask`);
  assert.ok(masked.has('uid-test-1'));

  // toutes les commandes sortent avant le moindre autre affichage
  const firstOther = printed.findIndex((l) => !l.startsWith(MASK));
  const lastMask = printed.findLastIndex((l) => l.startsWith(MASK));
  assert.ok(firstOther === -1 || firstOther > lastMask, 'un affichage précède la fin des masques');

  // et aucun secret en clair dans le reste des affichages ni dans le journal du programme
  const clear = [...printed.filter((l) => !l.startsWith(MASK)), ...logs].join('\n');
  for (const secret of [...lines(ACCOUNT.private_key), ACCOUNT.private_key_id, ACCOUNT.client_email, ACCOUNT.client_id, 'uid-test-1']) {
    assert.ok(!clear.includes(secret), 'un secret apparaît en clair');
  }
});
