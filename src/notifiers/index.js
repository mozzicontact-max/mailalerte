// Choix du canal de notification (variable NOTIFIER, « ntfy » par défaut).
// Pour ajouter un canal (PWA, Flutter...) : créer un fichier ici qui respecte le
// contrat de ntfy.js, puis l'ajouter à `factories`.
import { createNtfyNotifier } from './ntfy.js';

const factories = {
  ntfy: ({ env, fetchImpl, sleep }) =>
    createNtfyNotifier({ topic: env.NTFY_TOPIC, server: env.NTFY_SERVER || undefined, fetchImpl, sleep }),
};

export function createNotifier(name, options) {
  const factory = factories[name];
  if (!factory) throw new Error(`Canal de notification inconnu : « ${name} ».`);
  return factory(options);
}
