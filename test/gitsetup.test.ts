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

  // 6. adresse invalide
  check(!(await C.setup.connectRemote("pas une adresse")).ok, "adresse invalide refusée");

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} échec(s)` : "\nTout est OK");
  process.exit(failed ? 1 : 0);
}
void main();
