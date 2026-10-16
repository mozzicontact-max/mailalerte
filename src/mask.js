// Masquage dans les journaux GitHub Actions des morceaux du compte de service Firebase.
//
// `::add-mask::` ne sait masquer qu'UNE ligne à la fois : faire `echo "::add-mask::$JSON"` sur un
// JSON de plusieurs lignes laisserait les autres lignes s'écrire en clair. On masque donc chaque
// champ sensible séparément, et chaque ligne d'un champ multiligne (la clé privée) séparément,
// depuis le programme, avant tout autre affichage. La clé privée est aussi masquée sous sa forme
// « JSON » (avec des \n littéraux), qui tient sur une seule ligne.
//
// Limite : une ligne de moins de 4 caractères n'est pas masquée (masquer « A » ou « == » rendrait
// tous les journaux illisibles ; 3 caractères de base64 ne permettent de rien reconstituer).
export const MIN_MASK_LENGTH = 4;

const SENSITIVE_FIELDS = ['private_key', 'private_key_id', 'client_email', 'client_id'];

export function secretFragments(rawJson) {
  const fragments = new Set();
  const add = (value) => {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string') return;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_MASK_LENGTH) fragments.add(trimmed);
    }
  };

  let parsed = null;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    // JSON illisible : on masque chaque ligne telle quelle.
  }

  if (parsed !== null && typeof parsed === 'object') {
    for (const key of SENSITIVE_FIELDS) add(parsed[key]);
    if (typeof parsed.private_key === 'string') add(JSON.stringify(parsed.private_key).slice(1, -1));
  } else {
    add(rawJson);
  }
  return [...fragments];
}
