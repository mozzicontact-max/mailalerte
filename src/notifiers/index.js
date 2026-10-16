// Choix des canaux de notification.
//  - NOTIFIER (« ntfy » par défaut) choisit le canal classique, désactivable avec NTFY_ENABLED=false.
//  - « firebase » (Firestore + push FCM) s'ajoute dès que FIREBASE_SERVICE_ACCOUNT et FIREBASE_UID
//    sont définis ; voir notifiers/firebase.js.
// Pour ajouter un canal (PWA...) : créer un fichier ici qui respecte le contrat de ntfy.js
// (ou de firebase.js s'il a besoin du mail complet), puis l'ajouter à `factories`.
import { createAdminBackend } from './firebase-admin.js';
import { createFirebaseNotifier } from './firebase.js';
import { createNtfyNotifier } from './ntfy.js';

const factories = {
  ntfy: ({ env, fetchImpl, sleep }) =>
    createNtfyNotifier({ topic: env.NTFY_TOPIC, server: env.NTFY_SERVER || undefined, fetchImpl, sleep }),

  // `firebaseBackend` : backend de remplacement (tests). Sinon firebase-admin, avec le JSON gardé en mémoire.
  firebase: ({ env, firebaseBackend, sleep, now }) =>
    createFirebaseNotifier({
      backend: firebaseBackend ?? createAdminBackend({ serviceAccount: env.FIREBASE_SERVICE_ACCOUNT, uid: env.FIREBASE_UID }),
      sleep,
      now,
    }),
};

export function createNotifier(name, options) {
  const factory = factories[name];
  if (!factory) throw new Error(`Canal de notification inconnu : « ${name} ».`);
  return factory(options);
}
