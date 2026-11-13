#!/bin/bash
# Recrée 2 coffres de test (v1, v2) clonés d'un dépôt local, avec le plugin installé et activé.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd); E=$ROOT/.build/e2e
rm -rf $E; mkdir -p $E && cd $E
git init -q --bare remote.git
git clone -q remote.git seed 2>/dev/null; cd seed; git config user.email t@t; git config user.name seed
mkdir -p dossier .obsidian/plugins/collab-vault .collab
printf '# Note A\n\nBonjour.\n' > a.md; printf 'note B\n' > dossier/b.md
python3 -c "import base64;open('img.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))"
echo '["collab-vault"]' > .obsidian/community-plugins.json; echo '{"alwaysUpdateLinks":true}' > .obsidian/app.json
echo '{"room":"e2e-'$RANDOM$RANDOM'","secret":"e2e-secret-'$RANDOM$RANDOM'"}' > .collab/room.json
cp $ROOT/main.js $ROOT/manifest.json $ROOT/styles.css .obsidian/plugins/collab-vault/
echo '{}' > .obsidian/workspace.json   # suivi exprès : le plugin doit le sortir du dépôt
git add -A && git commit -qm init && git push -q origin HEAD 2>&1
cd $E; for v in v1 v2; do git clone -q remote.git $v; git -C $v config user.email $v@t; git -C $v config user.name $v
  echo '{"name":"'$v'","color":"#e5484d","delaySeconds":3,"pullIntervalMin":1}' > $v/.obsidian/plugins/collab-vault/data.json; done
# v3 : ami sans git, coffre vide (dans un sous-dossier du dépôt du projet : ne doit PAS être vu comme un dépôt)
mkdir -p v3/.obsidian/plugins/collab-vault; cp $ROOT/main.js $ROOT/manifest.json $ROOT/styles.css v3/.obsidian/plugins/collab-vault/
echo '["collab-vault"]' > v3/.obsidian/community-plugins.json; echo '{"name":"v3"}' > v3/.obsidian/plugins/collab-vault/data.json
mkdir -p userdata; echo '{"vaults":{"aaaa000000000001":{"path":"'$E'/v1","ts":1,"open":true},"aaaa000000000002":{"path":"'$E'/v2","ts":2,"open":true},"aaaa000000000003":{"path":"'$E'/v3","ts":3,"open":true}}}' > userdata/obsidian.json
