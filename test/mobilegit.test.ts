// Moteur git du téléphone (isomorphic-git) contre un vrai serveur git HTTP protégé par jeton.
import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import http from "isomorphic-git/http/node";
import { MobileGit } from "../src/mobilegit";
import { isAuthError } from "../src/git";
import { check, sleep, failed } from "./fakes";

const ROOT = path.resolve(".build/mg-test");
const TOKEN = "jeton-de-test";
const PORT = 18765;
const URL = `http://127.0.0.1:${PORT}/remote.git`;
// Commandes au format sh : sous Windows on passe par le bash de Git for Windows (cmd ne connaît ni 2>/dev/null ni ;).
const shell = process.platform === "win32" ? "bash" : "/bin/sh";
const sh = (cmd: string, cwd = ROOT) => execSync(cmd, { cwd, stdio: "pipe", shell }).toString().trim();

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  sh("git init -q --bare -b main remote.git && git -C remote.git config http.receivepack true");
  sh("git clone -q remote.git pc 2>/dev/null; true");
  const pc = path.join(ROOT, "pc");
  sh("git config user.email pc@t && git config user.name PC && git config core.autocrlf false", pc);
  fs.writeFileSync(`${pc}/a.md`, "ligne 1\nligne 2\nligne 3\n");
  fs.writeFileSync(`${pc}/b.md`, "note b\n");
  fs.mkdirSync(`${pc}/dossier`);
  fs.writeFileSync(`${pc}/dossier/c.md`, "note c\n");
  sh("git add -A && git commit -qm init && git push -q origin HEAD:main", pc);

  const server = spawn("node", ["tools/e2e/githttp.mjs", ROOT, String(PORT), TOKEN], { stdio: "ignore" });
  await sleep(500);
  try {
    // Le téléphone a déjà des notes (reçues d'une session) dont une modifiée, et pas de .git
    const phone = path.join(ROOT, "phone");
    fs.mkdirSync(phone);
    fs.writeFileSync(`${phone}/a.md`, "ligne 1\nligne 2 modifiée sur le téléphone\nligne 3\n");
    fs.writeFileSync(`${phone}/b.md`, "note b\n");

    const errors: string[] = [];
    const mk = (token = TOKEN) =>
      new MobileGit(
        { fs, http, dir: phone, token: () => token, author: () => ({ name: "Téléphone", email: "tel@t" }) },
        () => ({ commitMessage: "mobile: {{date}} ({{count}})", push: true, pullBeforePush: true }),
        () => {},
        (m: string) => errors.push(m),
      );

    check("mauvais jeton refusé", !(await MobileGit.checkAccess(http, URL, "faux")).ok);
    check("bon jeton accepté", (await MobileGit.checkAccess(http, URL, TOKEN)).ok);

    const g = mk();
    await g.connect(URL);
    check("connexion : dépôt créé", await g.isRepo());
    check("connexion : modif locale gardée", fs.readFileSync(`${phone}/a.md`, "utf8").includes("modifiée sur le téléphone"));
    check("connexion : fichier manquant récupéré", fs.readFileSync(`${phone}/dossier/c.md`, "utf8") === "note c\n");
    const info0 = await g.info();
    check("connexion : seul a.md apparaît modifié", info0.changes.length === 1 && info0.changes[0].path === "a.md" && info0.changes[0].kind === "M", info0.changes);

    await g.ensureIgnored([".obsidian/plugins/collab-vault/data.json", ".obsidian/plugins/collab-vault/base-*.json"]);
    await g.sync(true);
    check("push depuis le téléphone", sh("git log -1 --format=%an main", path.join(ROOT, "remote.git")) === "Téléphone");
    check("le contenu poussé est le bon", sh("git show main:a.md", path.join(ROOT, "remote.git")).includes("modifiée sur le téléphone"));
    check(".gitignore poussé", sh("git show main:.gitignore", path.join(ROOT, "remote.git")).includes("base-*.json"));

    // L'ordinateur et le téléphone modifient des fichiers différents
    sh("git pull -q --rebase", pc);
    fs.writeFileSync(`${pc}/b.md`, "note b modifiée sur PC\n");
    sh("git commit -qam pc && git push -q", pc);
    fs.writeFileSync(`${phone}/dossier/c.md`, "note c modifiée sur téléphone\n");
    await g.sync(true);
    check("fusion : modif du PC reçue sur le téléphone", fs.readFileSync(`${phone}/b.md`, "utf8") === "note b modifiée sur PC\n");
    sh("git pull -q --rebase", pc);
    check("fusion : modif du téléphone reçue sur le PC", fs.readFileSync(`${pc}/dossier/c.md`, "utf8") === "note c modifiée sur téléphone\n");

    // Même fichier, lignes différentes : fusion propre
    fs.writeFileSync(`${pc}/a.md`, "ligne 1 PC\nligne 2 modifiée sur le téléphone\nligne 3\nligne 4\nligne 5\n");
    sh("git commit -qam pc2 && git push -q", pc);
    await g.sync(true); // récupère
    fs.writeFileSync(`${phone}/a.md`, fs.readFileSync(`${phone}/a.md`, "utf8").replace("ligne 5", "ligne 5 téléphone"));
    fs.writeFileSync(`${pc}/a.md`, fs.readFileSync(`${pc}/a.md`, "utf8").replace("ligne 1 PC", "ligne 1 PC bis"));
    sh("git commit -qam pc3 && git push -q", pc);
    await g.sync(true);
    const merged = fs.readFileSync(`${phone}/a.md`, "utf8");
    check("même fichier, lignes différentes : les deux gardées", merged.includes("ligne 1 PC bis") && merged.includes("ligne 5 téléphone"), merged);

    // Conflit sur la même ligne : la version du téléphone (= session) gagne, pas d'erreur bloquante
    sh("git pull -q --rebase", pc);
    fs.writeFileSync(`${pc}/b.md`, "conflit version PC\n");
    sh("git commit -qam pc4 && git push -q", pc);
    fs.writeFileSync(`${phone}/b.md`, "conflit version téléphone\n");
    errors.length = 0;
    await g.sync(true);
    check("conflit : la version locale gagne", fs.readFileSync(`${phone}/b.md`, "utf8") === "conflit version téléphone\n");
    check("conflit : signalé, puis poussé", errors.some(e => e.includes("conflit")) && sh("git show main:b.md", path.join(ROOT, "remote.git")) === "conflit version téléphone");
    check("pas d'erreur bloquante", g.lastError === null, g.lastError);

    // Panneau git
    const info = await g.info();
    check("panneau : à jour, historique lisible", info.ahead === 0 && info.behind === 0 && info.log.length >= 10 && info.log.every(c => c.pushed), info);
    check("panneau : chaque commit une seule fois", new Set(info.log.map(c => c.hash)).size === info.log.length);
    const files = await g.commitFiles(info.log.find(c => c.subject === "init")!.hash);
    check("panneau : fichiers d'un commit", files.some(f => f.path === "dossier/c.md"), files);

    // Jeton révoqué
    const bad = mk("révoqué");
    fs.writeFileSync(`${phone}/b.md`, "encore\n");
    await bad.sync(true);
    check("jeton invalide : erreur de connexion détectée", !!bad.lastError?.auth || isAuthError(bad.lastError?.message ?? ""), bad.lastError);

    // Dépôt dont la branche par défaut est master (pas main)
    sh("git init -q --bare -b master remote-master.git && git -C remote-master.git config http.receivepack true");
    sh("git clone -q remote-master.git pcm 2>/dev/null; true");
    const pcm = path.join(ROOT, "pcm");
    sh("git config user.email pc@t && git config user.name PC && git config core.autocrlf false", pcm);
    fs.writeFileSync(`${pcm}/m.md`, "note du dépôt master\n");
    sh("git add -A && git commit -qm init-master && git push -q origin HEAD:master", pcm);
    const URL_MASTER = `http://127.0.0.1:${PORT}/remote-master.git`;
    const mkAt = (dir: string) =>
      new MobileGit(
        { fs, http, dir, token: () => TOKEN, author: () => ({ name: "Téléphone", email: "tel@t" }) },
        () => ({ commitMessage: "mobile: {{date}} ({{count}})", push: true, pullBeforePush: true }),
        () => {},
        (m: string) => errors.push(m),
      );
    const phoneM = path.join(ROOT, "phone-master");
    fs.mkdirSync(phoneM);
    const gm = mkAt(phoneM);
    let err = "";
    await gm.connect(URL_MASTER).catch((e: any) => (err = e.message));
    check("dépôt en master : connexion sans erreur", !err, err);
    check("dépôt en master : note récupérée", fs.existsSync(`${phoneM}/m.md`) && fs.readFileSync(`${phoneM}/m.md`, "utf8") === "note du dépôt master\n");
    check("dépôt en master : branche master", (await gm.info()).branch === "master");
    fs.writeFileSync(`${phoneM}/depuis-tel.md`, "écrit sur le téléphone\n");
    await gm.sync(true);
    check("dépôt en master : push sur master", sh("git show master:depuis-tel.md", path.join(ROOT, "remote-master.git")) === "écrit sur le téléphone");

    // Téléphone déjà branché sur un dépôt en main, qu'on rebranche sur un dépôt en master
    err = "";
    await g.connect(URL_MASTER).catch((e: any) => (err = e.message));
    check("rebranchement main → master : sans erreur", !err, err);
    check("rebranchement : branche master", (await g.info()).branch === "master");
    check("rebranchement : note du nouveau dépôt récupérée", fs.existsSync(`${phone}/m.md`));

    // Dépôt vide : message clair, rien de cassé
    sh("git init -q --bare -b main remote-vide.git");
    const phoneV = path.join(ROOT, "phone-vide");
    fs.mkdirSync(phoneV);
    err = "";
    await mkAt(phoneV).connect(`http://127.0.0.1:${PORT}/remote-vide.git`).catch((e: any) => (err = e.message));
    check("dépôt vide : message clair", /vide/.test(err), err);

    // Coffre déjà relié (main) dont l'adresse enregistrée pointe vers un dépôt sans main :
    // la synchro doit expliquer quoi faire au lieu de « Could not find refs/heads/main ».
    const phoneS = path.join(ROOT, "phone-stale");
    fs.mkdirSync(phoneS);
    const gs = mkAt(phoneS);
    await gs.connect(URL);
    sh(`git -C "${phoneS}" config remote.origin.url ${URL_MASTER}`);
    fs.writeFileSync(`${phoneS}/x.md`, "x\n");
    await gs.sync(true);
    check("adresse sans la branche : message clair", /n'a pas de branche « main »/.test(gs.lastError?.message ?? ""), gs.lastError);
    check("adresse sans la branche : commit gardé en local", (await gs.info()).ahead >= 1);
    sh(`git -C "${phoneS}" config remote.origin.url https://github.com/TheoYOSHIURA/obsidian-collab-vault.git`);
    await gs.sync(true);
    check("adresse du plugin enregistrée : message clair", /celle du plugin/.test(gs.lastError?.message ?? ""), gs.lastError);
    // Après correction de l'adresse dans l'assistant, tout repart
    await gs.connect(URL);
    await gs.sync(true);
    check("adresse corrigée : synchro sans erreur", gs.lastError === null, gs.lastError);
    check("adresse corrigée : note envoyée", sh("git show main:x.md", path.join(ROOT, "remote.git")) === "x");

    // Adresse du plugin au lieu de celle du coffre
    err = "";
    await mkAt(phoneV).connect("https://github.com/TheoYOSHIURA/obsidian-collab-vault").catch((e: any) => (err = e.message));
    check("adresse du plugin refusée", /plugin/.test(err), err);
  } finally {
    server.kill();
  }
  console.log(failed() ? `\n${failed()} échec(s)` : "\nTout est OK");
  process.exit(failed() ? 1 : 0);
}
main();
