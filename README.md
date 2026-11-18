# Collab Vault

Plugin Obsidian qui fait **deux choses indépendantes** :

| | 💾 Sauvegarde git | 👥 Collaboration en direct |
|---|---|---|
| **À quoi ça sert** | Garder l'historique du coffre sur GitHub et le retrouver sur chaque appareil | Écrire à plusieurs dans la même note en même temps, en voyant les curseurs des autres |
| **Comment ça passe** | Par GitHub : commit, pull, push | D'un appareil à l'autre, en direct (WebRTC), sans serveur |
| **Délai** | Quelques dizaines de secondes à quelques minutes | Immédiat, lettre par lettre |
| **Il faut** | Un dépôt GitHub, et git (ordinateur) ou un jeton GitHub (téléphone) | Une invitation (`.collab/room.json` ou un lien), et les autres connectés en même temps |
| **Marche seul ?** | Oui, même si tu es le seul à utiliser le coffre | Oui, même sans git, mais alors rien n'est sauvegardé sur GitHub |
| **Se configure avec** | « Configurer git et la connexion GitHub » | « Activer la collaboration » puis « Inviter quelqu'un » |

Tu peux utiliser **seulement la sauvegarde** (un coffre perso sauvegardé sur GitHub), **seulement la collaboration** (des amis sans GitHub), ou **les deux** (le cas le plus courant : voir [Les deux ensemble](#-les-deux-ensemble)).

---

## 💾 Sauvegarde git

### Ce que ça fait
- **Commit et push automatiques** 30 s après ta dernière modification.
- **Pull toutes les 2 min**, et au démarrage d'Obsidian : tu récupères ce que les autres appareils ont envoyé.
- En cas de conflit avec GitHub, la fusion garde ta version pour les lignes en conflit, pour que la sauvegarde ne reste jamais bloquée.
- Les fichiers propres à chaque appareil ne sont **jamais versionnés** : `.obsidian/workspace.json`, `workspace-mobile.json` et les réglages du plugin (`data.json`, `base-*.json`). Le plugin les ajoute au `.gitignore` tout seul.

### Sur ordinateur (Windows, Mac, Linux)
Palette de commandes → **« Collab Vault : Configurer git et la connexion GitHub »**. L'assistant vérifie chaque étape et propose un bouton quand quelque chose manque :

1. **Git installé** : il affiche quel git est utilisé et permet d'en choisir un autre (chemin de `git.exe`). Sous Windows, il peut installer Git for Windows (`winget`).
2. **Ton nom pour les sauvegardes** : le nom et l'e-mail des commits.
3. **Dépôt git du coffre** :
   - Si les notes sont **déjà sur GitHub** : clone le dépôt (GitHub Desktop convient) et ouvre ce dossier dans Obsidian. Le plugin est déjà dedans.
   - Si c'est un **nouveau coffre** : bouton **Créer le dépôt** (branche `main`). La sauvegarde marche tout de suite en local, même sans GitHub. Le plugin le propose une fois au premier lancement.
4. **Dépôt GitHub** : bouton **Créer sur GitHub** (ouvre la page de création d'un dépôt privé déjà nommé), puis colle son adresse et clique sur **Relier**.
   - Dépôt vide : la sauvegarde suivante y envoie les notes.
   - Dépôt qui a déjà des notes : elles sont fusionnées avec celles du coffre. En cas de conflit, rien n'est fusionné et la liaison est annulée.
5. **Connexion à GitHub** : la fenêtre de connexion (Git Credential Manager) s'ouvre toute seule. Si ton git n'a pas Git Credential Manager, le plugin le cherche sur l'ordinateur ; sinon il propose d'installer Git for Windows, qui l'inclut.

Être connecté dans GitHub Desktop ne suffit pas : le plugin utilise la commande `git` de l'ordinateur.

### Sur téléphone (Android, iPhone)
Le programme `git` n'existe pas sur téléphone : le plugin utilise un git écrit en JavaScript (isomorphic-git) et un **jeton GitHub**.

Réglages de Collab Vault → **« Ouvrir l'assistant »** : indique l'adresse du dépôt **qui contient tes notes** (pas celle du plugin), le jeton, ton nom et ton e-mail.

- **Créer le jeton** : github.com → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token. « Repository access » : *Only select repositories* → le dépôt du coffre. « Permissions » : **Contents : Read and write**. Pour un dépôt d'organisation, choisis l'organisation comme « Resource owner ».
- Le plugin relie le coffre au dépôt **sans écraser les notes déjà présentes** et récupère les fichiers manquants. Il utilise la branche par défaut du dépôt (`main`, `master`…).
- Le jeton reste dans les réglages du plugin, sur le téléphone. Il n'est jamais versionné.

### Voir où en est la sauvegarde
Icône « branche » du ruban, ou **« Afficher l'état de la sauvegarde git »** : état (à jour, en attente avec compte à rebours, erreur), qui sauvegarde, fichiers pas encore sur GitHub, historique (clic sur un commit → fichiers modifiés, lien GitHub). Boutons **Commit & push** et **Récupérer**.

Les délais, le message de commit, le push automatique et la synchro au démarrage se règlent dans les réglages du plugin.

---

## 👥 Collaboration en direct

### Ce que ça fait
- **Tout le monde écrit en même temps** dans la même note. Les modifications sont fusionnées avec [Yjs](https://yjs.dev) : personne n'écrase personne.
- **Tu vois les curseurs des autres**, avec leur nom et leur couleur, et qui est sur quelle note.
- **Ctrl+Z n'annule que tes propres modifs.**
- **Les images et les PDF** sont envoyés aux autres quand ils changent. Un nouveau venu reçoit ceux qui lui manquent.
- **Pas de serveur à nous** : les appareils se trouvent via des relais Nostr publics ([Trystero](https://github.com/dmotz/trystero)), avec une mise en relation chiffrée par le secret du coffre. Ensuite tout passe en direct, en WebRTC chiffré.
- **Le premier qui ouvre le coffre devient l'hôte** : il charge les notes depuis son disque, les autres reçoivent sa version. S'il part, la session continue avec le suivant.

### Activer et inviter
1. Palette de commandes → **« Collab Vault : Activer la collaboration dans ce coffre »**. Ça crée `.collab/room.json` (identifiant et secret de la session).
2. **« Collab Vault : Inviter quelqu'un »** :
   - **Ami qui a accès au dépôt GitHub** : ajoute-le comme collaborateur (bouton « Ajouter sur GitHub »). Il clone le dépôt et ouvre le dossier dans Obsidian : le plugin et l'invitation sont déjà dedans. Il rejoint la session tout seul, même si `room.json` arrive par un pull pendant qu'Obsidian est ouvert.
   - **Ami sans GitHub** : copie le **lien d'invitation** et envoie-le-lui. La page qui s'ouvre ([docs/invite.html](docs/invite.html)) le guide : coffre vide, plugins communautaires, puis des boutons pour installer BRAT, installer Collab Vault et rejoindre. L'invitation est dans la partie `#…` du lien, que le navigateur n'envoie jamais au serveur. Le lien direct `obsidian://collab-vault?…` reste disponible si le plugin est déjà installé.

### Pendant la session
- **Qui est là** : clic sur la barre d'état, ou l'icône 👥 du ruban.
- **Retirer quelqu'un** : bouton 👤✕ dans « Qui est là ? », ou **« Changer la clé du coffre (retirer quelqu'un) »** s'il n'est pas connecté. La nouvelle clé est envoyée à tout le monde sauf lui.
  - ⚠️ Retire-le **aussi** du dépôt GitHub, sinon il récupérera la nouvelle clé par git.
  - Il garde la copie des notes qu'il a déjà : on ne peut pas la lui reprendre.
  - Les amis sans GitHub devront recevoir un nouveau lien.
- **Ça ne se connecte pas** : « Collab Vault : Reconnecter la session ». Si une notification dit qu'un membre est injoignable, c'est le réseau (voir [Limites connues](#limites-connues)).

### Modifications hors ligne
Chaque appareil garde la dernière version partagée des notes, hors git, dans `base-*.json`. En rejoignant une session après avoir modifié hors ligne (téléphone dans le métro, PC resté seul), il fait une fusion à trois, comme git :
- les modifications des deux côtés sont gardées ;
- si les deux ont modifié les mêmes lignes, la session garde sa version, et l'autre est conservée dans une copie `Note (conflit <nom> <date>).md`.

---

## 🔗 Les deux ensemble

Quand la collaboration et la sauvegarde sont actives dans le même coffre :

- **Un seul membre sauvegarde** : le plus ancien de la session qui a git, sur ordinateur de préférence. Les autres ne touchent pas à git pendant la session, ce qui évite les conflits. Le panneau git indique qui sauvegarde. S'il part, le suivant reprend.
- **Un téléphone ne sauvegarde que s'il est seul.** Dès qu'un ordinateur avec git est dans la session, c'est lui qui sauvegarde.
- **Un membre sans git** (ami invité par lien) : ses modifications arrivent chez les autres en direct, et c'est le membre avec git qui les envoie sur GitHub. **Si personne n'a git dans la session, rien n'est sauvegardé.**
- **L'invitation passe par git** : `.collab/room.json` est versionné, donc un ami qui a accès au dépôt est invité automatiquement.
- **Un appareil qui ne peut pas rejoindre la session** (réseau fermé) continue de sauvegarder de son côté : ses modifications passent par GitHub, avec quelques minutes de délai au lieu du direct.

---

## Installer le plugin

- **Ordinateur, coffre déjà sur GitHub** : rien à faire, le plugin est dans le dépôt (`.obsidian/plugins/collab-vault/`). Active les plugins communautaires et accepte « Faire confiance à l'auteur ».
- **Téléphone, ou coffre sans le plugin** : installe **BRAT** depuis les plugins communautaires, puis ajoute le plugin beta `TheoYOSHIURA/obsidian-collab-vault`. BRAT le garde à jour. La page d'invitation fait ces étapes avec des boutons.
- **À la main** : copie `main.js`, `manifest.json` et `styles.css` de la [dernière release](https://github.com/TheoYOSHIURA/obsidian-collab-vault/releases/latest) dans `.obsidian/plugins/collab-vault/`, puis relance Obsidian.

## Limites connues

- **Collaboration** : derrière certains réseaux très fermés (réseau d'école ou d'entreprise, NAT symétrique), la connexion directe échoue. Le plugin le signale par une notification. Il faudrait alors un serveur relais TURN, pas encore pris en charge.
- **Collaboration** : les relais Nostr publics sont gratuits mais pas garantis.
- **Sauvegarde** : il faut qu'un membre avec git soit présent pour que le travail d'une session soit sauvegardé.
- **Sauvegarde, Windows** : l'installation automatique de git (`winget`) n'a pas été testée sur un vrai Windows.
- **Sauvegarde, téléphone** : un dépôt GitHub vide ne peut pas être relié depuis un téléphone. Fais la première sauvegarde depuis un ordinateur.

## Développement

```sh
npm install
npm run build   # → main.js (à copier avec manifest.json et styles.css dans .obsidian/plugins/collab-vault/)
npm test        # synchro, modifs hors ligne, git du téléphone (serveur git HTTP local), assistant git ordinateur
tools/e2e/scenario.sh       # test de bout en bout dans un vrai Obsidian (profil isolé, 3 coffres)
tools/e2e/agent-writes.sh   # écritures d'un agent (ex. Claude via Agent Client) sur des notes ouvertes
```

`npm test` utilise une syntaxe sh : sous Windows, lance-le depuis Git Bash.

**Publier une version** : mets à jour `version` dans `manifest.json` et `package.json`, commit, puis pousse un tag du même nom (`git tag 0.4.9 && git push origin 0.4.9`). L'action GitHub « Release » compile, lance les tests et publie `main.js`, `manifest.json` et `styles.css` : BRAT propose alors la mise à jour.

**Page d'invitation** : servie par GitHub Pages depuis le dossier `docs/` de `master` (Settings → Pages → Deploy from a branch → `master` / `/docs`).

`tools/e2e/scenario.sh` lance l'AppImage Obsidian avec un profil séparé et pilote 3 fenêtres (53 vérifications) via le port de débogage 9333.
