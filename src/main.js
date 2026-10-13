// Point d'entrée : lit le flux, classe les nouveaux mails, notifie.
//
// RÈGLE DE JOURNALISATION : on n'écrit jamais d'objet, d'extrait, d'expéditeur,
// d'URL ni de secret. Seuls le code HTTP, des nombres et des catégories d'erreur sortent.
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { classify, compileRules } from './classify.js';
import { fetchFeed } from './feed.js';
import { authFailureMessage, digestMessage, mailMessage } from './message.js';
import { createNotifier } from './notifiers/index.js';
import { parseRss } from './rss.js';
import { emptyState, itemHash, keyFingerprint, loadState, remember, saveState } from './state.js';

const FEED_URL = 'https://wmailetu.univ-artois.fr/home/~/inbox.rss';
const RULES_URL = new URL('../rules.json', import.meta.url);

const ERROR_LABELS = {
  timeout: 'délai dépassé',
  network: 'réseau injoignable',
  http: 'réponse HTTP inattendue',
  format: 'réponse qui n’est pas un flux RSS',
};

export async function run({ env = process.env, fetchImpl = fetch, notifier, log = console.log, sleep } = {}) {
  // NTFY_TOPIC sert aussi de clé secrète pour les empreintes anti-doublons (HMAC).
  const { UNIV_USER: user, UNIV_PASSWORD: password, NTFY_TOPIC: hashKey } = env;
  if (!user || !password || !hashKey) {
    log('Configuration incomplète : secrets UNIV_USER, UNIV_PASSWORD et NTFY_TOPIC requis.');
    return 1;
  }

  const rules = compileRules(JSON.parse(await readFile(RULES_URL, 'utf8')));
  const { settings } = rules;
  const channel = notifier ?? createNotifier(env.NOTIFIER || 'ntfy', { env, fetchImpl, sleep });

  const statePath = env.STATE_PATH || '.cache/state.json';
  const state = await loadState(statePath);
  const stateBefore = JSON.stringify(state);

  // Si la clé a changé (ou si l'état vient d'une ancienne version), les empreintes
  // enregistrées ne sont plus comparables : on repart d'un état vide, sans notifier.
  const keyId = keyFingerprint(hashKey);
  const keyChanged = state.initialized && state.keyId !== keyId;
  if (state.keyId !== keyId) {
    Object.assign(state, { ...emptyState(), authAlertSent: state.authAlertSent, keyId });
  }

  async function persist() {
    if (JSON.stringify(state) === stateBefore) return;
    await saveState(statePath, state);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'state_changed=true\n');
  }

  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${authorization}`);

  // 1. Lecture du flux
  let feed;
  try {
    feed = await fetchFeed({ url: FEED_URL, authorization, fetchImpl, sleep });
  } catch (err) {
    if (err.kind === 'auth') {
      log(`Flux : accès refusé (HTTP ${err.status}).`);
      if (state.authAlertSent) {
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
    return 1;
  }

  const items = parseRss(feed.xml);
  log(`Flux : HTTP ${feed.status}, ${items.length} élément(s).`);
  state.authAlertSent = false;

  const hashed = items.map((item) => ({ item, hash: itemHash(item, hashKey) }));

  // 2. Premier lancement : tout enregistrer sans notifier
  if (!state.initialized) {
    state.seen = remember([], hashed.map((x) => x.hash), settings.maxSeen);
    state.initialized = true;
    const reason = keyChanged ? 'Clé anti-doublons modifiée' : 'Premier lancement';
    log(`${reason} : ${hashed.length} élément(s) enregistré(s), 0 notification.`);
    await persist();
    return 0;
  }

  // 3. Nouveaux éléments, du plus ancien au plus récent
  const seen = new Set(state.seen);
  const fresh = [];
  for (const entry of hashed) {
    if (seen.has(entry.hash) || fresh.some((f) => f.hash === entry.hash)) continue;
    fresh.push({ ...entry, classification: classify(entry.item, rules), time: Date.parse(entry.item.pubDate) });
  }
  fresh.reverse();
  fresh.sort((a, b) => a.time - b.time || 0);

  const immediate = fresh.filter((e) => e.classification.mode === 'immediate');
  const digest = fresh.filter((e) => e.classification.mode === 'digest');
  const done = fresh.filter((e) => e.classification.mode === 'ignore').map((e) => e.hash);

  // 4. Envoi. Un élément n'est marqué « vu » que si sa notification est partie.
  //    Au premier échec temporaire on s'arrête : le reste sera retenté au prochain passage.
  let sent = 0;
  let failed = 0;
  let stopped = false;

  for (const entry of immediate) {
    try {
      await channel.send(mailMessage(entry.item, entry.classification, settings));
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
      await channel.send(digestMessage(digest, settings));
      sent += 1;
      done.push(...digest.map((e) => e.hash));
    } catch (err) {
      failed += 1;
      if (!err.retryable) done.push(...digest.map((e) => e.hash));
    }
  }

  state.seen = remember(state.seen, done, settings.maxSeen);
  log(`Nouveaux : ${fresh.length}. Notifications envoyées : ${sent}.${failed ? ` Échecs d'envoi : ${failed}.` : ''}`);
  await persist();
  return failed > 0 ? 1 : 0;
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
  );
}
