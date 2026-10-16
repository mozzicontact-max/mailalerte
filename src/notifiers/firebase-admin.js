// Backend Firebase réel (firebase-admin). Voir le contrat dans firebase.js.
//
// - Le JSON du compte de service reste en mémoire : jamais écrit dans un fichier.
// - firebase-admin n'est chargé qu'à la première utilisation (sans Firebase, rien n'est importé).
// - Aucune erreur de la bibliothèque n'est relayée : seulement une FirebaseError (catégorie fixe).
import { FirebaseError } from './firebase.js';

const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const isValidUid = (uid) => UID_PATTERN.test(uid ?? '');

export function createAdminBackend({ serviceAccount, uid }) {
  if (!isValidUid(uid)) throw new FirebaseError('credentials');
  let started = null;

  async function init() {
    let credentials;
    try {
      credentials = JSON.parse(serviceAccount);
    } catch {
      throw new FirebaseError('credentials');
    }
    if (credentials === null || typeof credentials !== 'object') throw new FirebaseError('credentials');

    let appModule;
    let firestoreModule;
    let messagingModule;
    try {
      [appModule, firestoreModule, messagingModule] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/firestore'),
        import('firebase-admin/messaging'),
      ]);
    } catch {
      throw new FirebaseError('module');
    }

    let app;
    try {
      app = appModule.initializeApp({ credential: appModule.cert(credentials) }, 'mailalerte-poll');
    } catch {
      throw new FirebaseError('credentials');
    }
    return {
      app,
      deleteApp: appModule.deleteApp,
      db: firestoreModule.getFirestore(app),
      messaging: messagingModule.getMessaging(app),
      FieldValue: firestoreModule.FieldValue,
      Timestamp: firestoreModule.Timestamp,
    };
  }

  const ready = () => (started ??= init());
  const base = `users/${uid}`;

  return {
    async createMail(id, data) {
      const { db, Timestamp } = await ready();
      try {
        // create() échoue si le document existe : on ne réécrit jamais `read` d'un mail déjà lu.
        await db.doc(`${base}/mails/${id}`).create({ ...data, receivedAt: Timestamp.fromDate(data.receivedAt) });
        return 'created';
      } catch (err) {
        if (err?.code === 6) return 'exists'; // ALREADY_EXISTS
        throw err;
      }
    },

    async listDevices() {
      const { db } = await ready();
      return (await db.collection(`${base}/devices`).get()).docs.map((doc) => doc.id);
    },

    async deleteDevice(token) {
      const { db } = await ready();
      await db.doc(`${base}/devices/${token}`).delete();
    },

    async sendPush(messages) {
      const { messaging } = await ready();
      const { responses } = await messaging.sendEach(messages);
      return responses.map((r) => (r.success ? { ok: true } : { ok: false, code: r.error?.code }));
    },

    async writeStatus({ mailbox, ok }) {
      const { db, FieldValue } = await ready();
      await db.doc(`${base}/status/current`).set({ mailbox, ok, lastCheckAt: FieldValue.serverTimestamp() });
    },

    async deleteOldMails(olderThan, limit) {
      const { db, Timestamp } = await ready();
      const snapshot = await db
        .collection(`${base}/mails`)
        .where('receivedAt', '<', Timestamp.fromDate(olderThan))
        .orderBy('receivedAt')
        .limit(limit)
        .get();
      if (snapshot.empty) return 0;
      const batch = db.batch();
      for (const doc of snapshot.docs) batch.delete(doc.ref);
      await batch.commit();
      return snapshot.size;
    },

    // Ferme les connexions (sinon le processus peut rester ouvert après la fin du travail).
    async close() {
      if (!started) return;
      try {
        const { app, deleteApp } = await started;
        await deleteApp(app);
      } catch {
        // rien à fermer
      }
    },
  };
}
