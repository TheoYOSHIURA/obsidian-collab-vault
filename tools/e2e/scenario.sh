#!/bin/bash
# Scénario complet dans un vrai Obsidian (profil isolé), 3 coffres v1, v2, v3.
cd "$(dirname "$0")"; T=$PWD; E=$T/../../.build/e2e
# OBSIDIAN=/chemin/vers/Obsidian.AppImage pour changer d'exécutable
c() { timeout 30 node $T/cdp.mjs "$@"; }
ok=0; ko=0
check() { if [ "$2" = "$3" ]; then echo "✔ $1"; ok=$((ok+1)); else echo "✘ $1"; echo "   attendu: $3"; echo "   obtenu : $2"; ko=$((ko+1)); fi; }
stop_test_obsidian() { for p in $(pgrep -i obsidian); do grep -qa 'e2e/userdata' /proc/$p/cmdline 2>/dev/null && kill $p 2>/dev/null; done; sleep 2; }

# typ <v1|v2> <texte> [debut] : tape le texte lettre par lettre dans l'éditeur actif
typ() { local js; js=$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$2"); local start=${3:-false}
  c $1 "const txt=$js; const cm=(app.workspace.activeEditor ?? app.workspace.getLeavesOfType('markdown')[0].view).editor.cm; for (const ch of txt) { const pos = $start ? 0 : cm.state.doc.length; cm.dispatch({changes:{from:pos, insert:ch}, userEvent:'input.type'}); await new Promise(r=>setTimeout(r,15)); } return 1" >/dev/null; }
has() { [[ "${1,,}" == *"${2,,}"* ]] && echo oui || echo "non ($1)"; }

stop_test_obsidian; ./setup.sh
("${OBSIDIAN:-$HOME/AppImages/Obsidian-1.15.1.AppImage}" --user-data-dir=$E/userdata --remote-debugging-port=9333 > $E/obsidian.log 2>&1 &)
for i in $(seq 1 30); do curl -s http://127.0.0.1:9333/json 2>/dev/null | grep -q '"page"' && break; sleep 1; done; sleep 4
c v1 'app.plugins.setEnable(true); return 1' >/dev/null; sleep 3; c v2 'app.plugins.setEnable(true); return 1' >/dev/null; c v3 'app.plugins.setEnable(true); return 1' >/dev/null
STATUS='return app.plugins.plugins["collab-vault"]?.statusBar.getText()'
for i in $(seq 1 30); do s=$(c v2 "$STATUS"); [[ "$s" == *"👥 2"* ]] && break; sleep 1; done
check "v2 rejoint la session de v1" "$(has "$(c v2 "$STATUS")" "👥 2 · invité")" "oui"

OPEN='await app.workspace.openLinkText("a.md",""); await new Promise(r=>setTimeout(r,800)); return 1'
c v1 "$OPEN" >/dev/null; c v2 "$OPEN" >/dev/null
typ v1 $'\nTexte de v1.' false & typ v2 $'> ' true; wait; sleep 2
ED='return app.workspace.activeEditor.editor.getValue()'
check "frappe simultanée : mêmes éditeurs" "$(c v1 "$ED" | md5sum)" "$(c v2 "$ED" | md5sum)"

# renommage d'une note ouverte dans les deux éditeurs, puis on continue d'écrire
c v1 'await app.vault.create("liens.md", "Voir [[a]].\n"); await new Promise(r=>setTimeout(r,1500)); await app.fileManager.renameFile(app.vault.getAbstractFileByPath("a.md"), "Accueil.md"); return 1' >/dev/null; sleep 3
typ v2 $'\nÉcrit par v2 après renommage.' false; sleep 1
typ v1 $'\nÉcrit par v1 après renommage.' false; sleep 3
check "lien mis à jour une seule fois" "$(cat $E/v2/liens.md)" "Voir [[Accueil]]."
check "après renommage, v1 reçoit ce qu'écrit v2" "$(grep -c 'Écrit par v2' $E/v1/Accueil.md)" "1"
check "après renommage, v2 reçoit ce qu'écrit v1" "$(grep -c 'Écrit par v1' $E/v2/Accueil.md)" "1"

# image + suppression
c v2 'const png=await app.vault.readBinary(app.vault.getAbstractFileByPath("img.png")); await app.vault.createBinary("dossier/photo.png", png); await app.fileManager.trashFile(app.vault.getAbstractFileByPath("dossier/b.md")); return 1' >/dev/null; sleep 4
check "image transmise" "$(cmp -s $E/v1/dossier/photo.png $E/v1/img.png && echo oui)" "oui"
check "suppression transmise" "$(test -e $E/v1/dossier/b.md && echo existe || echo supprimé)" "supprimé"

# l'hôte part, v2 écrit, l'hôte revient
sleep 4
check "seul v1 a commité" "$(git -C $E/remote.git log --format=%an | sort -u | tr '\n' ' ')" "seed v1 "
c v1 'await app.plugins.disablePlugin("collab-vault"); return 1' >/dev/null; sleep 4
check "v1 parti : v2 devient hôte" "$(has "$(c v2 "$STATUS")" "(hôte)")" "oui"
typ v2 $'\nPendant l absence de v1.' false; sleep 8
check "v2 a pris le relais git" "$(git -C $E/remote.git log -1 --format=%an)" "v2"
check "commit de v2 contient sa ligne" "$(git -C $E/remote.git show HEAD:Accueil.md | grep -c 'absence de v1')" "1"
c v1 'await app.plugins.enablePlugin("collab-vault"); return 1' >/dev/null
for i in $(seq 1 30); do s=$(c v1 "$STATUS"); [[ "$s" == *"👥 2"* ]] && break; sleep 1; done; sleep 3
check "v1 revient comme invité" "$(has "$(c v1 "$STATUS")" "👥 2 · invité")" "oui"

# cohérence finale : disques, docs, éditeurs
typ v1 $'\nRetour de v1.' false; sleep 4
DOC='const s=app.plugins.plugins["collab-vault"].session; return JSON.stringify([...s.files.entries()].map(([k,v])=>[k,v.toString()]).sort())'
check "docs identiques" "$(c v1 "$DOC" | md5sum)" "$(c v2 "$DOC" | md5sum)"
check "éditeurs identiques" "$(c v1 "$ED" | md5sum)" "$(c v2 "$ED" | md5sum)"
check "éditeur = doc" "$(c v2 'const s=app.plugins.plugins["collab-vault"].session; return String(app.workspace.activeEditor.editor.getValue()===s.getText("Accueil.md").toString())')" "true"
D() { (cd $E/$1 && find . -path ./.git -prune -o -path ./.obsidian -prune -o -type f -print0 | sort -z | xargs -0 md5sum); }
check "disques identiques" "$(D v1 | md5sum)" "$(D v2 | md5sum)"
check "toutes les lignes sont là" "$(grep -cE 'Texte de v1|Écrit par v2|Écrit par v1|absence de v1|Retour de v1' $E/v1/Accueil.md)" "5"

# v3 : ami sans git, rejoint par le lien d'invitation
check "v3 n'est pas pris pour un dépôt git" "$(c v3 'return String(!!app.plugins.plugins["collab-vault"].git)')" "false"
ROOM=$(cat $E/v1/.collab/room.json)
c v3 'const r='"$ROOM"'; app.plugins.plugins["collab-vault"].handleInviteLink({room:r.room, secret:r.secret, name:"Test"}); await new Promise(r=>setTimeout(r,500)); [...[...document.querySelectorAll(".modal-container")].at(-1).querySelectorAll("button")].find(b=>b.textContent==="Rejoindre").click(); return 1' >/dev/null
for i in $(seq 1 30); do s=$(c v3 "$STATUS"); [[ "$s" == *"👥 3"* ]] && break; sleep 1; done; sleep 4
check "v3 rejoint par le lien" "$(has "$s" "👥 3 · invité")" "oui"
N() { (cd $E/$1 && find . -path ./.git -prune -o -path ./.obsidian -prune -o -path ./.collab -prune -o -name .gitignore -o -type f -print0 | sort -z | xargs -0 md5sum); }
check "v3 a reçu notes ET images" "$(N v3 | md5sum)" "$(N v1 | md5sum)"
check "v3 a bien l'image" "$(test -f $E/v3/dossier/photo.png && echo oui)" "oui"
c v3 'await app.workspace.openLinkText("Accueil.md",""); await new Promise(r=>setTimeout(r,800)); return 1' >/dev/null
typ v3 $'\nCoucou de v3.' false; sleep 9
check "l'écriture de v3 est sauvegardée par git" "$(git -C $E/remote.git show HEAD:Accueil.md | tail -1)" "Coucou de v3."
MEM='app.commands.executeCommandById("collab-vault:members"); await new Promise(r=>setTimeout(r,600)); const c=[...document.querySelectorAll(".modal-container")].at(-1); const t=c.innerText; c.querySelector(".modal-close-button")?.click(); return t'
check "« qui est là ? » affiche l'hôte" "$(has "$(c v3 "$MEM")" "hôte · sauvegarde git")" "oui"

# panneau « Sauvegarde git »
GV='app.commands.executeCommandById("collab-vault:git-view"); await new Promise(r=>setTimeout(r,4000)); const v=app.workspace.getLeavesOfType("collab-vault-git")[0]?.view; return v ? v.contentEl.innerText : "(pas de panneau)"'
OUT2=$(c v2 "$GV"); OUT3=$(c v3 "$GV")
check "panneau git : responsable voit l'historique" "$(has "$OUT2" "vault: ")$(has "$OUT2" "Historique")" "ouioui"
check "panneau git : état affiché" "$(has "$OUT2" "Tout est sur GitHub")" "oui"
check "panneau git : v3 sans git" "$(has "$OUT3" "n'utilise pas git")$(has "$OUT3" "sauvegarde la session")" "ouioui"
c v2 'app.plugins.plugins["collab-vault"].settings.delaySeconds=30; return 1' >/dev/null
typ v2 $'\nEn attente.' false; sleep 2
OUT2=$(c v2 'const v=app.workspace.getLeavesOfType("collab-vault-git")[0].view; await v.refresh(); return v.contentEl.innerText')
check "panneau git : fichier en attente + compte à rebours" "$(has "$OUT2" "Accueil.md")$(has "$OUT2" "Commit automatique dans")" "ouioui"
OUT1=$(c v1 'app.commands.executeCommandById("collab-vault:git-view"); await new Promise(r=>setTimeout(r,4000)); return app.workspace.getLeavesOfType("collab-vault-git")[0].view.contentEl.innerText')
check "panneau git : invité voit qui sauvegarde" "$(has "$OUT1" "v2 sauvegarde la session")" "oui"
c v2 'const v=app.workspace.getLeavesOfType("collab-vault-git")[0].view; v.contentEl.querySelector(".cv-commit-top").click(); await new Promise(r=>setTimeout(r,800)); return 1' >/dev/null
check "panneau git : détail d'un commit" "$(has "$(c v2 'return app.workspace.getLeavesOfType("collab-vault-git")[0].view.contentEl.querySelector(".cv-files").innerText')" "Accueil.md")" "oui"

# v2 retire v3 depuis « qui est là ? »
OLDKEY=$(cat $E/v1/.collab/room.json)
c v2 'app.commands.executeCommandById("collab-vault:members"); await new Promise(r=>setTimeout(r,600)); const c=[...document.querySelectorAll(".modal-container")].at(-1); const b=c.querySelector("[aria-label=\"Retirer v3 du coffre\"]"); b.click(); await new Promise(r=>setTimeout(r,600)); const c2=[...document.querySelectorAll(".modal-container")].at(-1); [...c2.querySelectorAll("button")].find(x=>x.textContent==="Retirer").click(); return 1' >/dev/null
for i in $(seq 1 40); do s1=$(c v1 "$STATUS"); [[ "$s1" == *"👥 2"* ]] && break; sleep 1; done; sleep 2
check "v1 et v2 ont la même nouvelle clé" "$(cat $E/v1/.collab/room.json | md5sum)" "$(cat $E/v2/.collab/room.json | md5sum)"
check "la clé a changé" "$( [ "$(cat $E/v1/.collab/room.json)" != "$OLDKEY" ] && echo oui)" "oui"
check "v3 garde l'ancienne clé" "$(cat $E/v3/.collab/room.json | tr -d ' \n')" "$(echo "$OLDKEY" | tr -d ' \n')"
check "v1 et v2 de nouveau ensemble, sans v3" "$(has "$s1" "👥 2")" "oui"
check "v3 se retrouve seul" "$(has "$(c v3 "$STATUS")" "seul")" "oui"
typ v3 $'\nv3 après son retrait.' false; typ v2 $'\nv2 après le retrait.' false; sleep 4
check "les modifs de v3 n'arrivent plus" "$(grep -c 'v3 après son retrait' $E/v1/Accueil.md)" "0"
check "v1 et v2 collaborent toujours" "$(grep -c 'v2 après le retrait' $E/v1/Accueil.md)" "1"
sleep 30
check "la nouvelle clé est sauvegardée dans git" "$(git -C $E/remote.git show HEAD:.collab/room.json | md5sum)" "$(cat $E/v1/.collab/room.json | md5sum)"

# assistant git
SETUP='app.commands.executeCommandById("collab-vault:git-setup"); await new Promise(r=>setTimeout(r,4000)); const c=[...document.querySelectorAll(".modal-container")].at(-1); const t=c.innerText; c.querySelector(".modal-close-button")?.click(); return t'
OUT=$(c v1 "$SETUP")
check "assistant : git installé + accès OK + identité" "$(has "$OUT" "Git est installé")$(has "$OUT" "Accès au dépôt OK")$(has "$OUT" "v1 <v1@t>")" "ouiouioui"
OUT=$(c v1 'const p=app.plugins.plugins["collab-vault"]; const keep=p.settings.gitPath; p.settings.gitPath=""; app.commands.executeCommandById("collab-vault:git-setup"); await new Promise(r=>setTimeout(r,1500)); const c=[...document.querySelectorAll(".modal-container")].at(-1); const t=c.innerText; c.querySelector(".modal-close-button")?.click(); p.settings.gitPath=keep; return t')
check "assistant : propose d'installer git s'il manque" "$(has "$OUT" "Git n'est pas installé")$(has "$OUT" "Page de téléchargement")" "ouioui"

# v3 en « mode téléphone » : pas de git, pas d'accès au dossier, rejoint par lien puis modifie hors ligne
c v3 'app.plugins.plugins["collab-vault"].constructor.platform.isDesktopApp=false; await app.plugins.disablePlugin("collab-vault"); await app.plugins.enablePlugin("collab-vault"); return 1' >/dev/null
ROOM=$(cat $E/v1/.collab/room.json)
c v3 'const r='"$ROOM"'; app.plugins.plugins["collab-vault"].handleInviteLink({room:r.room, secret:r.secret, name:"Test"}); await new Promise(r=>setTimeout(r,500)); [...[...document.querySelectorAll(".modal-container")].at(-1).querySelectorAll("button")].find(b=>b.textContent==="Rejoindre").click(); return 1' >/dev/null
for i in $(seq 1 40); do s=$(c v3 "$STATUS"); [[ "$s" == *"👥 3"* ]] && break; sleep 1; done; sleep 8
check "mobile : rejoint la session (sans git)" "$(has "$s" "👥 3")$(c v3 'return String(app.plugins.plugins["collab-vault"].git)')" "ouinull"
c v3 'await app.plugins.disablePlugin("collab-vault"); const f=app.vault.getAbstractFileByPath("Accueil.md"); await app.vault.process(f, t => t.replace("# Note A", "# Note A (titre modifié dans le métro)")); return 1' >/dev/null
sleep 2; typ v2 $'\nPendant que le téléphone est hors ligne.' false; sleep 3
c v3 'await app.plugins.enablePlugin("collab-vault"); return 1' >/dev/null
for i in $(seq 1 40); do s=$(c v3 "$STATUS"); [[ "$s" == *"👥 3"* ]] && break; sleep 1; done; sleep 6
check "hors ligne : la modif du téléphone arrive chez les autres" "$(grep -c 'titre modifié dans le métro' $E/v1/Accueil.md)" "1"
check "hors ligne : le téléphone reçoit ce qu'il a manqué" "$(grep -c 'Pendant que le téléphone est hors ligne' $E/v3/Accueil.md)" "1"
check "hors ligne : même contenu partout" "$(md5sum < $E/v3/Accueil.md)" "$(md5sum < $E/v1/Accueil.md)"
echo; echo "$ok OK, $ko échec(s)"
