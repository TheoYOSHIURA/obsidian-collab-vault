// Tests du cœur de synchro avec un réseau et des disques simulés.
// Lancer : npm test
import { Session, applyDiff, isText } from "../src/session";
import * as Y from "yjs";
import { check, sleep, failed, Hub, FakeTransport, MemDisk } from "./fakes";

const hub = new Hub();
function peer(id: string, disk: MemDisk, opts: { git?: boolean; delay?: number } = {}) {
  const t = new FakeTransport(hub, id);
  const s = new Session(t, disk, { name: id, color: "#ff0000", git: opts.git ?? true, joinTimeoutMs: 100 }, {
    isBound: () => false,
    onStructure: () => {},
    onPeers: () => {},
    log: () => {},
  });
  disk.session = s;
  hub.connect(t);
  s.start();
  return s;
}
const same = (a: MemDisk, b: MemDisk) =>
  JSON.stringify(Array.from(a.files).sort()) === JSON.stringify(Array.from(b.files).sort());

async function main() {
  // applyDiff
  {
    const d = new Y.Doc();
    const t = d.getText();
    t.insert(0, "Bonjour le monde");
    applyDiff(t, "Bonjour tout le monde !");
    check("applyDiff produit le bon texte", t.toString() === "Bonjour tout le monde !");
  }

  // 1. Le premier arrivé devient hôte, le second récupère le coffre
  const dA = new MemDisk({ "a.md": "note A", "dossier/b.md": "note B", "img.png": "BIN" });
  const A = peer("A", dA);
  await sleep(300);
  check("A seul devient hôte", A.seeded && A.host()?.id === "A");

  const dB = new MemDisk({ "a.md": "vieille version", "perso.md": "local" });
  const B = peer("B", dB);
  await sleep(300);
  check("B rejoint la session de A", B.seeded && B.origin === "A" && B.host()?.id === "A");
  check("le disque de B reçoit les notes de A", dB.files.get("a.md") === "note A" && dB.files.get("dossier/b.md") === "note B");
  check("les fichiers binaires ne passent pas par le doc", !A.files.has("img.png"));
  check("A est le responsable git", A.gitLeader()?.id === "A" && B.gitLeader()?.id === "A");

  // 2. Éditions simultanées sur la même note
  A.getText("a.md")!.insert(0, "[A] ");
  B.getText("a.md")!.insert(6, " [B]");
  await sleep(200);
  check("éditions simultanées fusionnées", A.getText("a.md")!.toString() === B.getText("a.md")!.toString(), [
    A.getText("a.md")!.toString(),
    B.getText("a.md")!.toString(),
  ]);
  check("le disque des deux suit le doc", dA.files.get("a.md") === dB.files.get("a.md") && dA.files.get("a.md")!.includes("[A]") && dA.files.get("a.md")!.includes("[B]"));

  // 3. Modification hors éditeur (ex. git pull) côté B
  dB.edit("dossier/b.md", "note B modifiée par git");
  await sleep(200);
  check("modif disque de B propagée à A", dA.files.get("dossier/b.md") === "note B modifiée par git");

  // 4. Création, renommage, suppression
  dA.edit("nouvelle.md", "fraîche");
  await sleep(200);
  check("création propagée", dB.files.get("nouvelle.md") === "fraîche");
  await dA.rename("nouvelle.md", "dossier/renommée.md");
  await sleep(200);
  check("renommage propagé", dB.files.get("dossier/renommée.md") === "fraîche" && !dB.files.has("nouvelle.md"));
  await dB.remove("dossier/renommée.md");
  await sleep(200);
  check("suppression propagée", !dA.files.has("dossier/renommée.md"));

  // 5. Un troisième pair arrive, l'hôte part, la session continue
  const dC = new MemDisk({});
  const C = peer("C", dC, { git: false });
  await sleep(300);
  check("C (sans git, coffre vide) reçoit tout", same(dC, new MemDisk(Object.fromEntries(Array.from(dA.files).filter(([k]) => isText(k))))));
  await A.stop();
  await sleep(100);
  check("A parti : B devient hôte et responsable git", B.host()?.id === "B" && B.gitLeader()?.id === "B" && C.gitLeader()?.id === "B");
  C.getText("a.md")!.insert(0, "C:");
  await sleep(300);
  check("B et C continuent de collaborer", dB.files.get("a.md")!.startsWith("C:"));

  // 6. Deux personnes ouvrent en même temps sans se voir → une seule session à la fin
  const hub2Disk1 = new MemDisk({ "x.md": "X" });
  const hub2Disk2 = new MemDisk({ "x.md": "X" });
  hub.latency = 5;
  const D = peer("D", hub2Disk1);
  // E est isolé le temps de créer sa propre session
  const tE = new FakeTransport(hub, "E");
  const E = new Session(tE, hub2Disk2, { name: "E", color: "#00f", git: true, joinTimeoutMs: 50 }, {
    isBound: () => false, onStructure: () => {}, onPeers: () => {}, log: () => {},
  });
  hub2Disk2.session = E;
  E.start();
  await sleep(200);
  check("E isolé crée sa propre session", E.seeded && E.origin === "E");
  hub.connect(tE);
  await sleep(300);
  const origins = new Set([B.origin, C.origin, D.origin, E.origin]);
  check("les sessions parallèles fusionnent en une seule", origins.size === 1, Array.from(origins));
  check("pas de texte dupliqué après fusion", hub2Disk2.files.get("x.md") === undefined || !hub2Disk2.files.get("x.md")!.includes("XX"));

  // Note ouverte dans un éditeur (« liée ») : écritures extérieures vs sauvegardes d'Obsidian
  {
    const h4 = new Hub();
    const mk = (id: string, disk: MemDisk) => {
      const t = new FakeTransport(h4, id);
      const sess = new Session(t, disk, { name: id, color: "#000", git: true, joinTimeoutMs: 50, boundDelayMs: 20 }, {
        isBound: p => p === "n.md", onStructure: () => {}, onPeers: () => {}, log: () => {},
      });
      disk.session = sess;
      h4.connect(t);
      sess.start();
      return sess;
    };
    const d1 = new MemDisk({ "n.md": "début\n" });
    const d2 = new MemDisk({});
    const P1 = mk("p1", d1);
    await sleep(150);
    const P2 = mk("p2", d2);
    await sleep(200);
    // P1 tape dans son éditeur (le doc suit), puis Obsidian sauvegarde cette version…
    P1.getText("n.md")!.insert(P1.getText("n.md")!.length, "tapé par p1\n");
    const saved = P1.getText("n.md")!.toString();
    // … pendant que P2 continue de taper
    await sleep(30);
    P2.getText("n.md")!.insert(P2.getText("n.md")!.length, "tapé par p2 juste après\n");
    await sleep(60);
    d1.edit("n.md", saved); // sauvegarde en retard d'Obsidian chez P1
    await sleep(100);
    check("note ouverte : une sauvegarde en retard n'efface pas ce que l'autre vient de taper", P1.getText("n.md")!.toString().includes("p2 juste après"));
    // Un agent (Claude) écrit directement sur le disque de P1, note ouverte
    d1.edit("n.md", P1.getText("n.md")!.toString() + "écrit par l'agent\n");
    await sleep(100);
    check("note ouverte : l'écriture d'un agent arrive dans le doc (et chez l'autre)", P2.getText("n.md")!.toString().includes("écrit par l'agent"));
    // On tape (pas encore sauvegardé), puis l'agent écrit à partir de la version du disque
    const onDisk = d1.files.get("n.md")!;
    P1.getText("n.md")!.insert(0, "TAPÉ ");
    d1.edit("n.md", onDisk + "ligne de l'agent\n");
    await sleep(100);
    const t = P1.getText("n.md")!.toString();
    check("note ouverte : frappe non sauvegardée + écriture d'agent = les deux gardées", t.startsWith("TAPÉ ") && t.includes("ligne de l'agent"), t);
    await Promise.all([P1.stop(), P2.stop()]);
  }

  // Un téléphone avec git arrivé en premier ne sauvegarde pas si un ordinateur avec git est là
  {
    const h3 = new Hub();
    const mk = (id: string, mobile: boolean) => {
      const t = new FakeTransport(h3, id);
      const sess = new Session(t, new MemDisk({ "n.md": "x" }), { name: id, color: "#000", git: true, gitMobile: mobile, joinTimeoutMs: 50 }, {
        isBound: () => false, onStructure: () => {}, onPeers: () => {}, log: () => {},
      });
      h3.connect(t);
      sess.start();
      return sess;
    };
    const tel = mk("tel", true);
    await sleep(150);
    check("téléphone seul : il sauvegarde", tel.gitLeader()?.id === "tel");
    const pc2 = mk("pc", false);
    await sleep(200);
    check("un ordinateur arrive : c'est lui qui sauvegarde", tel.gitLeader()?.id === "pc" && pc2.gitLeader()?.id === "pc" && tel.host()?.id === "tel");
    await Promise.all([tel.stop(), pc2.stop()]);
  }

  await Promise.all([B.stop(), C.stop(), D.stop(), E.stop()]);
  console.log(failed() ? `\n${failed()} échec(s)` : "\nTout est OK");
  process.exit(failed() ? 1 : 0);
}
main();
