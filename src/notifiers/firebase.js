// Canal Firebase : écrit chaque mail dans Firestore (users/{uid}/mails/{id}) puis envoie un push FCM
// aux appareils enregistrés (users/{uid}/devices). Il s'ajoute à ntfy sans le remplacer.
//
// Contrat (extension de celui de ntfy.js) :
//   send(message, context)
//     message = { title, message, priority, clickUrl } (neutre, voir message.js)
//     context = { type: 'mail', entry } ou { type: 'digest', entries }
//   - résout si le mail est écrit ET le push traité ;
//   - sinon lève une FirebaseError avec `retryable`.
//
// Ce fichier contient la logique ; les appels réseau passent par un « backend » :
//   createMail(id, data) -> 'created' | 'exists'     (ne touche jamais à un mail déjà présent)
//   listDevices() -> string[]                          (jetons FCM = identifiants des documents)
//   deleteDevice(token)
//   sendPush(messages) -> [{ ok, code? }]              (un résultat par message, dans l'ordre)
//   writeStatus({ mailbox, ok })                       (lastCheckAt = horodatage serveur)
//   deleteOldMails(olderThan, limit) -> nombre supprimé
//   close()
// Implémentation réelle : firebase-admin.js. Les tests utilisent un faux backend.
//
// RÈGLE DE JOURNALISATION : aucune erreur de Firebase ne sort telle quelle (son texte peut contenir
// des données). Tout est réduit à une catégorie fixe, avec un libellé fixe.
import { truncate } from '../message.js';
import { decodeEntities } from '../rss.js';

// ---------------------------------------------------------------- erreurs

const LABELS = {
  credentials: 'identifiants illisibles ou rejetés, vérifiez FIREBASE_SERVICE_ACCOUNT',
  module: 'module firebase-admin introuvable, npm ci n’a pas été exécuté',
  auth: 'accès refusé, vérifiez les droits du compte de service et l’activation des API',
  notfound: 'base Firestore introuvable, a-t-elle été créée ?',
  transient: 'service indisponible ou quota dépassé',
  timeout: 'délai dépassé',
  network: 'réseau injoignable',
  invalid: 'données refusées par Firebase',
  unknown: 'erreur inattendue',
};

// Erreurs passagères : rejouées tout de suite (une fois), puis le canal s'arrête pour ce passage.
const TRANSIENT = new Set(['transient', 'timeout', 'network']);

export class FirebaseError extends Error {
  // Le message est la catégorie : jamais de texte venu de Firebase.
  // `retryable` : le mail n'est pas marqué « vu » et sera retenté au prochain passage.
  constructor(category, { retryable = category !== 'invalid' } = {}) {
    super(category);
    this.name = 'FirebaseError';
    this.category = category;
    this.retryable = retryable;
  }
}

export function firebaseErrorLabel(err) {
  const category = err instanceof FirebaseError ? err.category : classifyError(err);
  return LABELS[category] ?? LABELS.unknown;
}

const GRPC = { 2: 'transient', 3: 'invalid', 4: 'transient', 5: 'notfound', 7: 'auth', 8: 'transient', 10: 'transient', 13: 'transient', 14: 'transient', 16: 'auth' };

const FCM = {
  'messaging/registration-token-not-registered': 'token',
  'messaging/invalid-registration-token': 'token',
  'messaging/server-unavailable': 'transient',
  'messaging/internal-error': 'transient',
  'messaging/message-rate-exceeded': 'transient',
  'messaging/device-message-rate-exceeded': 'transient',
  'messaging/authentication-error': 'auth',
  'messaging/third-party-auth-error': 'auth',
  'messaging/mismatched-credential': 'auth',
  'messaging/invalid-argument': 'invalid',
  'messaging/invalid-payload': 'invalid',
  'messaging/payload-size-limit-exceeded': 'invalid',
};

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']);

// Catégorie d'une erreur quelconque (on lit le code, et le message seulement pour reconnaître
// un problème de clé ; il n'est jamais écrit nulle part).
export function classifyError(err) {
  const code = err?.code;
  if (typeof code === 'number' && GRPC[code]) return GRPC[code];
  if (typeof code === 'string') {
    if (FCM[code]) return FCM[code];
    if (code === 'app/invalid-credential') return 'credentials';
    if (NETWORK_CODES.has(code)) return 'network';
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return 'module';
  }
  if (/private key|DECODER|PEM routines|invalid_grant|default credentials/i.test(String(err?.message ?? ''))) return 'credentials';
  return 'unknown';
}

// ---------------------------------------------------------------- mise en forme

const LEVEL_CHANNELS = { urgent: 'mails_urgent_v1', normal: 'mails_normal_v1', digest: 'mails_digest_v1' };

// 'digest' si la règle est en résumé ; 'urgent' si la priorité est maximale (5) ; sinon 'normal'.
export function firebaseLevel(classification) {
  if (classification.mode === 'digest') return 'digest';
  return (classification.priority ?? 3) >= 5 ? 'urgent' : 'normal';
}

export const channelIdFor = (level) => LEVEL_CHANNELS[level];

// Mêmes règles que l'application (lib/util/sender.dart) : « Nom », sans adresse ni « (via …) ».
export function cleanSender(raw) {
  const trimmed = String(raw ?? '').trim();
  const rssStyle = /^[^\s<>"]+@[^\s<>"]+\s*\(([^)]+)\)$/.exec(trimmed); // Zimbra : « adresse (Nom) »
  if (rssStyle) return truncate(rssStyle[1].trim(), 80);

  const name = trimmed
    .replace(/<[^>]*>/g, ' ')
    .replace(/\(\s*via\s+[^)]*\)/gi, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (name && !/^[^\s@]+@[^\s@]+$/.test(name)) return truncate(name, 80);

  // Pas de nom : on en déduit un de l'adresse (« dana.exemple@… » -> « Dana Exemple »).
  const email = /[^\s<>"]+@[^\s<>"]+/.exec(trimmed)?.[0];
  if (!email) return truncate(trimmed, 80);
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!local) return truncate(email, 80);
  return truncate(local.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' '), 80);
}

// Description du flux sans HTML, 200 caractères au plus.
export function previewOf(html) {
  const tag = /<\/?[a-z][^>]*>/gi;
  const withoutBlocks = String(html ?? '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const text = decodeEntities(withoutBlocks.replace(tag, ' ').replace(/&nbsp;/gi, ' ')).replace(tag, ' '); // 2e passage : HTML échappé
  return truncate(text, 200);
}

// Adresse masquée : première lettre + *** + @domaine.
export function maskMailbox(user) {
  const [local, ...rest] = String(user ?? '').split('@');
  const first = Array.from(local)[0] ?? '';
  return rest.length > 0 ? `${first}***@${rest.join('@')}` : `${first}***`;
}

// Identifiant du document : 32 premiers caractères de l'empreinte HMAC déjà utilisée contre les doublons.
export const mailId = (hash) => hash.slice(0, 32);

export function mailDocument({ hash, item, classification, time }, now = new Date()) {
  return {
    id: mailId(hash),
    data: {
      title: truncate(item.title || '(sans objet)', 200),
      sender: cleanSender(item.author),
      matiere: classification.matiere || null,
      level: firebaseLevel(classification),
      preview: previewOf(item.excerpt),
      receivedAt: Number.isNaN(time) ? now : new Date(time),
      read: false,
    },
  };
}

// ---------------------------------------------------------------- canal

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFirebaseNotifier({ backend, sleep = defaultSleep, now = () => new Date(), opTimeoutMs = 15000 }) {
  const stats = { written: 0, pushed: 0, pushFailed: 0, devicesRemoved: 0 };
  let down = false; // service injoignable : on n'insiste pas, le reste attendra le prochain passage
  let tokens = null; // jetons lus une seule fois par passage

  function withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new FirebaseError('timeout')), opTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Appel protégé : délai maximal, une nouvelle tentative sur erreur passagère, erreur réduite à
  // sa catégorie. `keepOnConfigError` : en phase d'écriture, un refus d'accès ou une base absente
  // sont « réessayables » (le mail doit finir dans Firestore une fois la configuration corrigée) ;
  // en phase de push on ne rejoue que les pannes passagères (pas de rafale de vieux push).
  async function call(fn, { phase }) {
    const fail = (err) => {
      const category = err instanceof FirebaseError ? err.category : classifyError(err);
      const retryable = phase === 'push' ? TRANSIENT.has(category) : category !== 'invalid';
      return new FirebaseError(category, { retryable });
    };
    if (down) throw new FirebaseError('network');
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await withTimeout(Promise.resolve().then(fn));
      } catch (err) {
        const failure = fail(err);
        if (TRANSIENT.has(failure.category) && attempt < 2) {
          await sleep(2000);
          continue;
        }
        if (TRANSIENT.has(failure.category)) down = true;
        throw failure;
      }
    }
  }

  async function writeMail(entry) {
    const { id, data } = mailDocument(entry, now());
    const outcome = await call(() => backend.createMail(id, data), { phase: 'write' });
    if (outcome === 'created') stats.written += 1;
    return id;
  }

  async function deviceTokens() {
    tokens ??= await call(() => backend.listDevices(), { phase: 'push' });
    return tokens;
  }

  async function push(message, id, level) {
    const targets = [...(await deviceTokens())];
    if (targets.length === 0) return;
    const build = (token) => ({
      token,
      notification: { title: message.title, body: message.message },
      data: { mailId: id },
      android: { priority: 'high', notification: { channelId: channelIdFor(level) } },
    });

    let pending = targets;
    let sent = 0;
    let rejected = 0;
    let firstRejection = null;
    const invalid = [];
    for (let attempt = 1; pending.length > 0 && attempt <= 2; attempt += 1) {
      const results = await call(() => backend.sendPush(pending.map(build)), { phase: 'push' });
      const retry = [];
      results.forEach((result, i) => {
        if (result.ok) {
          sent += 1;
          return;
        }
        const category = FCM[result.code] ?? 'unknown';
        if (category === 'token') invalid.push(pending[i]);
        else if (category === 'transient') retry.push(pending[i]);
        else {
          rejected += 1;
          firstRejection ??= category;
        }
      });
      pending = retry;
      if (pending.length > 0 && attempt < 2) await sleep(2000);
    }

    // Jeton invalide ou non enregistré : l'appareil n'existe plus, on supprime son document.
    for (const token of invalid) {
      try {
        await call(() => backend.deleteDevice(token), { phase: 'push' });
        stats.devicesRemoved += 1;
        tokens = tokens.filter((t) => t !== token);
      } catch {
        // pas grave : le jeton sera retrouvé invalide au prochain envoi
      }
    }

    stats.pushed += sent;
    stats.pushFailed += rejected + pending.length;
    // Rien n'est parti : panne passagère -> réessayer plus tard ; refus définitif -> signaler sans réessayer.
    // Si au moins un appareil a reçu le push, on ne rejoue pas (cela doublerait la notification).
    if (sent === 0 && pending.length > 0) throw new FirebaseError('transient');
    if (sent === 0 && rejected > 0) throw new FirebaseError(firstRejection, { retryable: false });
  }

  return {
    name: 'firebase',
    stats,

    get down() {
      return down;
    },

    async send(message, context) {
      if (context?.type === 'mail') {
        const id = await writeMail(context.entry);
        await push(message, id, firebaseLevel(context.entry.classification));
      } else if (context?.type === 'digest') {
        let lastId;
        for (const entry of context.entries) lastId = await writeMail(entry); // du plus ancien au plus récent
        await push(message, lastId, 'digest');
      }
    },

    // Première synchronisation : écrit les mails sans aucun push. Retourne le nombre de mails traités.
    async seed(entries) {
      let count = 0;
      for (const entry of entries) {
        if (entry.classification.mode === 'ignore') continue;
        await writeMail(entry);
        count += 1;
      }
      return count;
    },

    async writeStatus({ mailbox, ok }) {
      await call(() => backend.writeStatus({ mailbox, ok }), { phase: 'write' });
    },

    // Supprime les mails reçus avant `olderThan` (au plus `limit`). Retourne le nombre supprimé.
    async cleanup({ olderThan, limit }) {
      return call(() => backend.deleteOldMails(olderThan, limit), { phase: 'write' });
    },

    async close() {
      try {
        await backend.close?.();
      } catch {
        // rien à signaler : on ferme seulement les connexions
      }
    },
  };
}
