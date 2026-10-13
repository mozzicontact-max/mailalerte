// Classement des mails selon rules.json. Indépendant de la méthode de notification.
//
// Une règle correspond si AU MOINS UN de ses critères correspond.
// Les règles sont lues dans l'ordre : la première qui correspond l'emporte.
// Comparaisons sans tenir compte des majuscules ni des accents ; un mot-clé
// est cherché comme mot entier (« note » trouve « Note » et « notes » si
// « notes » est aussi dans la liste, mais pas « à noter » ni « annoter »).

const LETTER_OR_DIGIT = '[\\p{L}\\p{N}]';

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wholeWordRegex(keyword) {
  return new RegExp(`(?<!${LETTER_OR_DIGIT})${escapeRegex(keyword)}(?!${LETTER_OR_DIGIT})`, 'u');
}

export function extractEmail(author) {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(author ?? '')?.[0].toLowerCase() ?? '';
}

const cleanMatiere = (text) => text.replace(/^[\s«"'“]+|[\s»"'”]+$/g, '').slice(0, 60);

// 1. Extrait « Mathématiques -> Forums -> Annonces -> Titre » => « Mathématiques »
// 2. À défaut de « -> », objet « Nouveau contenu de Mathématiques » => « Mathématiques »
export function extractMatiere(excerpt, title) {
  const arrow = (excerpt ?? '').indexOf('->');
  if (arrow > 0) {
    const fromExcerpt = cleanMatiere(excerpt.slice(0, arrow));
    if (fromExcerpt) return fromExcerpt;
  }
  const fromTitle = /nouveau\s+contenu\s+\bde\b\s*[:\-–—]?\s*(.+)/i.exec(title ?? '');
  return fromTitle ? cleanMatiere(fromTitle[1]) : '';
}

const list = (value) => (Array.isArray(value) ? value : []).map(normalize).filter(Boolean);

export function compileRules(config) {
  const levels = config.levels ?? {};
  const settings = { defaultLevel: 'normal', maxTitleLength: 80, maxSeen: 200, clickUrl: '', ...config.settings };

  if (!levels[settings.defaultLevel]) {
    throw new Error(`rules.json : le niveau par défaut « ${settings.defaultLevel} » n'existe pas dans « levels ».`);
  }
  for (const [name, level] of Object.entries(levels)) {
    if (!['immediate', 'digest', 'ignore'].includes(level.mode)) {
      throw new Error(`rules.json : le niveau « ${name} » doit avoir un mode « immediate », « digest » ou « ignore ».`);
    }
  }

  const rules = (config.rules ?? []).map((rule, index) => {
    const name = rule.name ?? `Règle ${index + 1}`;
    if (!levels[rule.level]) {
      throw new Error(`rules.json : la règle « ${name} » utilise un niveau inconnu « ${rule.level} ».`);
    }
    return {
      name,
      level: rule.level,
      extractMatiere: rule.extract === 'matiere',
      senders: list(rule.senders),
      senderContains: list(rule.senderContains),
      authorContains: list(rule.authorContains),
      subjectPrefixes: list(rule.subjectPrefixes),
      keywords: list(rule.keywords).map(wholeWordRegex),
    };
  });

  return { settings, levels, rules };
}

function matches(rule, mail) {
  if (rule.senders.includes(mail.email)) return true;
  if (rule.senderContains.some((s) => mail.author.includes(s))) return true;
  if (rule.authorContains.some((s) => mail.author.includes(s))) return true;
  if (rule.subjectPrefixes.some((p) => mail.title.startsWith(p))) return true;
  return rule.keywords.some((re) => re.test(mail.text));
}

// Retourne { rule, level, mode, priority, matiere }.
export function classify(item, compiled) {
  const mail = {
    author: normalize(item.author),
    email: extractEmail(item.author),
    title: normalize(item.title),
  };
  mail.text = `${mail.title} ${normalize(item.excerpt)}`;

  for (const rule of compiled.rules) {
    if (matches(rule, mail)) {
      const level = compiled.levels[rule.level];
      return {
        rule: rule.name,
        level: rule.level,
        mode: level.mode,
        priority: level.priority ?? 3,
        matiere: rule.extractMatiere ? extractMatiere(item.excerpt, item.title) : '',
      };
    }
  }

  const level = compiled.levels[compiled.settings.defaultLevel];
  return {
    rule: 'Autre mail',
    level: compiled.settings.defaultLevel,
    mode: level.mode,
    priority: level.priority ?? 3,
    matiere: '',
  };
}
