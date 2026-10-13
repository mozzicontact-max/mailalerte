// Briques réseau communes (lecture du flux et envoi des notifications).
// Aucune URL, en-tête ni message d'erreur du réseau ne sort de ce module :
// seules des catégories simples (timeout, network, auth, http, format).

export class TransportError extends Error {
  constructor(kind, { status, retryable = false } = {}) {
    super(status ? `${kind} (HTTP ${status})` : kind);
    this.name = 'TransportError';
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exécute fn ; rejoue uniquement les erreurs marquées « retryable ».
// `retries` = nombre de nouvelles tentatives (2 => 3 tentatives au total).
export async function withRetry(fn, { retries = 2, baseDelayMs = 2000, sleep = defaultSleep } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (err) {
      if (!err.retryable || attempt > retries) {
        err.attempts = attempt;
        throw err;
      }
      await sleep(baseDelayMs * attempt);
    }
  }
}

// Une requête HTTP avec délai maximal. Ne suit jamais les redirections
// (pour ne pas envoyer d'identifiants ailleurs). Retourne { status, bytes }.
export async function httpRequest({ fetchImpl = fetch, url, init = {}, timeoutMs = 15000 }) {
  try {
    const res = await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, bytes };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new TransportError(timedOut ? 'timeout' : 'network', { retryable: true });
  }
}
