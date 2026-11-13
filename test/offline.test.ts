// Modifications hors ligne (téléphone dans le métro, git pull avant de rejoindre…)
// fusionnées à la reconnexion, sans perte ni doublon.
import { merge3 } from "../src/session";
import { check, sleep, failed, Hub, MemDisk, MemBase, makePeer } from "./fakes";

const lines = (...l: string[]) => l.join("\n") + "\n";

async function main() {
  // merge3
  check("merge3 : modifs à des endroits différents", merge3(lines("a", "b", "c", "D"), lines("a", "b", "c", "d"), lines("A", "b", "c", "d")).text === lines("A", "b", "c", "D"));
  check("merge3 : même modif des deux côtés = pas de conflit", merge3(lines("a", "x"), lines("a"), lines("a", "x")).clean);
  check("merge3 : même ligne modifiée différemment = conflit", !merge3(lines("1"), lines("0"), lines("2")).clean);

  const hub = new Hub();
  const note = lines("# Cours", "intro", "milieu", "fin");
  const pc = new MemDisk({ "cours.md": note, "autre.md": "autre\n", "vieux.md": "à supprimer\n", "garde.md": "garde\n" });
  const phoneDisk = new MemDisk({});
  const phoneBase = new MemBase();

  const A = makePeer(hub, "PC", pc, { base: new MemBase() });
  await sleep(250);
  let P = makePeer(hub, "Tel", phoneDisk, { git: false, base: phoneBase });
  await sleep(300);
  check("le téléphone reçoit le coffre", phoneDisk.files.get("cours.md") === note);
  check("la base partagée est enregistrée sur le téléphone", phoneBase.data?.["cours.md"] === note);

  // Le téléphone part (métro)…
  await P.stop();
  await sleep(50);
  // … modifie hors ligne
  phoneDisk.files.set("cours.md", lines("# Cours", "intro", "milieu", "fin", "ajout métro"));
  phoneDisk.files.set("métro.md", "nouvelle note\n");
  phoneDisk.files.delete("vieux.md");
  phoneDisk.files.set("garde.md", "garde modifiée\n");
  // … pendant que le PC continue
  pc.edit("cours.md", lines("# Cours de PC", "intro", "milieu", "fin"));
  pc.edit("autre.md", "autre modifié sur PC\n");
  await sleep(200);

  P = makePeer(hub, "Tel", phoneDisk, { git: false, base: phoneBase });
  await sleep(400);
  const expected = lines("# Cours de PC", "intro", "milieu", "fin", "ajout métro");
  check("modifs hors ligne + modifs du PC fusionnées", pc.files.get("cours.md") === expected && phoneDisk.files.get("cours.md") === expected, [pc.files.get("cours.md"), phoneDisk.files.get("cours.md")]);
  check("note créée hors ligne arrive sur le PC", pc.files.get("métro.md") === "nouvelle note\n");
  check("note supprimée hors ligne supprimée sur le PC", !pc.files.has("vieux.md"));
  check("modif du PC pendant l'absence arrive sur le téléphone", phoneDisk.files.get("autre.md") === "autre modifié sur PC\n");
  check("note modifiée seulement hors ligne", pc.files.get("garde.md") === "garde modifiée\n");

  // Conflit : même ligne modifiée des deux côtés
  await P.stop();
  await sleep(50);
  phoneDisk.files.set("autre.md", "version téléphone\n");
  pc.edit("autre.md", "version PC\n");
  await sleep(200);
  P = makePeer(hub, "Tel", phoneDisk, { git: false, base: phoneBase });
  await sleep(400);
  const copies = [...pc.files.keys()].filter(k => k.startsWith("autre (conflit Tel"));
  check("conflit : la session garde sa version", pc.files.get("autre.md") === "version PC\n" && phoneDisk.files.get("autre.md") === "version PC\n");
  check("conflit : la version du téléphone est gardée dans une copie", copies.length === 1 && pc.files.get(copies[0]) === "version téléphone\n", copies);

  // Même modif des deux côtés (ex. git pull déjà fait par l'hôte) : pas de doublon
  await P.stop();
  await sleep(50);
  phoneDisk.files.set("cours.md", phoneDisk.files.get("cours.md") + "ligne venue de git\n");
  pc.edit("cours.md", pc.files.get("cours.md") + "ligne venue de git\n");
  await sleep(200);
  P = makePeer(hub, "Tel", phoneDisk, { git: false, base: phoneBase });
  await sleep(400);
  check("même modif des deux côtés : pas de doublon", (pc.files.get("cours.md")!.match(/venue de git/g) ?? []).length === 1, pc.files.get("cours.md"));

  // Fichiers Windows (CRLF) : pas de différence fantôme
  await P.stop();
  await sleep(50);
  phoneDisk.files.set("cours.md", phoneDisk.files.get("cours.md")!.replace(/\n/g, "\r\n"));
  P = makePeer(hub, "Tel", phoneDisk, { git: false, base: phoneBase });
  await sleep(400);
  check("fins de ligne Windows ignorées", !pc.files.get("cours.md")!.includes("\r") && P.lastJoin?.merged === 0 && P.lastJoin?.conflicts === 0, P.lastJoin);

  // Le téléphone arrive en premier (hôte) avec des modifs hors ligne, le PC rejoint ensuite
  await Promise.all([P.stop(), A.stop()]);
  await sleep(50);
  phoneDisk.files.set("garde.md", "garde v3 téléphone\n");
  pc.files.set("autre.md", "PC hors ligne aussi\n");
  P = makePeer(hub, "Tel", phoneDisk, { git: false, base: phoneBase });
  await sleep(250);
  const pcBase = new MemBase();
  pcBase.data = { ...phoneBase.data! };
  const A2 = makePeer(hub, "PC", pc, { base: pcBase });
  await sleep(400);
  check("hôte = téléphone, ses modifs gardées", pc.files.get("garde.md") === "garde v3 téléphone\n");
  check("le PC qui rejoint garde aussi les siennes", phoneDisk.files.get("autre.md") === "PC hors ligne aussi\n");

  await Promise.all([P.stop(), A2.stop()]);
  console.log(failed() ? `\n${failed()} échec(s)` : "\nTout est OK");
  process.exit(failed() ? 1 : 0);
}
main();
