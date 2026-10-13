// Outils de test. Toutes les données ci-dessous sont inventées.
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function rssFeed(items) {
  const body = items
    .map(
      (i) =>
        `<item><title>${esc(i.title)}</title><description>${esc(i.excerpt ?? '')}</description>` +
        `<author>${esc(i.author ?? 'prof.test@example.org')}</author>` +
        `<pubDate>${i.pubDate ?? 'Mon, 05 Oct 2026 10:00:00 GMT'}</pubDate></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Inbox</title>${body}</channel></rss>`;
}

// fetch factice : handler(callNumber) -> { status, body }
export function fakeFetch(handler) {
  const f = async () => {
    f.calls += 1;
    const { status = 200, body = '' } = await handler(f.calls);
    return { status, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  f.calls = 0;
  return f;
}

export function fakeNotifier({ failWith } = {}) {
  const sent = [];
  return {
    name: 'fake',
    sent,
    async send(message) {
      if (failWith) throw Object.assign(new Error('boom'), { retryable: failWith === 'retryable' });
      sent.push(message);
    },
  };
}

export const noSleep = async () => {};
