// Création du dépôt et liaison GitHub (assistant ordinateur), contre de vrais dépôts git locaux.
// Lancer : esbuild test/gitsetup.test.ts --bundle --platform=node --alias:obsidian=./test/obsidian-stub.ts --outfile=.build/gitsetup.cjs && node .build/gitsetup.cjs
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Git } from "../src/git";
import { GitSetup } from "../src/gitsetup";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cv-setup-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
let failed = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "✔" : "✘"} ${label}`);
  if (!ok) failed++;
};

function vault(name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}
function backup(dir: string) {
  const errors: string[] = [];
  const g = new Git(dir, "git", () => ({ commitMessage: "vault: {{date}}", push: true, pullBeforePush: true }), () => {}, m => errors.push(m));
  return { g, errors };
}
async function prepare(dir: string) {
  const setup = new GitSetup("git", dir);
  const r = await setup.initRepo();
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  const { g, errors } = backup(dir);
  await g.ensureIgnored([".obsidian/workspace.json"]);
  return { setup, r, g, errors };
}

async function main() {
  const bare = path.join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const url = "file://" + bare.replace(/\\/g, "/");

  // 1. coffre neuf : création du dépôt, sauvegarde locale sans GitHub
  const a = vault("a", { "Bienvenue.md": "salut\n", ".obsidian/workspace.json": "{}" });
  const A = await prepare(a);
  check(A.r.ok && fs.existsSync(a + "/.git"), "dépôt créé");
  check(git(a, "symbolic-ref", "--short", "HEAD") === "main", "branche main");
  check(fs.readFileSync(a + "/.gitattributes", "utf8").includes("text=auto"), ".gitattributes créé");
  await A.g.sync(true);
  check(A.errors.length === 0, "sauvegarde sans GitHub : aucune erreur " + A.errors.join(" | "));
  check(git(a, "rev-list", "--count", "HEAD") === "1", "premier commit local");
  check(!git(a, "ls-files").includes("workspace.json"), "workspace.json pas versionné");

  // 2. liaison à un dépôt vide, puis premier push
  const c1 = await A.setup.connectRemote(url);
  check(c1.ok, "liaison au dépôt vide : " + c1.message);
  await A.g.sync(true);
  check(A.errors.length === 0, "premier push sans erreur " + A.errors.join(" | "));
  check(git(bare, "rev-parse", "main") === git(a, "rev-parse", "HEAD"), "le dépôt distant a reçu le commit");
  check(git(a, "rev-parse", "--abbrev-ref", "@{u}") === "origin/main", "branche suivie origin/main");

  // 3. autre coffre avec d'autres notes : fusion avec le dépôt existant
  const b = vault("b", { "Autre.md": "note b\n" });
  const B = await prepare(b);
  const c2 = await B.setup.connectRemote(url);
  check(c2.ok, "liaison à un dépôt non vide : " + c2.message);
  check(fs.existsSync(b + "/Bienvenue.md") && fs.existsSync(b + "/Autre.md"), "notes des deux côtés présentes");
  await B.g.sync(true);
  check(B.errors.length === 0, "push après fusion sans erreur " + B.errors.join(" | "));
  await A.g.sync(true);
  check(fs.existsSync(a + "/Autre.md"), "le premier coffre récupère la note de l'autre");

  // 4. coffre en conflit : rien n'est modifié
  const c = vault("c", { "Bienvenue.md": "version différente\n" });
  const C = await prepare(c);
  const c3 = await C.setup.connectRemote(url);
  check(!c3.ok, "conflit détecté : " + c3.message);
  const local = fs.readFileSync(c + "/Bienvenue.md", "utf8").replace(/\r/g, "");
  check(local === "version différente\n", "note locale intacte " + JSON.stringify(local));
  check(!fs.existsSync(c + "/.git/MERGE_HEAD"), "pas de fusion en cours");
  check(!git(c, "remote"), "liaison annulée (pas de push refusé ensuite)");
  await C.g.sync(true);
  check(C.errors.length === 0, "sauvegarde locale toujours sans erreur " + C.errors.join(" | "));

  // 5. détection du dépôt : racine oui, sous-dossier ou dossier sans git non
  fs.mkdirSync(a + "/sous-dossier");
  check(await backup(a).g.isRepo(), "racine du dépôt reconnue");
  check(!(await backup(a + "/sous-dossier").g.isRepo()), "sous-dossier d'un dépôt pas pris pour un dépôt");
  check(!(await backup(vault("sans-git", {})).g.isRepo()), "dossier sans git pas pris pour un dépôt");

  // 6. copie dont la branche n'est pas reliée à origin/main, en retard sur GitHub
  const d = vault("d", {});
  git(d, "clone", "-q", url, ".");
  git(d, "config", "user.name", "Test");
  git(d, "config", "user.email", "test@example.com");
  git(d, "branch", "--unset-upstream");
  git(d, "reset", "-q", "--hard", "HEAD~1"); // en retard d'un commit
  fs.writeFileSync(d + "/Nouvelle.md", "nouvelle\n");
  const D = backup(d);
  await D.g.sync(true);
  check(D.errors.length === 0, "branche non suivie : sauvegarde sans erreur " + D.errors.join(" | "));
  check(git(d, "rev-parse", "--abbrev-ref", "@{u}") === "origin/main", "branche reliée à origin/main");
  check(git(bare, "rev-parse", "main") === git(d, "rev-parse", "HEAD"), "commit envoyé après récupération des nouveautés");

  // 7. adresse invalide
  check(!(await C.setup.connectRemote("pas une adresse")).ok, "adresse invalide refusée");

  // 8. Récupérer depuis GitHub ne doit jamais réécrire une note qu'on n'a pas besoin de changer.
  //    (rebase / stash remettaient la note à son ancienne version un instant : Obsidian la
  //    rechargeait et on voyait un « rollback ».) On date les fichiers dans le passé : s'ils sont
  //    réécrits, même avec le même contenu, leur date change.
  const e1 = vault("e1", {});
  const e2 = vault("e2", {});
  for (const e of [e1, e2]) {
    git(e, "clone", "-q", url, ".");
    git(e, "config", "user.name", "Test");
    git(e, "config", "user.email", "test@example.com");
    git(e, "config", "core.autocrlf", "false");
  }
  const E1 = backup(e1);
  const old = new Date("2020-01-01T00:00:00Z");
  const stamp = (f: string) => fs.utimesSync(f, old, old);
  const untouched = (f: string) => fs.statSync(f).mtimeMs === old.getTime();
  // Les coffres ont « * text=auto » : sous Windows les notes sont écrites en \r\n.
  const read = (f: string) => fs.readFileSync(f, "utf8").replace(/\r/g, "");
  const pushFrom = (e: string, file: string, text: string) => {
    fs.writeFileSync(`${e}/${file}`, text);
    git(e, "add", "-A");
    git(e, "commit", "-qm", "autre appareil");
    git(e, "pull", "-q", "--no-rebase");
    git(e, "push", "-q");
  };

  // a) un commit local, un commit distant sur une autre note : fusion sans réécrire la note locale
  fs.writeFileSync(`${e1}/Locale.md`, "écrite ici\n");
  git(e1, "add", "-A");
  git(e1, "commit", "-qm", "local");
  stamp(`${e1}/Locale.md`);
  pushFrom(e2, "Distante.md", "écrite ailleurs\n");
  await E1.g.sync(true);
  check(E1.errors.length === 0, "fusion : sans erreur " + E1.errors.join(" | "));
  check(untouched(`${e1}/Locale.md`), "fusion : la note locale n'est pas réécrite");
  check(read(`${e1}/Distante.md`) === "écrite ailleurs\n", "fusion : la note distante arrive");
  check(git(bare, "rev-parse", "main") === git(e1, "rev-parse", "HEAD"), "fusion : envoyé sur GitHub");

  // b) note en cours d'écriture (pas encore commitée) pendant une récupération
  fs.writeFileSync(`${e1}/Locale.md`, "écrite ici\nen cours de frappe\n");
  stamp(`${e1}/Locale.md`);
  pushFrom(e2, "Distante.md", "écrite ailleurs\nencore\n");
  await E1.g.pull();
  check(E1.errors.length === 0, "note en cours : sans erreur " + E1.errors.join(" | "));
  check(untouched(`${e1}/Locale.md`), "note en cours : pas réécrite (pas de stash)");
  check(read(`${e1}/Locale.md`) === "écrite ici\nen cours de frappe\n", "note en cours : texte intact");
  check(read(`${e1}/Distante.md`) === "écrite ailleurs\nencore\n", "note en cours : la note distante arrive quand même");

  // c) la note en cours d'écriture a aussi changé sur GitHub : on n'y touche pas, on réessaie après commit
  pushFrom(e2, "Locale.md", "écrite ici\nmodifiée ailleurs\n");
  stamp(`${e1}/Locale.md`);
  await E1.g.pull();
  check(E1.errors.length === 0, "même note : pas d'erreur, récupération reportée " + E1.errors.join(" | "));
  check(untouched(`${e1}/Locale.md`) && read(`${e1}/Locale.md`) === "écrite ici\nen cours de frappe\n", "même note : texte en cours intact");
  await E1.g.sync(true);
  check(!fs.existsSync(`${e1}/.git/MERGE_HEAD`), "même note : rien de bloqué après la synchro suivante");
  check(git(bare, "rev-parse", "main") === git(e1, "rev-parse", "HEAD"), "même note : tout est envoyé");
  check(read(`${e1}/Locale.md`).includes("en cours de frappe"), "même note : notre version gardée");

  if (!failed) fs.rmSync(root, { recursive: true, force: true });
  else console.log("dossier gardé : " + root);
  console.log(failed ? `\n${failed} échec(s)` : "\nTout est OK");
  process.exit(failed ? 1 : 0);
}
void main();
