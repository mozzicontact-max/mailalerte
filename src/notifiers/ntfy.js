// Canal de notification ntfy.sh.
//
// Contrat commun à tous les canaux :
//   send({ title, message, priority, clickUrl })
//   - résout si la notification est partie ;
//   - sinon lève une erreur avec `retryable` (true : réessayer plus tard,
//     false : refus définitif, inutile de réessayer).
import { httpRequest, TransportError, withRetry } from '../http.js';

// Les en-têtes HTTP doivent être en ASCII : les accents passent en RFC 2047 (UTF-8, base64),
// que ntfy décode.
export function encodeHeader(value) {
  const clean = String(value).replace(/[\r\n\t]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

export function createNtfyNotifier({ topic, server = 'https://ntfy.sh', fetchImpl, timeoutMs = 15000, retries = 2, sleep }) {
  if (!topic) throw new Error('NTFY_TOPIC manquant.');
  const url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;

  return {
    name: 'ntfy',
    async send({ title, message, priority, clickUrl }) {
      const headers = {
        Title: encodeHeader(title),
        Priority: String(priority),
        'Content-Type': 'text/plain; charset=utf-8',
      };
      if (clickUrl) headers.Click = clickUrl;

      await withRetry(
        async () => {
          const { status } = await httpRequest({
            fetchImpl,
            url,
            timeoutMs,
            init: { method: 'POST', headers, body: message },
          });
          if (status === 429 || status >= 500) throw new TransportError('http', { status, retryable: true });
          if (status < 200 || status >= 300) throw new TransportError('http', { status });
        },
        { retries, sleep },
      );
    },
  };
}
