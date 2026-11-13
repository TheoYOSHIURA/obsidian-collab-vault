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

## Utilisation

- **Activer** : palette de commandes → « Collab Vault : Activer la collaboration dans ce coffre ». Ça crée `.collab/room.json`, qui contient l'identifiant de la session et son secret.
- **Inviter** : « Collab Vault : Inviter quelqu'un ».
  - **Ami avec accès au dépôt git** : ajoute-le comme collaborateur GitHub. Il clone le dépôt, ouvre le dossier dans Obsidian et active les plugins communautaires. Le plugin et l'invitation sont déjà dedans.
  - **Ami sans git** : il copie le plugin dans un coffre vide, puis clique sur le lien `obsidian://collab-vault?...`.
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
- Ordinateur uniquement : pas de version mobile.

## Développement

```sh
npm install
npm run build   # → main.js (à copier avec manifest.json et styles.css dans .obsidian/plugins/collab-vault/)
npm test        # tests du cœur de synchro (réseau et disques simulés)
tools/e2e/scenario.sh   # test de bout en bout dans un vrai Obsidian (profil isolé, 3 coffres)
```

`tools/e2e/scenario.sh` lance l'AppImage Obsidian avec un profil séparé et pilote 3 fenêtres (37 vérifications) via le port de débogage 9333.
