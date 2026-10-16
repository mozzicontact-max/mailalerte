// Point d'entrée : lit le flux, classe les nouveaux mails, notifie (ntfy et/ou Firebase).
//
// RÈGLE DE JOURNALISATION : on n'écrit jamais d'objet, d'extrait, d'expéditeur,
// d'URL ni de secret. Seuls le code HTTP, des nombres et des catégories d'erreur sortent.
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { classify, compileRules } from './classify.js';
import { fetchFeed } from './feed.js';
import { secretFragments } from './mask.js';
import { authFailureMessage, digestMessage, mailMessage } from './message.js';
import { isValidUid } from './notifiers/firebase-admin.js';
import { firebaseErrorLabel, maskMailbox } from './notifiers/firebase.js';
import { createNotifier } from './notifiers/index.js';
import { parseRss } from './rss.js';
import { emptyState, itemHash, keyFingerprint, loadState, remember, saveState } from './state.js';

const FEED_URL = 'https://wmailetu.univ-artois.fr/home/~/inbox.rss';
const RULES_URL = new URL('../rules.json', import.meta.url);

const MAIL_RETENTION_DAYS = 30;
const CLEANUP_LIMIT = 100;

const ERROR_LABELS = {
  timeout: 'délai dépassé',
  network: 'réseau injoignable',
  http: 'réponse HTTP inattendue',
  format: 'réponse qui n’est pas un flux RSS',
};

// Variable booléenne de workflow : vide ou absente = valeur par défaut.
function flag(value, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  return !['false', '0', 'no', 'non', 'off'].includes(text);
}

// Nouveaux éléments (absents de `seenList`), du plus ancien au plus récent.
function freshEntries(hashed, seenList, rules) {
  const seen = new Set(seenList);
  const fresh = [];
  for (const entry of hashed) {
    if (seen.has(entry.hash) || fresh.some((f) => f.hash === entry.hash)) continue;
    fresh.push({ ...entry, classification: classify(entry.item, rules), time: Date.parse(entry.item.pubDate) });
  }
  fresh.reverse();
  fresh.sort((a, b) => a.time - b.time || 0);
  return fresh;
}

// Envoi des nouveaux éléments par un canal. Un élément n'est marqué « fait » que si sa notification
// est partie. Au premier échec temporaire on s'arrête : le reste sera retenté au prochain passage.
// Retourne { done (empreintes), sent, failed }.
async function deliver({ send, fresh, settings }) {
  const immediate = fresh.filter((e) => e.classification.mode === 'immediate');
  const digest = fresh.filter((e) => e.classification.mode === 'digest');
  const done = fresh.filter((e) => e.classification.mode === 'ignore').map((e) => e.hash);
  let sent = 0;
  let failed = 0;
  let stopped = false;

  for (const entry of immediate) {
    try {
      await send(mailMessage(entry.item, entry.classification, settings), { type: 'mail', entry });
      sent += 1;
      done.push(entry.hash);
    } catch (err) {
      failed += 1;
      if (err.retryable) {
        stopped = true;
        break;
      }
      done.push(entry.hash); // refus définitif : inutile de réessayer indéfiniment
    }
  }

  if (digest.length > 0 && !stopped) {
    try {
      await send(digestMessage(digest, settings), { type: 'digest', entries: digest });
      sent += 1;
      done.push(...digest.map((e) => e.hash));
    } catch (err) {
      failed += 1;
      if (!err.retryable) done.push(...digest.map((e) => e.hash));
    }
  }
  return { done, sent, failed };
}

export async function run({ env = process.env, fetchImpl = fetch, notifier, firebaseBackend, log = console.log, sleep, now = () => new Date() } = {}) {
  // NTFY_TOPIC sert aussi de clé secrète pour les empreintes anti-doublons (HMAC).
  const { UNIV_USER: user, UNIV_PASSWORD: password, NTFY_TOPIC: hashKey } = env;
  if (!user || !password || !hashKey) {
    log('Configuration incomplète : secrets UNIV_USER, UNIV_PASSWORD et NTFY_TOPIC requis.');
    return 1;
  }

  // Les secrets Firebase sont masqués avant tout autre affichage (champ par champ : un JSON sur
  // plusieurs lignes ne peut pas être masqué en une seule commande).
  if (env.GITHUB_ACTIONS === 'true') {
    for (const fragment of secretFragments(env.FIREBASE_SERVICE_ACCOUNT)) console.log(`::add-mask::${fragment}`);
    if (env.FIREBASE_UID) console.log(`::add-mask::${env.FIREBASE_UID}`);
  }

  const rules = compileRules(JSON.parse(await readFile(RULES_URL, 'utf8')));

  // ntfy : actif par défaut ; NTFY_ENABLED=false le coupe (les mails sont alors marqués « vus » sans envoi).
  const ntfyEnabled = flag(env.NTFY_ENABLED, true);
  const channel = ntfyEnabled ? (notifier ?? createNotifier(env.NOTIFIER || 'ntfy', { env, fetchImpl, sleep })) : null;

  // Firebase : actif si FIREBASE_SERVICE_ACCOUNT et FIREBASE_UID sont tous deux définis.
  let firebase = null;
  let configFailures = 0;
  const hasAccount = Boolean(env.FIREBASE_SERVICE_ACCOUNT?.trim());
  const hasUid = Boolean(env.FIREBASE_UID?.trim());
  if (hasAccount !== hasUid) {
    log('Firebase : configuration incomplète (FIREBASE_SERVICE_ACCOUNT et FIREBASE_UID doivent être définis ensemble), canal désactivé.');
    configFailures += 1;
  } else if (hasAccount && !isValidUid(env.FIREBASE_UID.trim())) {
    log('Firebase : FIREBASE_UID invalide, canal désactivé.');
    configFailures += 1;
  } else if (hasAccount) {
    try {
      firebase = createNotifier('firebase', { env: { ...env, FIREBASE_UID: env.FIREBASE_UID.trim() }, firebaseBackend, sleep, now });
    } catch (err) {
      log(`Firebase : échec (${firebaseErrorLabel(err)}), canal désactivé.`);
      configFailures += 1;
    }
  }

  try {
    const code = await poll({ env, fetchImpl, log, sleep, now, rules, channel, firebase, user, password, hashKey });
    return code > 0 || configFailures > 0 ? 1 : 0;
  } finally {
    await firebase?.close();
  }
}

async function poll({ env, fetchImpl, log, sleep, now, rules, channel, firebase, user, password, hashKey }) {
  const { settings } = rules;

  const statePath = env.STATE_PATH || '.cache/state.json';
  const state = await loadState(statePath);
  let lastSaved = JSON.stringify(state);

  // Si la clé a changé (ou si l'état vient d'une ancienne version), les empreintes
  // enregistrées ne sont plus comparables : on repart d'un état vide, sans notifier.
  const keyId = keyFingerprint(hashKey);
  const keyChanged = state.initialized && state.keyId !== keyId;
  if (state.keyId !== keyId) {
    Object.assign(state, { ...emptyState(), authAlertSent: state.authAlertSent, keyId });
  }

  async function persist() {
    if (JSON.stringify(state) === lastSaved) return;
    await saveState(statePath, state);
    lastSaved = JSON.stringify(state);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'state_changed=true\n');
  }

  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${authorization}`);

  // Étape Firebase : une erreur est réduite à une catégorie (aucun texte de Firebase n'est écrit).
  async function firebaseStep(what, fn) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      log(`Firebase : échec (${firebaseErrorLabel(err)}) pendant ${what}.`);
      return { ok: false };
    }
  }

  const mailbox = maskMailbox(user);
  async function writeStatus(ok) {
    const step = await firebaseStep('l’écriture de l’état de surveillance', () => firebase.writeStatus({ mailbox, ok }));
    if (step.ok) log(`Firebase : état de surveillance écrit (${ok ? 'flux lu' : 'flux en échec'}).`);
    return step.ok;
  }

  // 1. Lecture du flux
  let feed;
  try {
    feed = await fetchFeed({ url: FEED_URL, authorization, fetchImpl, sleep });
  } catch (err) {
    if (err.kind === 'auth') {
      log(`Flux : accès refusé (HTTP ${err.status}).`);
      if (!channel) {
        log('ntfy désactivé : alerte « connexion refusée » non envoyée.');
      } else if (state.authAlertSent) {
        log('Alerte « connexion refusée » déjà envoyée : aucune nouvelle notification.');
      } else {
        try {
          await channel.send(authFailureMessage(err.status));
          state.authAlertSent = true;
          log('Notifications envoyées : 1 (connexion refusée).');
        } catch {
          log('Notification « connexion refusée » non envoyée.');
        }
      }
    } else {
      const detail = err.status ? ` (HTTP ${err.status})` : '';
      log(`Flux : échec, ${ERROR_LABELS[err.kind] ?? 'erreur'}${detail}, ${err.attempts ?? 1} tentative(s).`);
    }
    await persist();
    // L'état de surveillance est écrit même si le flux est en échec : ok=false, lastCheckAt à jour.
    if (firebase) await writeStatus(false);
    return 1;
  }

  const items = parseRss(feed.xml);
  log(`Flux : HTTP ${feed.status}, ${items.length} élément(s).`);
  state.authAlertSent = false;

  const hashed = items.map((item) => ({ item, hash: itemHash(item, hashKey) }));
  let failures = 0;

  // 2. ntfy
  if (!state.initialized) {
    // Premier lancement : tout enregistrer sans notifier
    state.seen = remember([], hashed.map((x) => x.hash), settings.maxSeen);
    state.initialized = true;
    const reason = keyChanged ? 'Clé anti-doublons modifiée' : 'Premier lancement';
    log(`${reason} : ${hashed.length} élément(s) enregistré(s), 0 notification.`);
  } else if (!channel) {
    const fresh = freshEntries(hashed, state.seen, rules);
    state.seen = remember(state.seen, fresh.map((e) => e.hash), settings.maxSeen);
    log('ntfy désactivé (NTFY_ENABLED=false) : aucune notification ntfy.');
  } else {
    const fresh = freshEntries(hashed, state.seen, rules);
    const { done, sent, failed } = await deliver({ send: (message, context) => channel.send(message, context), fresh, settings });
    state.seen = remember(state.seen, done, settings.maxSeen);
    log(`Nouveaux : ${fresh.length}. Notifications envoyées : ${sent}.${failed ? ` Échecs d'envoi : ${failed}.` : ''}`);
    failures += failed;
  }
  // L'état ntfy est sauvegardé avant Firebase : un incident côté Firebase ne doit jamais faire
  // renvoyer des notifications ntfy déjà parties.
  await persist();

  // 3. Firebase (indépendant de ntfy : l'un peut échouer sans gêner l'autre)
  if (firebase) {
    failures += await firebasePhase({ firebase, hashed, state, rules, settings, log, now, writeStatus, firebaseStep });
    await persist();
  }

  return failures > 0 ? 1 : 0;
}

// Retourne le nombre d'échecs.
async function firebasePhase({ firebase, hashed, state, rules, settings, log, now, writeStatus, firebaseStep }) {
  let failures = 0;

  // État de surveillance : à chaque exécution, même sans nouveau mail.
  if (!(await writeStatus(true))) failures += 1;
  if (firebase.down) {
    log('Firebase : service injoignable, le reste est reporté au prochain passage.');
    return failures;
  }

  if (!state.firebaseSeeded) {
    // Première synchronisation : les mails du flux sont écrits SANS push, puis marqués comme traités.
    const entries = freshEntries(hashed, [], rules);
    const step = await firebaseStep('la première synchronisation', () => firebase.seed(entries));
    if (step.ok) {
      state.fbSeen = remember([], hashed.map((x) => x.hash), settings.maxSeen);
      state.firebaseSeeded = true;
      log(`Firebase : première synchronisation, ${step.value} mail(s) écrit(s), 0 notification.`);
    } else {
      failures += 1;
    }
  } else {
    const fresh = freshEntries(hashed, state.fbSeen, rules);
    const { done, failed } = await deliver({ send: (message, context) => firebase.send(message, context), fresh, settings });
    state.fbSeen = remember(state.fbSeen, done, settings.maxSeen);
    const { written, pushed, pushFailed, devicesRemoved } = firebase.stats;
    log(
      `Firebase : nouveaux : ${fresh.length}. Mails écrits : ${written}. Push envoyés : ${pushed}.` +
        `${pushFailed ? ` Push non remis : ${pushFailed}.` : ''}${devicesRemoved ? ` Appareils supprimés : ${devicesRemoved}.` : ''}` +
        `${failed ? ` Échecs : ${failed}.` : ''}`,
    );
    failures += failed;
  }

  // Nettoyage : mails de plus de 30 jours (100 au plus par exécution). Un échec ici n'est pas bloquant.
  if (!firebase.down) {
    const olderThan = new Date(now().getTime() - MAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const step = await firebaseStep('le nettoyage des anciens mails', () => firebase.cleanup({ olderThan, limit: CLEANUP_LIMIT }));
    if (step.ok && step.value > 0) log(`Firebase : ${step.value} ancien(s) mail(s) supprimé(s).`);
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // Aucun détail : une erreur inattendue pourrait contenir des données de mail.
      console.log('Erreur interne inattendue.');
      process.exitCode = 1;
    },
  ).finally(() => {
    // Filet de sécurité : si une connexion reste ouverte, le processus se termine quand même.
    setTimeout(() => process.exit(), 5000).unref();
  });
}
