import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  channelIdFor,
  cleanSender,
  createFirebaseNotifier,
  digestPushText,
  firebaseLevel,
  FirebaseError,
  mailDocument,
  maskMailbox,
  previewOf,
  PUSH_TTL_MS,
  pushTextFor,
} from '../src/notifiers/firebase.js';
import { LEAKY_TEXT, fakeFirebaseBackend, firebaseFailure, noSleep } from './helpers.js';

// Toutes les données ci-dessous sont inventées.
const HASH = 'ab'.repeat(32); // 64 caractères hexadécimaux
const NOW = new Date('2026-10-17T12:00:00Z');

const classification = (overrides = {}) => ({ rule: 'Autre mail', level: 'normal', mode: 'immediate', priority: 3, matiere: '', ...overrides });
const entry = (overrides = {}) => ({
  hash: HASH,
  item: { title: 'Sujet de test', excerpt: 'Un extrait', author: 'Dana Exemple <dana@example.org>', pubDate: 'Mon, 05 Oct 2026 11:00:00 GMT' },
  classification: classification(),
  time: Date.parse('Mon, 05 Oct 2026 11:00:00 GMT'),
  ...overrides,
});
const message = { title: 'Sujet de test', message: 'Autre mail', priority: 3, clickUrl: '' };

function setup(options = {}) {
  const backend = fakeFirebaseBackend(options);
  const notifier = createFirebaseNotifier({ backend, sleep: noSleep, now: () => NOW, opTimeoutMs: options.opTimeoutMs ?? 15000 });
  return { backend, notifier };
}

// ------------------------------------------------------------ mise en forme

test('cleanSender : mêmes règles que l’application', () => {
  assert.equal(cleanSender('"Camille Exemple (via Moodle Artois)" <ne-pas-repondre@moodle.example.org>'), 'Camille Exemple');
  assert.equal(cleanSender('"Présidence" <presidence@example.org>'), 'Présidence');
  assert.equal(cleanSender('dana.exemple@example.org (Dana Exemple)'), 'Dana Exemple');
  assert.equal(cleanSender('dana.exemple@example.org'), 'Dana Exemple');
  assert.equal(cleanSender('Camille Exemple via Moodle Artois <x@example.org>'), 'Camille Exemple via Moodle Artois');
  assert.equal(cleanSender(''), '');
  assert.equal(cleanSender(undefined), '');
});

test('previewOf : sans HTML, entités décodées, 200 caractères au plus', () => {
  assert.equal(previewOf('<p>Bonjour <b>tout</b>&nbsp;le monde</p>'), 'Bonjour tout le monde');
  assert.equal(previewOf('&lt;p&gt;Texte échappé&lt;/p&gt; &amp; suite'), 'Texte échappé & suite');
  assert.equal(previewOf('<style>.a{color:red}</style><script>alert(1)</script>Contenu'), 'Contenu');
  assert.equal(previewOf('1 < 2 et 3 > 2'), '1 < 2 et 3 > 2');
  assert.equal(previewOf(undefined), '');
  const long = previewOf('é'.repeat(500));
  assert.equal(Array.from(long).length, 200);
  assert.ok(long.endsWith('…'));
});

test('maskMailbox : première lettre, ***, domaine', () => {
  assert.equal(maskMailbox('prenom.nom@univ-artois.fr'), 'p***@univ-artois.fr');
  assert.equal(maskMailbox('étudiant@example.org'), 'é***@example.org');
  assert.equal(maskMailbox('identifiant-sans-domaine'), 'i***');
});

test('niveau Firebase : digest, urgent (priorité 5) ou normal', () => {
  assert.equal(firebaseLevel(classification({ mode: 'digest', priority: 2 })), 'digest');
  assert.equal(firebaseLevel(classification({ priority: 5 })), 'urgent');
  assert.equal(firebaseLevel(classification({ priority: 3 })), 'normal');
  assert.equal(firebaseLevel(classification({ priority: undefined })), 'normal');
  assert.deepEqual(['urgent', 'normal', 'digest'].map(channelIdFor), ['mails_urgent_v2', 'mails_normal_v2', 'mails_digest_v2']);
});

test('document de mail : exactement les champs attendus par l’application', () => {
  const { id, data } = mailDocument(entry({ classification: classification({ matiere: 'Mathématiques', priority: 5 }) }), NOW);
  assert.equal(id, HASH.slice(0, 32));
  assert.equal(id.length, 32);
  assert.deepEqual(Object.keys(data).sort(), ['level', 'matiere', 'preview', 'read', 'receivedAt', 'sender', 'title']);
  assert.equal(data.title, 'Sujet de test');
  assert.equal(data.sender, 'Dana Exemple');
  assert.equal(data.matiere, 'Mathématiques');
  assert.equal(data.level, 'urgent');
  assert.equal(data.preview, 'Un extrait');
  assert.equal(data.read, false);
  assert.ok(data.receivedAt instanceof Date);
  assert.equal(data.receivedAt.toISOString(), '2026-10-05T11:00:00.000Z');
});

test('document de mail : matière absente = null ; date illisible = maintenant ; sans objet', () => {
  const { data } = mailDocument(entry({ time: Number.NaN, item: { title: '', excerpt: '', author: '', pubDate: 'n’importe quoi' } }), NOW);
  assert.equal(data.matiere, null);
  assert.equal(data.receivedAt, NOW);
  assert.equal(data.title, '(sans objet)');
});

// ------------------------------------------------------------ envoi d'un mail

test('mail : document écrit puis push FCM complet', async () => {
  const { backend, notifier } = setup({ devices: ['token-1', 'token-2'] });
  await notifier.send(message, { type: 'mail', entry: entry({ classification: classification({ priority: 5 }) }) });

  assert.equal(backend.mails.size, 1);
  assert.equal(backend.pushes.length, 2);
  assert.deepEqual(backend.pushes[0], {
    token: 'token-1',
    notification: { title: 'Sujet de test', body: 'Dana Exemple : Un extrait' },
    data: { mailId: HASH.slice(0, 32) },
    android: {
      priority: 'high',
      ttl: 6 * 60 * 60 * 1000,
      notification: { channelId: 'mails_urgent_v2', icon: 'ic_stat_mailalerte', color: '#D8453F' },
    },
  });
  assert.deepEqual(backend.pushes.map((p) => p.token), ['token-1', 'token-2']);
  assert.equal(notifier.stats.written, 1);
  assert.equal(notifier.stats.pushed, 2);
});

test('push normal : canal v2, haute priorité, icône, durée de vie, et PAS de couleur rouge', async () => {
  const { backend, notifier } = setup();
  await notifier.send(message, { type: 'mail', entry: entry() });
  const { android } = backend.pushes[0];
  assert.equal(android.notification.channelId, 'mails_normal_v2');
  assert.equal(android.notification.icon, 'ic_stat_mailalerte');
  assert.ok(!('color' in android.notification), 'le rouge est réservé au niveau urgent');
  assert.equal(android.priority, 'high');
  assert.equal(android.ttl, 21600000);
});

test('push du résumé : canal v2 « résumé », priorité normale (silencieux), icône, durée de vie, sans couleur', async () => {
  const { backend, notifier } = setup();
  await notifier.send(message, { type: 'digest', entries: [entry({ classification: classification({ mode: 'digest', priority: 2 }) })] });
  const { android } = backend.pushes[0];
  assert.equal(android.notification.channelId, 'mails_digest_v2');
  assert.equal(android.notification.icon, 'ic_stat_mailalerte');
  assert.ok(!('color' in android.notification));
  assert.equal(android.priority, 'normal');
  assert.equal(android.ttl, 21600000);
});

test('la durée de vie est de 6 heures exactement, en millisecondes (unité attendue par FCM)', () => {
  assert.equal(PUSH_TTL_MS, 6 * 60 * 60 * 1000);
  assert.equal(PUSH_TTL_MS, 21600000);
});

test('le contenu du push est celui de FCM, pas celui de ntfy (le message neutre de ntfy est ignoré)', async () => {
  const { backend, notifier } = setup();
  await notifier.send({ title: 'TITRE NTFY', message: 'TEXTE NTFY', priority: 3, clickUrl: '' }, { type: 'mail', entry: entry() });
  assert.deepEqual(backend.pushes[0].notification, { title: 'Sujet de test', body: 'Dana Exemple : Un extrait' });
});

// ------------------------------------------------------------ texte des push

test('push d’un mail : titre = sujet, texte = « expéditeur : aperçu »', () => {
  assert.deepEqual(pushTextFor(entry()), { title: 'Sujet de test', body: 'Dana Exemple : Un extrait' });
});

test('titre du push : 80 caractères au plus, avec points de suspension s’il est coupé', () => {
  const exact = 'a'.repeat(80);
  assert.equal(pushTextFor(entry({ item: { ...entry().item, title: exact } })).title, exact, 'pile 80 : rien n’est coupé');

  const cut = pushTextFor(entry({ item: { ...entry().item, title: 'b'.repeat(200) } })).title;
  assert.equal(Array.from(cut).length, 80);
  assert.ok(cut.endsWith('…'));

  const accents = pushTextFor(entry({ item: { ...entry().item, title: 'é'.repeat(120) } })).title;
  assert.equal(Array.from(accents).length, 80, 'les caractères accentués comptent pour un');
});

test('titre du push : espaces nettoyés, « (sans objet) » si vide', () => {
  assert.equal(pushTextFor(entry({ item: { ...entry().item, title: '  Cours   annulé \n demain ' } })).title, 'Cours annulé demain');
  assert.equal(pushTextFor(entry({ item: { ...entry().item, title: '' } })).title, '(sans objet)');
});

test('texte du push : 100 caractères au plus, avec points de suspension s’il est coupé', () => {
  const long = pushTextFor(entry({ item: { ...entry().item, excerpt: 'mot '.repeat(100) } })).body;
  // 100 au plus : une espace juste avant la coupure est retirée, donc 99 est possible
  assert.ok(Array.from(long).length <= 100 && Array.from(long).length >= 99, `longueur ${Array.from(long).length}`);
  assert.ok(long.startsWith('Dana Exemple : mot'));
  assert.ok(long.endsWith('…'));

  const short = pushTextFor(entry({ item: { ...entry().item, excerpt: 'x'.repeat(100 - 'Dana Exemple : '.length) } })).body;
  assert.equal(Array.from(short).length, 100, 'pile 100 : rien n’est coupé');
  assert.ok(!short.endsWith('…'));
});

test('texte du push : l’aperçu est sans HTML, et un expéditeur ou un aperçu absent ne laisse pas de « : » seul', () => {
  const body = (author, excerpt) => pushTextFor(entry({ item: { ...entry().item, author, excerpt } })).body;
  assert.equal(body('Dana Exemple <dana@example.org>', '<p>Bonjour&nbsp;<b>tous</b></p>'), 'Dana Exemple : Bonjour tous');
  assert.equal(body('Dana Exemple <dana@example.org>', ''), 'Dana Exemple');
  assert.equal(body('', 'Un extrait'), 'Un extrait');
  assert.equal(body('', ''), '');
});

test('texte du push : l’expéditeur est nettoyé comme dans l’application (sans adresse ni « via … »)', () => {
  const body = pushTextFor(
    entry({ item: { ...entry().item, author: '"Camille Exemple (via Moodle Artois)" <ne-pas-repondre@moodle.example.org>', excerpt: 'Annonce' } }),
  ).body;
  assert.equal(body, 'Camille Exemple : Annonce');
  assert.ok(!body.includes('@') && !body.includes('Moodle Artois'));
});

test('résumé : « N nouveaux mails » et les expéditeurs séparés par des virgules (récent d’abord, sans doublon)', () => {
  const from = (author) => entry({ item: { ...entry().item, author } });
  const text = digestPushText([from('Alice <alice@example.org>'), from('Bob <bob@example.org>'), from('Alice <alice@example.org>')]);
  assert.equal(text.title, '3 nouveaux mails');
  assert.equal(text.body, 'Alice, Bob');
  assert.equal(digestPushText([from('Alice <alice@example.org>'), from('Bob <bob@example.org>')]).body, 'Bob, Alice');
});

test('résumé : un seul mail -> « 1 nouveau mail » (accord au singulier)', () => {
  assert.equal(digestPushText([entry()]).title, '1 nouveau mail');
});

test('résumé : liste d’expéditeurs coupée à 100 caractères avec points de suspension', () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry({ item: { ...entry().item, author: `Expéditeur Numéro${i} <e${i}@example.org>` } }));
  const { title, body } = digestPushText(entries);
  assert.equal(title, '30 nouveaux mails');
  assert.equal(Array.from(body).length, 100);
  assert.ok(body.endsWith('…'));
  assert.ok(body.startsWith('Expéditeur Numéro29, Expéditeur Numéro28'));
});

test('résumé : expéditeurs inconnus ignorés', () => {
  assert.equal(digestPushText([entry({ item: { ...entry().item, author: '' } })]).body, '');
});

test('résumé : un document par mail, un seul push, sur le canal « résumé », ouvrant le mail le plus récent', async () => {
  const { backend, notifier } = setup();
  const digest = classification({ mode: 'digest', priority: 2 });
  const older = entry({ hash: '11'.repeat(32), classification: digest, item: { ...entry().item, author: 'Alice <alice@example.org>' } });
  const newer = entry({ hash: '22'.repeat(32), classification: digest, item: { ...entry().item, author: 'Bob <bob@example.org>' } });
  await notifier.send(message, { type: 'digest', entries: [older, newer] });

  assert.equal(backend.mails.size, 2);
  assert.equal(backend.mails.get('11'.repeat(16)).level, 'digest');
  assert.equal(backend.pushes.length, 1);
  assert.equal(backend.pushes[0].data.mailId, '22'.repeat(16));
  assert.equal(backend.pushes[0].android.notification.channelId, 'mails_digest_v2');
  assert.deepEqual(backend.pushes[0].notification, { title: '2 nouveaux mails', body: 'Bob, Alice' });
});

test('document déjà présent : jamais réécrit (l’état « lu » est conservé), le push part quand même', async () => {
  const { backend, notifier } = setup();
  await notifier.send(message, { type: 'mail', entry: entry() });
  backend.mails.get(HASH.slice(0, 32)).read = true;
  await notifier.send(message, { type: 'mail', entry: entry() });

  assert.equal(backend.mails.get(HASH.slice(0, 32)).read, true);
  assert.equal(notifier.stats.written, 1);
  assert.equal(backend.pushes.length, 2);
});

test('aucun appareil enregistré : le document est écrit, pas de push, pas d’erreur', async () => {
  const { backend, notifier } = setup({ devices: [] });
  await notifier.send(message, { type: 'mail', entry: entry() });
  assert.equal(backend.mails.size, 1);
  assert.ok(!backend.calls.includes('sendPush'));
});

test('contexte absent (alerte « connexion refusée ») : rien n’est écrit', async () => {
  const { backend, notifier } = setup();
  await notifier.send(message);
  assert.deepEqual(backend.calls, []);
});

// ------------------------------------------------------------ jetons

test('jeton invalide ou non enregistré : le document de l’appareil est supprimé, les autres reçoivent', async () => {
  const { backend, notifier } = setup({ devices: ['bon', 'mort', 'invalide'] });
  backend.pushResult = (token) =>
    token === 'mort'
      ? { ok: false, code: 'messaging/registration-token-not-registered' }
      : token === 'invalide'
        ? { ok: false, code: 'messaging/invalid-registration-token' }
        : { ok: true };
  await notifier.send(message, { type: 'mail', entry: entry() });

  assert.deepEqual(backend.deletedDevices.sort(), ['invalide', 'mort']);
  assert.deepEqual([...backend.devices], ['bon']);
  assert.equal(notifier.stats.pushed, 1);
  assert.equal(notifier.stats.devicesRemoved, 2);

  // le prochain envoi ne revoit plus les jetons morts, sans relire la liste
  await notifier.send(message, { type: 'mail', entry: entry({ hash: 'cd'.repeat(32) }) });
  assert.equal(backend.calls.filter((c) => c === 'listDevices').length, 1);
  assert.equal(backend.pushes.filter((p) => p.token === 'mort').length, 0);
});

test('panne passagère sur tous les jetons : une nouvelle tentative, puis échec réessayable', async () => {
  const { backend, notifier } = setup({ devices: ['a', 'b'] });
  backend.pushResult = () => ({ ok: false, code: 'messaging/server-unavailable' });
  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => e instanceof FirebaseError && e.retryable === true);
  assert.equal(backend.calls.filter((c) => c === 'sendPush').length, 2);
});

test('panne passagère sur un seul jeton : retenté, et pas d’échec si les autres ont reçu', async () => {
  const { backend, notifier } = setup({ devices: ['a', 'b'] });
  backend.pushResult = (token) => (token === 'b' ? { ok: false, code: 'messaging/internal-error' } : { ok: true });
  await notifier.send(message, { type: 'mail', entry: entry() }); // ne lève pas : rejouer doublerait la notification de « a »
  assert.deepEqual(backend.pushes.map((p) => p.token), ['a']);
  assert.equal(notifier.stats.pushFailed, 1);
});

test('push refusé définitivement (droits) : erreur NON réessayable, le document reste écrit', async () => {
  const { backend, notifier } = setup();
  backend.pushResult = () => ({ ok: false, code: 'messaging/third-party-auth-error' });
  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => e.category === 'auth' && e.retryable === false);
  assert.equal(backend.mails.size, 1);
});

// ------------------------------------------------------------ erreurs

test('refus d’accès à l’écriture : réessayable au prochain passage, sans insister dans celui-ci', async () => {
  const { backend, notifier } = setup();
  backend.fail.createMail = firebaseFailure(7); // PERMISSION_DENIED
  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => e.category === 'auth' && e.retryable === true);
  assert.equal(backend.calls.filter((c) => c === 'createMail').length, 1);
});

test('document refusé (argument invalide) : définitif, inutile de réessayer', async () => {
  const { backend, notifier } = setup();
  backend.fail.createMail = firebaseFailure(3);
  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => e.category === 'invalid' && e.retryable === false);
});

test('base introuvable (NOT_FOUND) : catégorie « notfound », réessayable', async () => {
  const { backend, notifier } = setup();
  backend.fail.createMail = firebaseFailure(5);
  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => e.category === 'notfound' && e.retryable === true);
});

test('panne passagère : une nouvelle tentative, puis le service est tenu pour injoignable (échec immédiat ensuite)', async () => {
  const { backend, notifier } = setup();
  backend.fail.createMail = firebaseFailure(14); // UNAVAILABLE
  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => e.category === 'transient' && e.retryable === true);
  assert.equal(backend.calls.length, 2);
  assert.equal(notifier.down, true);

  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry({ hash: 'cd'.repeat(32) }) }), (e) => e.retryable === true);
  assert.equal(backend.calls.length, 2); // aucun nouvel appel réseau
});

test('une panne passagère qui se résout à la 2e tentative n’est pas une erreur', async () => {
  const { backend, notifier } = setup();
  let first = true;
  const create = backend.createMail;
  backend.createMail = async (...args) => {
    if (first) {
      first = false;
      throw firebaseFailure(14);
    }
    return create(...args);
  };
  await notifier.send(message, { type: 'mail', entry: entry() });
  assert.equal(backend.mails.size, 1);
  assert.equal(notifier.down, false);
});

test('délai dépassé : catégorie « timeout »', async () => {
  const { backend, notifier } = setup({ opTimeoutMs: 20 });
  backend.createMail = () => new Promise(() => {}); // ne répond jamais
  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => e.category === 'timeout' && e.retryable === true);
});

test('le texte des erreurs de Firebase n’est jamais conservé', async () => {
  for (const code of [3, 5, 7, 14, 16, 'messaging/invalid-argument', 'app/invalid-credential', 'ECONNRESET', undefined]) {
    const { backend, notifier } = setup();
    backend.fail.createMail = firebaseFailure(code);
    await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => {
      assert.ok(e instanceof FirebaseError);
      assert.ok(!e.message.includes(LEAKY_TEXT), 'le message contient du texte de Firebase');
      assert.ok(!String(e.stack).includes(LEAKY_TEXT), 'la pile contient du texte de Firebase');
      return true;
    });
  }
});

test('clé illisible reconnue par son message (sans jamais le garder)', async () => {
  const { backend, notifier } = setup();
  backend.fail.createMail = Object.assign(new Error('error:1E08010C:DECODER routines::unsupported'), {});
  await assert.rejects(notifier.send(message, { type: 'mail', entry: entry() }), (e) => e.category === 'credentials' && !e.message.includes('DECODER'));
});

// ------------------------------------------------------------ première synchronisation, état, nettoyage

test('première synchronisation : écrit les mails sans push, ignore ceux en mode « ignore »', async () => {
  const { backend, notifier } = setup();
  const count = await notifier.seed([entry(), entry({ hash: 'cd'.repeat(32) }), entry({ hash: 'ef'.repeat(32), classification: classification({ mode: 'ignore' }) })]);
  assert.equal(count, 2);
  assert.equal(backend.mails.size, 2);
  assert.equal(backend.pushes.length, 0);
  assert.ok(!backend.calls.includes('sendPush'));
});

test('état de surveillance et nettoyage : transmis tels quels', async () => {
  const { backend, notifier } = setup();
  backend.removeCount = 7;
  await notifier.writeStatus({ mailbox: 'p***@example.org', ok: false });
  assert.deepEqual(backend.status, [{ mailbox: 'p***@example.org', ok: false }]);
  const olderThan = new Date('2026-09-17T12:00:00Z');
  assert.equal(await notifier.cleanup({ olderThan, limit: 100 }), 7);
  assert.deepEqual(backend.cleanups, [{ olderThan, limit: 100 }]);
});

test('close : ferme le backend, sans jamais lever', async () => {
  const { backend, notifier } = setup();
  await notifier.close();
  assert.equal(backend.closed, true);
  backend.close = async () => {
    throw new Error(LEAKY_TEXT);
  };
  await notifier.close();
});
