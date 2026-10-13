// Lecture minimale d'un flux RSS 2.0 (sans dépendance).
// Produit des éléments neutres : { title, excerpt, author, pubDate }.

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1].toLowerCase() === 'x';
      const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

// Texte d'un élément : sections CDATA gardées telles quelles, entités décodées
// ailleurs, balises éventuelles retirées, espaces compactés.
function textOf(inner) {
  let out = '';
  for (const m of inner.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<[^>]*>|([^<]+)/g)) {
    if (m[1] !== undefined) out += m[1];
    else if (m[2] !== undefined) out += decodeEntities(m[2]);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function field(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i');
    const m = block.match(re);
    if (m) return textOf(m[1]);
  }
  return '';
}

export function looksLikeRss(xml) {
  return /<rss[\s>]/i.test(xml) || /<channel[\s>]/i.test(xml);
}

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)) {
    items.push({
      title: field(m[1], ['title']),
      excerpt: field(m[1], ['description']),
      author: field(m[1], ['author', 'dc:creator']),
      pubDate: field(m[1], ['pubDate']),
    });
  }
  return items;
}
