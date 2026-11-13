#!/bin/bash
# Reproduit les écritures d'un agent (Claude Code via Agent Client) sur le disque,
# pendant qu'une note est ouverte et synchronisée par Collab Vault.
cd "$(dirname "$0")"; T=$PWD; E=$T/../../.build/e2e
c() { timeout 30 node $T/cdp.mjs "$@"; }
for p in $(pgrep -i obsidian); do grep -qa 'e2e/userdata' /proc/$p/cmdline 2>/dev/null && kill $p; done; sleep 2
./setup.sh >/dev/null
("${OBSIDIAN:-$HOME/AppImages/Obsidian-1.15.1.AppImage}" --user-data-dir=$E/userdata --remote-debugging-port=9333 > $E/obsidian.log 2>&1 &)
for i in $(seq 1 30); do curl -s http://127.0.0.1:9333/json 2>/dev/null | grep -q '"page"' && break; sleep 1; done; sleep 4
c v1 'app.plugins.setEnable(true); return 1' >/dev/null
for i in $(seq 1 30); do [ "$(c v1 'return String(!!app.plugins.plugins["collab-vault"]?.session?.seeded)')" = true ] && break; sleep 1; done
c v1 'await app.workspace.openLinkText("a.md",""); await new Promise(r=>setTimeout(r,1000)); return 1' >/dev/null
STATE='const s=app.plugins.plugins["collab-vault"].session; const f=ARG; const ed=app.workspace.getLeavesOfType("markdown").map(l=>l.view).find(v=>v.file?.path===f)?.editor.getValue(); return JSON.stringify({doc: s.getText(f)?.toString(), ed: ed ?? null})'
report() { # $1 fichier, $2 marqueur
  local st=$(c v1 "${STATE/ARG/\"$1\"}"); local disk=$(grep -c "$2" "$E/v1/$1")
  local doc=$(echo "$st" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['doc'].count('$2') if d['doc'] else 0, d['ed'].count('$2') if d['ed'] is not None else '-')")
  echo "  disque=$disk  doc,éditeur=$doc"
}
echo "A. note ouverte, éditeur au repos, écriture directe"
printf '\nEXT-A\n' >> $E/v1/a.md; sleep 4; report a.md EXT-A
echo "B. écriture atomique (fichier temporaire + renommage)"
cp $E/v1/a.md /tmp/cv-tmp.md; printf 'EXT-B\n' >> /tmp/cv-tmp.md; mv /tmp/cv-tmp.md $E/v1/a.md; sleep 4; report a.md EXT-B
echo "C. tu tapes dans la note juste avant que l'agent écrive"
c v1 'const cm=app.workspace.getLeavesOfType("markdown")[0].view.editor.cm; cm.dispatch({changes:{from:0, insert:"TAPÉ "}, userEvent:"input.type"}); return 1' >/dev/null
printf 'EXT-C\n' >> $E/v1/a.md; sleep 5; report a.md EXT-C; report a.md "TAPÉ"
echo "D. note fermée"
printf 'EXT-D\n' >> "$E/v1/dossier/b.md"; sleep 4; report dossier/b.md EXT-D
echo "E. 5 modifications rapides (l'agent édite plusieurs fois de suite)"
for k in 1 2 3 4 5; do printf "EXT-E$k\n" >> $E/v1/a.md; sleep 0.15; done; sleep 5
for k in 1 2 3 4 5; do report a.md EXT-E$k; done
STATE2='const s=app.plugins.plugins["collab-vault"].session; const views=app.workspace.getLeavesOfType("markdown").map(l=>l.view).filter(v=>v.file?.path==="a.md"); return JSON.stringify({doc:(s.getText("a.md")?.toString().match(/MARK-\w+/g)||[]).join(","), editeurs: views.map(v=>(v.editor.getValue().match(/MARK-\w+/g)||[]).join(",")+" ("+v.getMode()+")")})'
show() { echo "   doc/éditeurs : $(c v1 "$STATE2")   disque : $(grep -o 'MARK-[0-9]' $E/v1/a.md | tr '\n' ,)"; }
echo "G. la note n'a pas le focus (cas d'Agent Client)"
echo "1) note visible dans une zone, focus dans une autre (comme le chat d'Agent Client)"
c v1 'await app.workspace.openLinkText("a.md","",false); await new Promise(r=>setTimeout(r,800)); const leaf=app.workspace.getLeaf("split"); await leaf.openFile(app.vault.getAbstractFileByPath("dossier/b.md")); app.workspace.setActiveLeaf(leaf,{focus:true}); await new Promise(r=>setTimeout(r,800)); return 1' >/dev/null
printf '\nMARK-1\n' >> $E/v1/a.md; sleep 4; show
echo "2) note dans un onglet en arrière-plan"
c v1 'const l=app.workspace.getLeavesOfType("markdown").find(l=>l.view.file?.path==="a.md"); app.workspace.setActiveLeaf(l,{focus:true}); await new Promise(r=>setTimeout(r,300)); const t=app.workspace.getLeaf("tab"); await t.openFile(app.vault.getAbstractFileByPath("liens.md") ?? app.vault.getAbstractFileByPath("dossier/b.md")); await new Promise(r=>setTimeout(r,800)); return 1' >/dev/null
printf 'MARK-2\n' >> $E/v1/a.md; sleep 4; show
echo "3) note en mode lecture"
c v1 'const l=app.workspace.getLeavesOfType("markdown").find(l=>l.view.file?.path==="a.md"); app.workspace.setActiveLeaf(l,{focus:true}); await l.setViewState({...l.getViewState(), state:{...l.getViewState().state, mode:"preview"}}); await new Promise(r=>setTimeout(r,800)); return 1' >/dev/null
printf 'MARK-3\n' >> $E/v1/a.md; sleep 4; show
echo "   → Obsidian sauvegarde la note en mode lecture (comme en cochant une case)"
c v1 'const l=app.workspace.getLeavesOfType("markdown").find(l=>l.view.file?.path==="a.md"); await l.view.save(); await new Promise(r=>setTimeout(r,1500)); return 1' >/dev/null
sleep 2; show
[ "$(grep -c MARK-3 $E/v1/a.md)" = 1 ] && echo "✔ l'écriture de l'agent survit à la sauvegarde" || echo "✘ l'écriture de l'agent a été effacée par la sauvegarde"
echo "4) retour en mode édition, puis tu tapes une lettre"
c v1 'const l=app.workspace.getLeavesOfType("markdown").find(l=>l.view.file?.path==="a.md"); await l.setViewState({...l.getViewState(), state:{...l.getViewState().state, mode:"source"}}); app.workspace.setActiveLeaf(l,{focus:true}); await new Promise(r=>setTimeout(r,800)); const cm=l.view.editor.cm; cm.dispatch({changes:{from:0, insert:"x"}, userEvent:"input.type"}); return 1' >/dev/null
sleep 5; show

echo "F. après la sauvegarde git (35 s)"; sleep 35
for m in EXT-A EXT-B EXT-C TAPÉ EXT-E5 MARK-1 MARK-2 MARK-3; do echo "  $m dans le commit : $(git -C $E/remote.git show HEAD:a.md | grep -c "$m")  / disque : $(grep -c "$m" $E/v1/a.md)"; done
