// Lecture du flux Zimbra : authentification, délai de 15 s, 2 nouvelles tentatives.
import { httpRequest, TransportError, withRetry } from './http.js';
import { looksLikeRss } from './rss.js';

function decodeBody(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const declared = /<\?xml[^>]*encoding=["']([\w.-]+)["']/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(declared).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Retourne { status, xml } ou lève une TransportError :
//   kind 'auth' (401/403, jamais rejouée), 'http', 'timeout', 'network', 'format'.
export async function fetchFeed({ url, authorization, fetchImpl, timeoutMs = 15000, retries = 2, sleep }) {
  return withRetry(
    async () => {
      const { status, bytes } = await httpRequest({
        fetchImpl,
        url,
        timeoutMs,
        init: { headers: { Authorization: authorization, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5' } },
      });
      if (status === 401 || status === 403) throw new TransportError('auth', { status });
      if (status === 429 || status >= 500) throw new TransportError('http', { status, retryable: true });
      if (status !== 200) throw new TransportError('http', { status });
      const xml = decodeBody(bytes);
      if (!looksLikeRss(xml)) throw new TransportError('format', { status });
      return { status, xml };
    },
    { retries, sleep },
  );
}
