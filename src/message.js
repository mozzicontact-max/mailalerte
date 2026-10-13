// Messages neutres, indépendants du canal (ntfy, PWA, Flutter...).
// Forme : { title, message, priority (1-5), clickUrl }
// Un canal de notification n'a qu'à savoir envoyer ce format.

export function truncate(text, max) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export function mailMessage(item, classification, settings) {
  const { rule, matiere, priority } = classification;
  return {
    title: truncate(item.title || '(sans objet)', settings.maxTitleLength),
    message: matiere ? `${rule} · ${matiere}` : rule,
    priority,
    clickUrl: settings.clickUrl,
  };
}

// Résumé groupé des messages de faible priorité.
export function digestMessage(entries, settings) {
  const n = entries.length;
  return {
    title: `Infos : ${n} nouveau${n > 1 ? 'x' : ''} message${n > 1 ? 's' : ''}`,
    message: entries.map(({ item }) => `• ${truncate(item.title || '(sans objet)', settings.maxTitleLength)}`).join('\n'),
    priority: Math.max(...entries.map(({ classification }) => classification.priority)),
    clickUrl: settings.clickUrl,
  };
}

export function authFailureMessage(status) {
  return {
    title: 'Connexion refusée',
    message: `Le serveur mail a répondu ${status}. Vérifiez UNIV_USER et UNIV_PASSWORD dans les secrets GitHub.`,
    priority: 4,
    clickUrl: '',
  };
}
