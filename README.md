# mailalerte

Reçois une **notification sur ton téléphone** quand un mail important arrive dans ta boîte mail universitaire (Zimbra), sans serveur à gérer et gratuitement.

- **GitHub Actions** (gratuit) consulte ta boîte toutes les 5 minutes.
- **ntfy** (gratuit) envoie la notification sur ton téléphone.
- Les mails sont classés automatiquement : urgent, normal, ou simple info regroupée.

Tu n'as pas besoin de savoir programmer. Compte environ 15 minutes.

---

## Ce qu'il te faut

- un compte [GitHub](https://github.com) (gratuit) ;
- l'adresse complète de ta boîte universitaire et son mot de passe ;
- un téléphone avec l'application **ntfy** (Android ou iPhone).

---

## Installation pas à pas

### 1. Faire un fork

Sur la page de ce dépôt, clique sur **Fork** (en haut à droite), puis **Create fork**. Tu obtiens ta propre copie, qui fonctionnera avec tes propres secrets.

### 2. Installer ntfy sur ton téléphone

1. Installe l'application **ntfy** (Play Store ou F-Droid sur Android, App Store sur iPhone).
2. Ouvre-la, appuie sur **+** pour t'abonner à un sujet.
3. Choisis un nom de sujet **long et impossible à deviner**, par exemple `mail-artois-k8f3x9q2m7d4`. Ne mets pas ton nom.
   Ce nom est la seule protection de tes notifications : **toute personne qui le connaît peut les lire**.
4. Sur Android, autorise les notifications et, si besoin, désactive l'optimisation de batterie pour ntfy.

### 3. Créer les 3 secrets

Dans **ton fork** : **Settings → Secrets and variables → Actions → New repository secret**. Crée ces trois secrets, un par un :

| Nom | Valeur |
|---|---|
| `UNIV_USER` | ton adresse mail complète (`prenom.nom@univ-artois.fr`) |
| `UNIV_PASSWORD` | le mot de passe de ta boîte mail |
| `NTFY_TOPIC` | le nom du sujet choisi à l'étape 2, exactement (il sert aussi de clé secrète pour la mémoire anti-doublons) |

> Ne mets **jamais** ton mot de passe dans un fichier, une issue ou un message : le dépôt est public. Les secrets GitHub sont chiffrés et n'apparaissent pas dans les journaux.

### 4. Activer les Actions

Ouvre l'onglet **Actions** de ton fork. Si GitHub affiche un message, clique sur **I understand my workflows, go ahead and enable them**. (Sur un fork, les tâches planifiées sont désactivées tant que tu n'as pas fait cette étape.)

### 5. Lancer un test à la main

1. Onglet **Actions** → **Etape 0 - test du flux** (à gauche) → **Run workflow**.
   Résultat attendu dans le journal : `Code HTTP : 200` et `Flux RSS reconnu : oui`.
   Sinon, voir « Dépannage » plus bas.
2. Onglet **Actions** → **Surveillance de la boîte mail** → **Run workflow**.
   Résultat attendu : `Flux : HTTP 200, … élément(s).` puis `Premier lancement : … élément(s) enregistré(s), 0 notification.`

Le **premier lancement n'envoie rien** : il enregistre les mails déjà présents pour ne pas t'envoyer d'anciens messages. À partir de là, le programme tourne tout seul toutes les 5 minutes.

---

## Comment les mails sont classés

| Niveau | Notification | Quels mails |
|---|---|---|
| **Urgent** (priorité 5) | immédiate, avec son et vibration | objet ou extrait contenant : très urgent, urgent, fermeture, fermé, ouverture, réouverture, grève, annulation, annulé, report, rattrapage, examen, note ; ou expéditeur `presidence@univ-artois.fr` |
| **Normal** (priorité 3) | immédiate | annonces Moodle (la matière s'affiche dans la notification), scolarité, et tout mail qui ne correspond à aucune règle |
| **Bas** (priorité 2) | **une seule notification de résumé** par passage, discrète | objets `[etudiant]` ou `[lef-etu]`, événements, foires, newsletters |

**L'urgence l'emporte toujours** : un mail `[etudiant]` ou `[lef-etu]` de la présidence, ou contenant « fermeture », « grève »… reste urgent.

**Contenu de la notification** : le titre est l'objet du mail (80 caractères maximum). Le texte contient seulement le type de règle et, pour Moodle, la matière : elle est lue avant le premier « -> » de l'extrait ou, à défaut, dans un objet de la forme « Nouveau contenu de *Matière* ». L'extrait et l'expéditeur ne sont jamais envoyés.

### Modifier les règles

Tout se règle dans le fichier **`rules.json`**, sans toucher au code. Sur GitHub, ouvre le fichier et clique sur le crayon.

- Les règles sont lues **de haut en bas : la première qui correspond gagne**. Mets les plus importantes en premier.
- Une règle correspond si **au moins un** de ses critères correspond.
- Les majuscules et les accents sont ignorés.

| Critère | Effet |
|---|---|
| `keywords` | mots cherchés dans l'objet et l'extrait, **comme mots entiers** : `note` trouve « note » mais pas « à noter ». Pour « annulé » et « annulée », écris les deux. |
| `senders` | adresse exacte de l'expéditeur |
| `senderContains` | morceau de l'adresse ou du nom de l'expéditeur |
| `authorContains` | morceau du champ expéditeur (utilisé pour reconnaître Moodle) |
| `subjectPrefixes` | début de l'objet (par exemple `[etudiant]`) |

Exemple : être alerté immédiatement pour les mails de ton directeur d'études.

```json
{
  "name": "Directeur d'études",
  "level": "urgent",
  "senders": ["prenom.nom@univ-artois.fr"]
}
```

À placer dans la liste `"rules"`, avant la règle « Moodle ». Les niveaux possibles sont `urgent`, `normal`, `bas` et `ignorer` (aucune notification). Pour ne **pas** être alerté des mails sans règle, mets `"defaultLevel": "ignorer"` dans `settings`.

---

## Scénario de test

Il te faut deux boîtes mail : la tienne (celle qui est surveillée) et une autre (celle d'un ami ou un second compte).

**Avant de commencer** : le « Premier lancement » de l'étape 5 doit avoir eu lieu, sinon les mails de test seraient avalés par le lancement silencieux.

1. Depuis l'autre boîte, envoie à ta boîte surveillée un mail avec l'objet **`Test très urgent`**.
2. Envoie un second mail avec l'objet **`Question sur le TP`**.
3. Attends 1 à 2 minutes que les mails arrivent, puis lance à la main : **Actions → Surveillance de la boîte mail → Run workflow** (inutile d'attendre les 5 minutes).
4. Résultat attendu :
   - une notification **« Test très urgent »**, immédiate, priorité maximale ;
   - une notification **« Question sur le TP »**, priorité normale, avec « Autre mail » dans le texte ;
   - dans le journal : `Nouveaux : 2. Notifications envoyées : 2.`
5. Relance le workflow : le journal doit afficher `Nouveaux : 0. Notifications envoyées : 0.` et **aucune** notification en double.
6. (Facultatif) Envoie un mail dont l'objet est `[etudiant] Bonjour` : tu reçois une notification de résumé « Infos : 1 nouveau message », discrète.
7. Vérifie dans le journal GitHub qu'**aucun objet, expéditeur ou extrait n'apparaît** : seuls des nombres et des codes sont écrits.

---

## Limites à connaître

### Le délai : « toutes les 5 minutes » est un minimum
GitHub ne garantit pas l'heure exacte des tâches planifiées. En période de forte charge, un passage peut être retardé de **5 à 15 minutes ou plus**, voire sauté. Une notification « immédiate » signifie « dès le passage suivant », pas à la seconde près. GitHub Actions ne permet pas de faire plus rapide.

### La mise en pause après 60 jours sans activité
Sur un dépôt public, GitHub **désactive automatiquement les tâches planifiées après 60 jours sans activité sur le dépôt** (commit, issue, etc. ; les exécutions du workflow ne comptent pas). Tu reçois alors un e-mail de GitHub, et **les notifications s'arrêtent sans autre signe**. Pour relancer : onglet **Actions → Surveillance de la boîte mail → Enable workflow**. Pour l'éviter, fais une petite modification du dépôt (par exemple dans `rules.json`) au moins tous les deux mois.

### Les objets de tes mails passent par ntfy.sh
Pour t'envoyer une notification, le programme transmet **l'objet du mail** (et la matière Moodle, ou la liste des objets pour les résumés) au service **ntfy.sh**. Ces informations transitent par ses serveurs, protégées uniquement par le nom de ton sujet (c'est pourquoi il doit être long et aléatoire). Le contenu du mail et l'adresse de l'expéditeur ne sont jamais envoyés. Si cela ne te convient pas, ntfy peut être hébergé par toi-même, ou tu peux utiliser des règles plus strictes pour limiter les mails notifiés.

### Autres points
- **Le flux ne montre que les 8 derniers mails environ.** Si plus de 8 mails arrivent entre deux passages, les plus anciens sont ratés.
- **Seule la boîte de réception est surveillée.** Un mail rangé directement dans un autre dossier par un filtre n'est pas vu.
- **Mémoire perdue** : si l'historique est supprimé (ou n'a pas servi pendant 7 jours), le passage suivant redevient un « premier lancement » silencieux. Les mails arrivés entre-temps ne sont pas notifiés.
- **Changer le nom du sujet** (`NTFY_TOPIC`) provoque le même passage silencieux : l'historique est refait avec la nouvelle clé, sans te renvoyer d'anciens mails. N'oublie pas de t'abonner au nouveau sujet dans l'application.
- **Échecs** : si le serveur mail ne répond pas, le passage est marqué en échec (croix rouge) et GitHub peut t'envoyer un e-mail. Le passage suivant réessaie normalement.
- **Mot de passe** : vérifie que le règlement informatique de ton université autorise ce type d'usage. Si l'université active la double authentification sur la boîte, l'accès par mot de passe ne fonctionnera plus.

---

## Dépannage

| Symptôme | Cause probable |
|---|---|
| Notification « Connexion refusée » | `UNIV_USER` ou `UNIV_PASSWORD` incorrect, ou mot de passe changé. Corrige les secrets : la notification n'est envoyée **qu'une fois** jusqu'à ce que la connexion fonctionne à nouveau. |
| Étape 0 : `Code HTTP : 000` | Le serveur n'a pas répondu à temps : réessaie plus tard. |
| Étape 0 : `Flux RSS reconnu : non` | Page de connexion ou de maintenance renvoyée à la place du flux. |
| Aucune notification reçue | Vérifie que `NTFY_TOPIC` est **identique** au sujet de l'application, et que l'application ntfy a le droit de t'envoyer des notifications. |
| Plus aucune exécution | Voir « mise en pause après 60 jours ». |

---

## Pour les curieux

- Le code est en Node.js 20, **sans aucune dépendance**. Tests : `npm test`.
- La lecture du flux et le classement (`src/rss.js`, `src/classify.js`, `src/feed.js`, `src/state.js`) sont **indépendants** de la façon de notifier. Le canal ntfy est isolé dans `src/notifiers/ntfy.js` : ajouter un autre canal revient à écrire un fichier qui sait envoyer `{ title, message, priority, clickUrl }`.
- Mémoire anti-doublons : empreintes HMAC-SHA-256 de `expéditeur|date|objet` (200 au maximum), calculées avec `NTFY_TOPIC` comme clé, conservées avec `actions/cache`. Aucun texte de mail n'est stocké, et sans la clé on ne peut pas vérifier qu'un mail donné figure dans la liste.
- Journaux : uniquement le code HTTP, des compteurs et des catégories d'erreur. Aucun objet, extrait, expéditeur, URL avec identifiants ni en-tête d'authentification.
