// État conservé d'une exécution à l'autre (restauré/sauvegardé par actions/cache).
// Il ne contient que des empreintes (HMAC) et quelques indicateurs, jamais de texte de mail.
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// HMAC-SHA-256 de `expéditeur|date|objet`, clé secrète : sans la clé, les empreintes
// stockées dans le cache ne permettent pas de vérifier une hypothèse sur un mail.
export function itemHash({ author, pubDate, title }, key) {
  return createHmac('sha256', key).update(`${author}|${pubDate}|${title}`).digest('hex');
}

// Empreinte de la clé elle-même, pour détecter qu'elle a changé (sinon toutes les
// empreintes changeraient et les anciens mails seraient notifiés d'un coup).
export function keyFingerprint(key) {
  return createHmac('sha256', key).update('mailalerte:key-check').digest('hex').slice(0, 16);
}

export function emptyState() {
  // initialized=false : le prochain lancement réussi enregistre tout sans notifier.
  // authAlertSent : la notification « connexion refusée » a déjà été envoyée.
  // keyId : empreinte de la clé de hachage utilisée pour `seen` et `fbSeen`.
  // fbSeen : empreintes déjà traitées par le canal Firebase (liste distincte de `seen`, pour que
  //   ntfy et Firebase se réessaient chacun de leur côté sans doublon chez l'autre).
  // firebaseSeeded : Firestore a déjà reçu les mails présents dans le flux (première
  //   synchronisation faite, sans push).
  return { version: 1, initialized: false, seen: [], authAlertSent: false, keyId: null, fbSeen: [], firebaseSeeded: false };
}

export async function loadState(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return {
      ...emptyState(),
      initialized: raw.initialized === true,
      authAlertSent: raw.authAlertSent === true,
      keyId: typeof raw.keyId === 'string' ? raw.keyId : null,
      seen: Array.isArray(raw.seen) ? raw.seen.filter((h) => typeof h === 'string') : [],
      fbSeen: Array.isArray(raw.fbSeen) ? raw.fbSeen.filter((h) => typeof h === 'string') : [],
      firebaseSeeded: raw.firebaseSeeded === true,
    };
  } catch {
    return emptyState();
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state), 'utf8');
}

// Ajoute les nouveaux hash en tête et garde au plus `max` entrées.
export function remember(seen, newHashes, max = 200) {
  const added = new Set(newHashes);
  return [...newHashes, ...seen.filter((h) => !added.has(h))].slice(0, max);
}
