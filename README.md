# Collab Vault

Plugin Obsidian pour écrire à plusieurs dans un même coffre, en temps réel (on voit les curseurs des autres), sans serveur, avec une sauvegarde git automatique.

## Comment ça marche

- **Pas de serveur à nous.** Les pairs se trouvent via des relais Nostr publics : c'est la bibliothèque [Trystero](https://github.com/dmotz/trystero), et la mise en relation est chiffrée avec le secret du coffre. Ensuite tout passe en direct, en WebRTC chiffré.
- **Le premier qui ouvre le coffre devient l'hôte.** Il charge les notes depuis son disque et les autres reçoivent sa version. S'il part, la session continue : le suivant devient hôte.
- **Les éditions simultanées sont fusionnées** grâce au CRDT [Yjs](https://yjs.dev). Chacun voit les curseurs des autres, avec leur nom. Ctrl+Z n'annule que tes propres modifs.
- **Un seul membre fait la sauvegarde git** : le plus ancien de la session qui a git. Il commit et push 30 s après la dernière modif, et fait un pull toutes les 2 min. Les autres ne touchent pas à git pendant la session, ce qui évite les conflits.
- **Sans session** (pas d'invitation dans le coffre), le plugin fait juste la sauvegarde git automatique.
- **Les images et les PDF** sont transmis aux autres quand ils changent. Un nouveau venu reçoit ceux qui lui manquent.
- `.obsidian/workspace.json` et les réglages du plugin sont propres à chaque machine : ils sont sortis du dépôt automatiquement.

## Installation

### Ordinateur (Windows, Mac, Linux)
- **Avec accès au dépôt git du coffre** : clone le dépôt (GitHub Desktop convient), ouvre le dossier dans Obsidian et accepte « Faire confiance à l'auteur ». Le plugin est déjà dedans.
- **Git et connexion GitHub** : palette de commandes → « Collab Vault : Configurer git et la connexion GitHub ». L'assistant :
  - installe Git for Windows si besoin (via `winget`, sinon il ouvre la page de téléchargement) ;
  - règle ton nom et ton e-mail pour les sauvegardes ;
  - affiche un bouton **Se connecter à GitHub**, qui ouvre la fenêtre de connexion de Git Credential Manager, inclus avec Git for Windows ;
  - vérifie l'accès au dépôt.
  Il s'ouvre aussi tout seul, via une notification, si git manque ou si GitHub refuse la connexion.
  Être connecté dans GitHub Desktop ne suffit pas : le plugin utilise la commande `git` de l'ordinateur.
- **Nouveau coffre (pas encore sur GitHub)** : au premier lancement, le plugin propose une fois de configurer la sauvegarde. L'assistant :
  - crée le dépôt git du coffre (branche `main`, `.gitattributes`, `.gitignore` des fichiers propres à chaque machine) ;
  - sauvegarde aussitôt en local, même sans GitHub ;
  - propose **Créer sur GitHub** (ouvre la page de création d'un dépôt privé déjà nommé) puis **Relier** avec l'adresse du dépôt. Si le dépôt est vide, la sauvegarde suivante y envoie les notes. S'il contient déjà des notes, elles sont fusionnées avec celles du coffre. En cas de conflit, rien n'est fusionné et la liaison est annulée.

### Android / iPhone
1. Dans Obsidian mobile, crée un coffre vide.
2. Installe le plugin **BRAT** depuis les plugins communautaires, puis ajoute le plugin beta `TheoYOSHIURA/obsidian-collab-vault`.
3. Ouvre le lien d'invitation (`obsidian://collab-vault?...`) : les notes arrivent depuis la session. Il faut qu'un membre soit connecté.
4. **Optionnel, sauvegarde git sur le téléphone :** réglages du plugin → « Ouvrir l'assistant ». Indique l'adresse du dépôt (déjà remplie si elle figure dans l'invitation), un **jeton GitHub**, ton nom et ton e-mail.
   - Le jeton : github.com → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token. Dans « Repository access », choisis *Only select repositories* → le dépôt du coffre. Dans « Permissions », mets **Contents : Read and write**.
   - Le plugin branche le coffre sur le dépôt **sans écraser les notes présentes** et récupère les fichiers manquants. Sur un coffre vide, c'est un simple clone.
   - Le téléphone ne commit et ne pousse que **quand il est seul**. Dès qu'un ordinateur avec git est dans la session, c'est l'ordinateur qui sauvegarde.
   - Le git du téléphone est écrit en JavaScript (isomorphic-git), parce que le programme `git` ne tourne pas sur téléphone. Le jeton reste dans les réglages du plugin, sur le téléphone, et n'est jamais versionné.

### Modifications hors ligne
Chaque appareil garde la dernière version partagée des notes, hors git, dans `base-*.json`. Quand il rejoint une session après avoir modifié hors ligne (téléphone dans le métro, PC resté seul), il fait une fusion à trois, comme git :
- les modifications des deux côtés sont gardées ;
- si les deux ont modifié les mêmes lignes, la session garde sa version, et l'autre est conservée dans une copie `Note (conflit <nom> <date>).md`.

## Utilisation

- **Activer** : palette de commandes → « Collab Vault : Activer la collaboration dans ce coffre ». Ça crée `.collab/room.json`, qui contient l'identifiant de la session et son secret.
- **Inviter** : « Collab Vault : Inviter quelqu'un ».
  - **Ami avec accès au dépôt git** : ajoute-le comme collaborateur GitHub. Il clone le dépôt, ouvre le dossier dans Obsidian et active les plugins communautaires. Le plugin et l'invitation sont déjà dedans.
  - **Ami sans git** : envoie-lui le lien d'invitation. Il ouvre une page ([docs/invite.html](docs/invite.html), sur GitHub Pages) qui le guide : coffre vide, plugins communautaires, puis des boutons pour installer BRAT, installer Collab Vault (BRAT le garde à jour) et rejoindre le coffre. L'invitation est dans la partie `#…` du lien, que le navigateur n'envoie jamais au serveur. Le lien direct `obsidian://collab-vault?...` reste disponible si le plugin est déjà installé.
- **Voir qui est là** : clique sur la barre d'état, ou utilise l'icône 👥 du ruban. Tu y vois aussi qui est sur quelle note.
- **État de la sauvegarde git** : l'icône « branche » du ruban, ou la commande « Afficher l'état de la sauvegarde git ». Le panneau montre l'état (à jour, en attente avec compte à rebours, erreur), qui sauvegarde, les fichiers pas encore sur GitHub et l'historique (clic sur un commit → fichiers modifiés, lien GitHub).
- **Retirer quelqu'un** : bouton 👤✕ dans « Qui est là ? », ou la commande « Changer la clé du coffre » s'il n'est pas connecté. La clé de la session change et est envoyée à tout le monde sauf lui ; les membres avec git la reçoivent par le dépôt.
  - ⚠️ Retire-le **aussi** du dépôt GitHub, sinon il récupérera la nouvelle clé par git.
  - Il garde la copie des notes qu'il a déjà sur son ordinateur : on ne peut pas la lui reprendre.
  - Les amis sans git devront recevoir un nouveau lien.

## Limites connues

- Il faut qu'un membre avec git soit présent pour que le travail de la session soit sauvegardé.
- Derrière certains réseaux très fermés (NAT symétrique, réseau d'école…), la connexion WebRTC directe peut échouer. Il faudrait alors un serveur TURN.
- Les relais Nostr publics sont gratuits mais pas garantis.
- Sur téléphone : non testé sur un vrai Android. Les tests simulent le mode téléphone dans Obsidian sur ordinateur et utilisent un serveur git HTTP local à jeton, pas GitHub.
- L'installation automatique de git (`winget`) et la fenêtre de connexion GitHub sont propres à Windows et n'ont pas été testées sur un vrai Windows.

## Développement

```sh
npm install
npm run build   # → main.js (à copier avec manifest.json et styles.css dans .obsidian/plugins/collab-vault/)
npm test        # cœur de synchro, modifs hors ligne, git du téléphone (contre un serveur git HTTP local)
tools/e2e/scenario.sh       # test de bout en bout dans un vrai Obsidian (profil isolé, 3 coffres)
tools/e2e/agent-writes.sh   # écritures d'un agent (ex. Claude via Agent Client) sur des notes ouvertes
```

**Publier une version** : mets à jour `version` dans `manifest.json` et `package.json`, commit, puis pousse un tag du même nom (`git tag 0.4.6 && git push origin 0.4.6`). L'action GitHub « Release » compile, lance les tests et publie `main.js`, `manifest.json` et `styles.css` : BRAT propose alors la mise à jour.

**Page d'invitation** : servie par GitHub Pages depuis le dossier `docs/` de `master` (Settings → Pages → Deploy from a branch → `master` / `/docs`).

`tools/e2e/scenario.sh` lance l'AppImage Obsidian avec un profil séparé et pilote 3 fenêtres (53 vérifications) via le port de débogage 9333.
