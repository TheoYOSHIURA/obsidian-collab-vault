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
  c $1 "const txt=$js; const cm=app.workspace.activeEditor.editor.cm; for (const ch of txt) { const pos = $start ? 0 : cm.state.doc.length; cm.dispatch({changes:{from:pos, insert:ch}, userEvent:'input.type'}); await new Promise(r=>setTimeout(r,15)); } return 1" >/dev/null; }
has() { [[ "$1" == *"$2"* ]] && echo oui || echo "non ($1)"; }

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
echo; echo "$ok OK, $ko échec(s)"
