// Toutes les données de ce fichier sont INVENTÉES (noms, objets, extraits, adresses en
// example.org). L'adresse de la présidence n'est pas recopiée ici : elle est lue dans
// rules.json, puisque c'est précisément celle que la règle doit reconnaître.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { classify, compileRules, extractMatiere } from '../src/classify.js';
import { digestMessage, mailMessage, truncate } from '../src/message.js';

const rulesConfig = JSON.parse(await readFile(new URL('../rules.json', import.meta.url), 'utf8'));
const rules = compileRules(rulesConfig);
const mail = (over) => ({ title: 'Bonjour', excerpt: '', author: 'prof.test@example.org', pubDate: '', ...over });
const MOODLE = '"Alice Test (via Moodle Artois)" <ne-pas-repondre@moodle.example.org>';
const PRESIDENCE_ADDRESS = rulesConfig.rules.find((r) => r.level === 'urgent').senders[0];
const PRESIDENCE = `"Présidence" <${PRESIDENCE_ADDRESS}>`;

const levelOf = (item) => classify(item, rules).level;

test('« très urgent » dans l’objet → urgent, priorité 5, immédiat', () => {
  const c = classify(mail({ title: 'Message TRÈS URGENT' }), rules);
  assert.deepEqual([c.level, c.priority, c.mode], ['urgent', 5, 'immediate']);
});

test('mot-clé trouvé dans l’extrait, sans tenir compte des accents', () => {
  assert.equal(levelOf(mail({ excerpt: 'Le cours est ANNULE demain' })), 'urgent');
  assert.equal(levelOf(mail({ title: 'Cours annulée' })), 'urgent');
});

test('nouveaux mots-clés : réouverture, ouverture, grève, fermé, rattrapage', () => {
  for (const title of [
    'Réouverture de la bibliothèque',
    'Ouverture exceptionnelle samedi',
    'Mouvement de grève lundi',
    'Le bâtiment est fermé',
    'Séance de rattrapage jeudi',
  ]) {
    assert.equal(levelOf(mail({ title })), 'urgent', title);
  }
});

test('les mots-clés sont des mots entiers : « à noter » n’est pas « note »', () => {
  assert.notEqual(levelOf(mail({ title: 'À noter : réunion' })), 'urgent');
  assert.equal(levelOf(mail({ title: 'Vos notes sont disponibles' })), 'urgent');
});

// --- L'urgence l'emporte sur les préfixes [etudiant] / [lef-etu] -------------------------

test('urgence de la présidence avec le préfixe [etudiant] → urgent', () => {
  const c = classify(mail({ author: PRESIDENCE, title: '[etudiant] Information importante pour tous' }), rules);
  assert.deepEqual([c.level, c.priority, c.mode], ['urgent', 5, 'immediate']);
});

test('expéditeur de la présidence (casse variable) → urgent', () => {
  assert.equal(levelOf(mail({ author: `"Présidence" <${PRESIDENCE_ADDRESS.toUpperCase()}>` })), 'urgent');
});

test('mot-clé d’urgence avec [etudiant] ou [lef-etu] → urgent', () => {
  assert.equal(levelOf(mail({ title: '[etudiant] Fermeture du restaurant universitaire' })), 'urgent');
  assert.equal(levelOf(mail({ title: '[lef-etu] Examens reportés', excerpt: '' })), 'urgent');
  assert.equal(levelOf(mail({ title: '[lef-etu] Informations', excerpt: 'Séance de rattrapage annulée' })), 'urgent');
});

test('annonce de faculté [lef-etu] sans mot-clé → bas (résumé)', () => {
  const c = classify(
    mail({
      author: '"Secrétariat Faculté Exemple" <secretariat@faculte.example.org>',
      title: '[lef-etu] Calendrier des réunions de rentrée',
      excerpt: 'La faculté invite les étudiants de première année à une réunion.',
    }),
    rules,
  );
  assert.deepEqual([c.level, c.priority, c.mode], ['bas', 2, 'digest']);
});

test('[etudiant] sans mot-clé → bas', () => {
  assert.equal(levelOf(mail({ title: '[etudiant] Bourse aux livres' })), 'bas');
});

// --- Autres formats -----------------------------------------------------------------------

test('newsletter événementielle → bas (résumé)', () => {
  const c = classify(
    mail({
      author: '"Service Culture Exemple" <culture@example.org>',
      title: 'Newsletter : les événements du mois',
      excerpt: 'Concert, exposition et foire aux projets au programme.',
    }),
    rules,
  );
  assert.deepEqual([c.level, c.priority, c.mode], ['bas', 2, 'digest']);
});

test('mail Moodle avec « -> » : normal, matière avant le premier « -> »', () => {
  const c = classify(
    mail({
      title: 'Nouvelle séance ajoutée',
      excerpt: 'Histoire fictive -> Forums -> Annonces -> Nouvelle séance ajoutée',
      author: MOODLE,
    }),
    rules,
  );
  assert.deepEqual([c.level, c.priority, c.matiere, c.rule], ['normal', 3, 'Histoire fictive', 'Moodle']);
});

test('mail Moodle « Nouveau contenu de … » sans « -> » : matière tirée de l’objet', () => {
  const c = classify(
    mail({
      title: 'Nouveau contenu de Chimie imaginaire',
      excerpt: 'Un nouveau fichier a été ajouté au cours.',
      author: MOODLE,
    }),
    rules,
  );
  assert.deepEqual([c.level, c.priority, c.matiere, c.rule], ['normal', 3, 'Chimie imaginaire', 'Moodle']);
});

test('la matière de l’extrait (« -> ») est prioritaire sur celle de l’objet', () => {
  assert.equal(extractMatiere('Physique fictive -> Forums -> Annonces', 'Nouveau contenu de Autre cours'), 'Physique fictive');
});

test('matière : variantes de l’objet', () => {
  assert.equal(extractMatiere('', 'Nouveau contenu de : Algèbre fictive'), 'Algèbre fictive');
  assert.equal(extractMatiere('', 'NOUVEAU CONTENU DE «Logique fictive»'), 'Logique fictive');
  assert.equal(extractMatiere('', 'Nouveau contenu dedans'), '');
  assert.equal(extractMatiere('Pas de flèche', 'Autre objet'), '');
});

test('mail Moodle sans « -> » ni « Nouveau contenu de » : normal, sans matière', () => {
  const c = classify(mail({ title: 'Rappel du devoir', excerpt: 'Pensez au devoir.', author: MOODLE }), rules);
  assert.deepEqual([c.level, c.matiere], ['normal', '']);
});

test('un examen annoncé sur Moodle reste urgent (urgent passe avant Moodle)', () => {
  assert.equal(levelOf(mail({ title: 'Date de l’examen', author: MOODLE })), 'urgent');
});

test('mail d’un étudiant sans règle → niveau par défaut (normal)', () => {
  const c = classify(
    mail({
      author: '"Dana Exemple" <dana.exemple@example.org>',
      title: 'Re: Projet de groupe',
      excerpt: 'Salut, je te propose de nous retrouver mardi pour avancer.',
    }),
    rules,
  );
  assert.deepEqual([c.level, c.priority, c.mode, c.rule], ['normal', 3, 'immediate', 'Autre mail']);
});

test('scolarité → normal', () => {
  const c = classify(mail({ author: 'scolarite@example.org', title: 'Inscription' }), rules);
  assert.deepEqual([c.level, c.priority], ['normal', 3]);
});

test('événements, foires, newsletters → bas, groupés', () => {
  for (const title of ['Foire aux livres', 'Newsletter d’octobre', 'Un événement pour tous']) {
    const c = classify(mail({ title }), rules);
    assert.deepEqual([c.level, c.priority, c.mode], ['bas', 2, 'digest'], title);
  }
});

// --- Contenu des notifications -----------------------------------------------------------

test('notification : titre = objet seul ; ni extrait ni expéditeur', () => {
  const item = mail({
    title: 'Message très urgent',
    excerpt: 'EXTRAIT-INVENTE-123',
    author: '"Eve Inventée" <eve.inventee@example.org>',
  });
  const m = mailMessage(item, classify(item, rules), rules.settings);
  assert.equal(m.title, 'Message très urgent');
  const everything = JSON.stringify(m);
  for (const forbidden of ['EXTRAIT-INVENTE', 'Eve', 'eve.inventee', 'example.org']) {
    assert.ok(!everything.includes(forbidden), forbidden);
  }
});

test('notification Moodle : le corps contient la règle et la matière, rien d’autre', () => {
  const item = mail({
    title: 'Nouveau contenu de Chimie imaginaire',
    excerpt: 'EXTRAIT-INVENTE-456',
    author: MOODLE,
  });
  const m = mailMessage(item, classify(item, rules), rules.settings);
  assert.equal(m.message, 'Moodle · Chimie imaginaire');
  assert.ok(!JSON.stringify(m).includes('EXTRAIT-INVENTE'));
});

test('le titre est tronqué à 80 caractères', () => {
  const long = 'é'.repeat(200);
  const item = mail({ title: long });
  const m = mailMessage(item, classify(item, rules), rules.settings);
  assert.equal(Array.from(m.title).length, 80);
  assert.ok(m.title.endsWith('…'));
  assert.equal(truncate('court', 80), 'court');
  assert.equal(Array.from(truncate('a'.repeat(80), 80)).length, 80); // 80 pile : inchangé
});

test('le résumé groupé liste les objets, priorité 2', () => {
  const entries = ['A', 'B'].map((t) => {
    const item = mail({ title: `Newsletter ${t}` });
    return { item, classification: classify(item, rules) };
  });
  const d = digestMessage(entries, rules.settings);
  assert.equal(d.priority, 2);
  assert.equal(d.title, 'Infos : 2 nouveaux messages');
  assert.equal(d.message.split('\n').length, 2);
});

test('rules.json invalide : niveau inconnu refusé', () => {
  assert.throws(() => compileRules({ levels: { a: { mode: 'immediate' } }, settings: { defaultLevel: 'a' }, rules: [{ level: 'zzz' }] }));
});
