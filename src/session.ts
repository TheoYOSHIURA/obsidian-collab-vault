// Cœur de la collaboration : un Y.Doc par coffre, synchronisé en pair-à-pair.
// Indépendant d'Obsidian (disque et réseau sont injectés) pour pouvoir être testé seul.
import * as Y from "yjs";
import * as aw from "y-protocols/awareness";
import { diff3Merge } from "node-diff3";

/** Origine des transactions venant d'un autre pair. */
export const REMOTE = "remote";
/** Origine des transactions venant du disque local (édition hors éditeur, git pull…). */
export const DISK = "disk";

export const TEXT_EXT = new Set(["md", "canvas", "base", "txt", "csv"]);
export const isText = (path: string) => TEXT_EXT.has(path.split(".").pop()!.toLowerCase());

export interface Disk {
  listText(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/**
 * Dernière version PARTAGÉE de chaque note (enregistrée sur l'appareil). Sert de base
 * à la fusion à trois quand on rejoint une session après avoir modifié hors ligne.
 */
export interface BaseStore {
  load(): Promise<Record<string, string> | null>;
  save(texts: Record<string, string>): Promise<void>;
}

export interface Hello {
  v: 1;
  startedAt: number;
  seeded: boolean;
  /** Pair qui a créé la version du document qu'on partage (null = pas encore synchronisé). */
  origin: string | null;
  originAt: number;
  git: boolean;
  /** git « de téléphone » (isomorphic-git) : on préfère qu'un ordinateur sauvegarde. */
  mobile?: boolean;
  name: string;
  clientId: number;
}

export type YKind = "s1" | "s2" | "u";

export interface Transport {
  readonly selfId: string;
  sendHello(h: Hello, to?: string): void;
  sendY(kind: YKind, data: Uint8Array, to?: string): void;
  sendAw(data: Uint8Array): void;
  onHello(cb: (h: Hello, from: string) => void): void;
  onY(cb: (kind: YKind, data: Uint8Array, from: string) => void): void;
  onAw(cb: (data: Uint8Array, from: string) => void): void;
  onJoin(cb: (id: string) => void): void;
  onLeave(cb: (id: string) => void): void;
  leave(): Promise<void>;
}

export interface SessionHooks {
  /** Le fichier est-il affiché dans un éditeur lié au doc ? (l'éditeur s'occupe alors du disque) */
  isBound(path: string): boolean;
  /** Le doc a changé de structure (synchro initiale, reset, fichiers ajoutés/renommés) : relier les éditeurs. */
  onStructure(): void;
  /** Rôles / pairs ont changé. */
  onPeers(): void;
  log(...args: unknown[]): void;
}

export interface SessionOptions {
  name: string;
  color: string;
  git: boolean;
  gitMobile?: boolean;
  /** Temps d'attente d'un hôte avant de devenir soi-même l'hôte. */
  joinTimeoutMs: number;
  writeDelayMs?: number;
  base?: BaseStore;
  baseSaveDelayMs?: number;
  /** Note ouverte : délai laissé à Obsidian pour fusionner lui-même une écriture extérieure. */
  boundDelayMs?: number;
}

export interface Member {
  id: string;
  self: boolean;
  name: string;
  git: boolean;
  mobile: boolean;
  startedAt: number;
}

export class Session {
  doc!: Y.Doc;
  files!: Y.Map<Y.Text>;
  awareness!: aw.Awareness;
  peers = new Map<string, Hello>();
  seeded = false;
  origin: string | null = null;
  originAt = 0;
  readonly startedAt = Date.now();

  private syncingFrom: string | null = null;
  private seeding = false;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWritten = new Map<string, string>();
  /** Dernier contenu connu du disque pour chaque note : base de fusion quand quelqu'un d'autre l'écrit. */
  private lastDisk = new Map<string, string>();
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dirtyDuringConnect = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private baseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Versions récentes de chaque note dans le doc : pour reconnaître les sauvegardes d'Obsidian. */
  private recent = new Map<string, { text: string; at: number }[]>();

  constructor(
    readonly transport: Transport,
    readonly disk: Disk,
    readonly opts: SessionOptions,
    readonly hooks: SessionHooks,
  ) {
    this.newDoc();
    transport.onJoin(id => {
      this.transport.sendHello(this.hello(), id);
      if (this.seeded) this.sendFullAwareness();
    });
    transport.onLeave(id => this.onLeave(id));
    transport.onHello((h, from) => this.onHello(h, from));
    transport.onY((kind, data, from) => this.onY(kind, data, from));
    transport.onAw((data, from) => {
      if (this.sameLineage(from)) aw.applyAwarenessUpdate(this.awareness, data, REMOTE);
    });
  }

  get selfId() {
    return this.transport.selfId;
  }

  start() {
    this.broadcastHello();
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      if (!this.seeded && !this.syncingFrom) void this.seedFromDisk();
    }, this.opts.joinTimeoutMs);
  }

  async stop() {
    if (this.baseTimer) {
      clearTimeout(this.baseTimer);
      await this.saveBase();
    }
    this.stopped = true;
    if (this.joinTimer) clearTimeout(this.joinTimer);
    for (const t of this.writeTimers.values()) clearTimeout(t);
    aw.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    await this.transport.leave();
    this.awareness.destroy();
    this.doc.destroy();
  }

  // ---------------------------------------------------------------- rôles

  /** Membres de la session (même version du doc), triés du plus ancien au plus récent. */
  members(): Member[] {
    const list: Member[] = [];
    if (this.seeded) {
      list.push({ id: this.selfId, self: true, name: this.opts.name, git: this.opts.git, mobile: !!this.opts.gitMobile, startedAt: this.startedAt });
    }
    for (const [id, h] of this.peers) {
      if (h.seeded && this.origin && h.origin === this.origin) {
        list.push({ id, self: false, name: h.name, git: h.git, mobile: !!h.mobile, startedAt: h.startedAt });
      }
    }
    return list.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  }

  host(): Member | undefined {
    return this.members()[0];
  }

  /** Le pair chargé de commit/push : le plus ancien ordinateur avec git, sinon le plus ancien téléphone avec git. */
  gitLeader(): Member | undefined {
    const m = this.members();
    return m.find(x => x.git && !x.mobile) ?? m.find(x => x.git);
  }

  // ---------------------------------------------------------------- doc

  private newDoc() {
    this.doc = new Y.Doc();
    this.files = this.doc.getMap<Y.Text>("files");
    this.awareness = new aw.Awareness(this.doc);
    this.awareness.setLocalStateField("user", {
      name: this.opts.name,
      color: this.opts.color,
      colorLight: this.opts.color + "33",
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && origin !== "sync" && this.origin) this.transport.sendY("u", update);
      this.scheduleBaseSave();
    });
    this.awareness.on("update", ({ added, updated, removed }: AwChange, origin: unknown) => {
      if (origin === REMOTE || !this.seeded) return;
      const changed = added.concat(updated, removed);
      this.transport.sendAw(aw.encodeAwarenessUpdate(this.awareness, changed));
    });
    this.files.observeDeep((events, tr) => this.onDocChange(events, tr));
  }

  private resetDoc() {
    this.awareness.destroy();
    this.doc.destroy();
    this.seeded = false;
    this.origin = null;
    this.originAt = 0;
    this.newDoc();
    this.hooks.onStructure();
  }

  getText(path: string): Y.Text | undefined {
    return this.files.get(path);
  }

  setActiveFile(path: string | null) {
    this.awareness.setLocalStateField("file", path);
  }

  // ---------------------------------------------------------------- réseau

  private hello(): Hello {
    return {
      v: 1,
      startedAt: this.startedAt,
      seeded: this.seeded,
      origin: this.origin,
      originAt: this.originAt,
      git: this.opts.git,
      mobile: !!this.opts.gitMobile,
      name: this.opts.name,
      clientId: this.doc.clientID,
    };
  }

  private broadcastHello() {
    if (!this.stopped) this.transport.sendHello(this.hello());
  }

  private sendFullAwareness() {
    const ids = Array.from(this.awareness.getStates().keys());
    this.transport.sendAw(aw.encodeAwarenessUpdate(this.awareness, ids));
  }

  private sameLineage(from: string) {
    const h = this.peers.get(from);
    return !!h && !!this.origin && h.origin === this.origin;
  }

  // ---------------------------------------------------------------- base partagée

  /** La version actuelle est « partagée » dès qu'un autre membre est là. */
  private scheduleBaseSave() {
    if (!this.opts.base || !this.seeded || this.stopped || this.members().length < 2) return;
    if (this.baseTimer) return;
    this.baseTimer = setTimeout(() => {
      this.baseTimer = null;
      void this.saveBase();
    }, this.opts.baseSaveDelayMs ?? 5000);
  }

  private async saveBase() {
    if (!this.opts.base || !this.seeded) return;
    const texts: Record<string, string> = {};
    for (const [p, t] of this.files.entries()) texts[p] = t.toString();
    await this.opts.base.save(texts).catch(e => this.hooks.log("sauvegarde de la base impossible", e));
  }

  /** Lecture disque normalisée (Windows : CRLF → LF, sinon les positions de l'éditeur divergent). */
  private async readDisk(path: string) {
    const c = await this.disk.read(path);
    return c == null ? null : c.replace(/\r\n?/g, "\n");
  }

  private onHello(h: Hello, from: string) {
    if (h?.v !== 1) return;
    const prev = this.peers.get(from);
    this.peers.set(from, h);
    if (prev && prev.clientId !== h.clientId) {
      aw.removeAwarenessStates(this.awareness, [prev.clientId], REMOTE);
    }

    if (h.seeded && h.origin) {
      if (!this.seeded && !this.syncingFrom && !this.seeding) {
        this.requestSync(from, h);
      } else if (this.seeded && h.origin !== this.origin && this.loses(h)) {
        // Deux sessions se sont formées en parallèle : la plus récente rejoint la plus ancienne.
        this.hooks.log("deux sessions détectées, on rejoint celle de", h.name);
        this.resetDoc();
        this.requestSync(from, h);
      }
    }
    this.scheduleBaseSave();
    this.hooks.onPeers();
  }

  private loses(h: Hello) {
    if (h.originAt !== this.originAt) return h.originAt < this.originAt;
    return (h.origin as string) < (this.origin as string);
  }

  private requestSync(from: string, h: Hello) {
    this.syncingFrom = from;
    this.origin = h.origin;
    this.originAt = h.originAt;
    // On annonce tout de suite notre session : les modifs qu'on enverra pendant la fusion
    // d'arrivée seraient sinon rejetées (et bloqueraient toutes les suivantes côté Yjs).
    this.broadcastHello();
    this.transport.sendY("s1", Y.encodeStateVector(this.doc), from);
    // Si l'hôte ne répond pas, on réessaie avec quelqu'un d'autre (ou on devient hôte).
    setTimeout(() => {
      if (this.syncingFrom === from && !this.seeded && !this.stopped) {
        this.hooks.log("pas de réponse de", h.name);
        this.syncingFrom = null;
        this.origin = null;
        const other = Array.from(this.peers).find(([id, p]) => id !== from && p.seeded && p.origin);
        if (other) this.requestSync(other[0], other[1]);
        else void this.seedFromDisk();
      }
    }, 20000);
  }

  private onY(kind: YKind, data: Uint8Array, from: string) {
    if (this.stopped) return;
    if (kind === "s1") {
      if (this.seeded) this.transport.sendY("s2", Y.encodeStateAsUpdate(this.doc, data), from);
      return;
    }
    if (!this.sameLineage(from)) return;
    if (kind === "s2" && !this.seeded && from === this.syncingFrom) {
      Y.applyUpdate(this.doc, data, "sync");
      this.syncingFrom = null;
      if (this.joinTimer) clearTimeout(this.joinTimer);
      this.enqueue(() => this.materializeAll());
      return;
    }
    Y.applyUpdate(this.doc, data, REMOTE);
  }

  private onLeave(id: string) {
    const h = this.peers.get(id);
    this.peers.delete(id);
    if (h) aw.removeAwarenessStates(this.awareness, [h.clientId], REMOTE);
    if (this.syncingFrom === id && !this.seeded) {
      this.syncingFrom = null;
      this.origin = null;
      const other = Array.from(this.peers).find(([, p]) => p.seeded && p.origin);
      if (other) this.requestSync(other[0], other[1]);
      else void this.seedFromDisk();
    }
    this.hooks.onPeers();
  }

  // ---------------------------------------------------------------- démarrage

  private async seedFromDisk() {
    if (this.seeded || this.seeding || this.stopped) return;
    this.seeding = true;
    try {
      const paths = await this.disk.listText();
      const contents = await Promise.all(paths.map(p => this.readDisk(p)));
      if (this.seeded || this.stopped) return;
      this.doc.transact(() => {
        paths.forEach((p, i) => {
          const c = contents[i];
          if (c != null && !this.files.has(p)) this.files.set(p, new Y.Text(c));
          if (c != null) this.lastDisk.set(p, c);
        });
      }, DISK);
      this.origin = this.selfId;
      this.originAt = this.startedAt;
      this.markSeeded();
      this.hooks.log(`session créée (${paths.length} fichiers), je suis l'hôte`);
    } finally {
      this.seeding = false;
    }
    // Un pair d'une autre session a pu se présenter pendant la lecture du disque.
    for (const [id, h] of this.peers) this.onHello(h, id);
  }

  /**
   * Après la synchro initiale : on réconcilie le disque avec la session.
   * Pour chaque note, on compare 3 versions : D (session), L (disque local) et B (dernière
   * version partagée connue de cet appareil). Ce qui a changé localement depuis B
   * (édition hors ligne, git pull…) est fusionné ; sinon la session fait foi.
   */
  private async materializeAll() {
    const base = (await this.opts.base?.load().catch(() => null)) ?? null;
    const stats = { written: 0, merged: 0, conflicts: 0, added: 0, removed: 0 };
    const paths = new Set([...this.files.keys(), ...(await this.disk.listText())]);
    for (const path of paths) {
      const ytext = this.files.get(path);
      const D = ytext?.toString();
      const L = await this.readDisk(path);
      const B = base?.[path];
      if (L != null) this.lastDisk.set(path, L);
      if (L === D || (L == null && D === undefined)) continue;

      if (D === undefined) {
        // Seulement sur ce disque.
        if (B !== undefined && L === B) {
          await this.disk.remove(path); // supprimée dans la session pendant notre absence
          stats.removed++;
        } else {
          this.doc.transact(() => this.files.set(path, new Y.Text(L!)), DISK); // créée hors ligne
          stats.added++;
        }
        continue;
      }
      if (L == null) {
        if (B !== undefined && D === B) {
          this.doc.transact(() => this.files.delete(path), DISK); // supprimée hors ligne
          stats.removed++;
        } else {
          await this.writeDisk(path, D);
          stats.written++;
        }
        continue;
      }
      if (B === undefined) {
        // Pas d'historique pour cette note : la session fait foi, sauf modif pendant la connexion.
        if (this.dirtyDuringConnect.has(path)) this.doc.transact(() => applyDiff(ytext!, L), DISK);
        else await this.writeDisk(path, D);
        stats.written++;
        continue;
      }
      if (L === B) {
        await this.writeDisk(path, D); // notre copie était juste en retard
        stats.written++;
      } else if (D === B) {
        this.doc.transact(() => applyDiff(ytext!, L), DISK); // seul ce disque a changé
        stats.merged++;
      } else {
        const m = merge3(L, B, D);
        if (m.clean) {
          this.doc.transact(() => applyDiff(ytext!, m.text), DISK);
          await this.writeDisk(path, m.text);
          stats.merged++;
        } else {
          // Mêmes lignes modifiées des deux côtés : la session garde sa version,
          // la nôtre est conservée dans une copie.
          const copy = conflictPath(path, this.opts.name);
          this.doc.transact(() => this.files.set(copy, new Y.Text(L)), DISK);
          await this.writeDisk(copy, L);
          await this.writeDisk(path, D);
          stats.conflicts++;
        }
      }
    }
    this.dirtyDuringConnect.clear();
    this.markSeeded();
    this.lastJoin = stats;
    this.hooks.log("session rejointe", stats);
    void this.saveBase();
  }

  /** Bilan de la dernière arrivée dans une session (pour l'afficher). */
  lastJoin: { written: number; merged: number; conflicts: number; added: number; removed: number } | null = null;

  private async writeDisk(path: string, content: string) {
    this.lastWritten.set(path, content);
    this.lastDisk.set(path, content);
    await this.disk.write(path, content);
  }

  private markSeeded() {
    this.seeded = true;
    this.broadcastHello();
    this.sendFullAwareness();
    this.hooks.onStructure();
    this.hooks.onPeers();
  }

  // ---------------------------------------------------------------- doc -> disque

  private enqueue(fn: () => Promise<unknown>) {
    this.queue = this.queue.then(fn).catch(e => this.hooks.log("erreur disque", e));
    return this.queue;
  }

  private remember(path: string) {
    const t = this.files.get(path);
    if (!t) return;
    const now = Date.now();
    const list = (this.recent.get(path) ?? []).filter(e => now - e.at < 60_000).slice(-80);
    list.push({ text: t.toString(), at: now });
    this.recent.set(path, list);
  }

  /** Ce contenu a-t-il existé dans le doc récemment ? (= écho d'une sauvegarde, pas une écriture extérieure) */
  private wasRecent(path: string, content: string) {
    return this.lastWritten.get(path) === content || !!this.recent.get(path)?.some(e => e.text === content);
  }

  private onDocChange(events: Y.YEvent<any>[], tr: Y.Transaction) {
    // On note chaque état des notes modifiées, quelle que soit l'origine (éditeur, disque, autres).
    const touched = new Set<string>();
    for (const ev of events) {
      if (ev.target === this.files) ev.changes.keys.forEach((c, key) => c.action !== "delete" && touched.add(key));
      else if (typeof ev.path[0] === "string") touched.add(ev.path[0]);
    }
    for (const p of touched) this.remember(p);

    if (tr.origin !== REMOTE || !this.seeded) {
      if (tr.origin === DISK && events.some(e => e.target === this.files)) this.hooks.onStructure();
      return;
    }
    const added: string[] = [];
    const deleted: string[] = [];
    const changed = new Set<string>();
    for (const ev of events) {
      if (ev.target === this.files) {
        ev.changes.keys.forEach((change, key) => {
          if (change.action === "add") added.push(key);
          else if (change.action === "delete") deleted.push(key);
          else changed.add(key);
        });
      } else if (typeof ev.path[0] === "string") {
        changed.add(ev.path[0]);
      }
    }
    if (added.length || deleted.length) {
      this.enqueue(() => this.applyStructure(added, deleted));
    }
    for (const p of changed) if (!added.includes(p)) this.scheduleWrite(p);
  }

  private async applyStructure(added: string[], deleted: string[]) {
    const left = new Set(deleted);
    for (const path of added) {
      const ytext = this.files.get(path);
      if (!ytext) continue;
      const content = ytext.toString();
      // Une suppression + un ajout au même contenu = un renommage.
      let renamedFrom: string | undefined;
      for (const d of left) {
        if ((await this.readDisk(d)) === content) {
          renamedFrom = d;
          break;
        }
      }
      this.lastWritten.set(path, content);
      this.lastDisk.set(path, content);
      if (renamedFrom) {
        left.delete(renamedFrom);
        await this.disk.rename(renamedFrom, path);
      } else {
        await this.disk.write(path, content);
      }
    }
    for (const d of left) {
      if (!this.files.has(d)) await this.disk.remove(d);
    }
    this.hooks.onStructure();
  }

  private scheduleWrite(path: string) {
    if (this.hooks.isBound(path)) return; // l'éditeur Obsidian sauvegarde lui-même
    clearTimeout(this.writeTimers.get(path));
    this.writeTimers.set(
      path,
      setTimeout(() => {
        this.writeTimers.delete(path);
        this.enqueue(async () => {
          const ytext = this.files.get(path);
          if (!ytext || this.hooks.isBound(path)) return;
          const content = ytext.toString();
          this.lastWritten.set(path, content);
          this.lastDisk.set(path, content);
          await this.disk.write(path, content);
        });
      }, this.opts.writeDelayMs ?? 150),
    );
  }

  // ---------------------------------------------------------------- disque -> doc

  /**
   * Un fichier texte a été créé ou modifié sur le disque.
   * Même si la note est ouverte : Obsidian ne recharge pas toujours l'éditeur (mode lecture…),
   * et ignorer l'écriture laisserait une vieille version qu'une sauvegarde réécrirait ensuite.
   * Les sauvegardes d'Obsidian elles-mêmes sont reconnues (contenu déjà vu dans le doc) et ignorées,
   * sinon une sauvegarde en retard effacerait ce que les autres viennent de taper.
   */
  async diskChanged(path: string) {
    if (!isText(path) || this.stopped) return;
    if (!this.seeded) {
      this.dirtyDuringConnect.add(path);
      return;
    }
    // Note ouverte en mode édition : Obsidian fusionne lui-même l'écriture dans l'éditeur (et donc
    // dans le doc). On le laisse passer d'abord : notre fusion verra alors la même modif des deux
    // côtés et ne la doublera pas. En mode lecture, Obsidian ne fait rien : c'est nous qui l'appliquons.
    if (this.hooks.isBound(path)) await new Promise(r => setTimeout(r, this.opts.boundDelayMs ?? 800));
    const content = await this.readDisk(path);
    if (content == null || !this.seeded) return;
    const ytext = this.files.get(path);
    const base = this.lastDisk.get(path);
    this.lastDisk.set(path, content);
    if (ytext && ytext.toString() === content) return;
    if (this.wasRecent(path, content)) return; // sauvegarde d'Obsidian ou écho d'une de nos écritures
    // Écriture extérieure (agent, git, autre programme), faite à partir de l'ancien contenu du disque :
    // on fusionne avec ce qui a été tapé entre-temps au lieu de l'écraser.
    let next = content;
    if (ytext && base !== undefined) {
      const m = merge3(ytext.toString(), base, content);
      if (m.clean) next = m.text;
      else this.hooks.log(`conflit sur ${path} : la version écrite sur le disque l'emporte`);
    }
    this.doc.transact(() => {
      if (ytext) applyDiff(ytext, next);
      else this.files.set(path, new Y.Text(next));
    }, DISK);
  }

  diskDeleted(path: string) {
    if (!this.seeded) return;
    const keys = this.files.has(path) ? [path] : this.keysUnder(path);
    if (!keys.length) return;
    this.doc.transact(() => keys.forEach(k => this.files.delete(k)), DISK);
  }

  diskRenamed(from: string, to: string) {
    if (!this.seeded) return;
    const pairs: [string, string][] = this.files.has(from)
      ? [[from, to]]
      : this.keysUnder(from).map(k => [k, to + k.slice(from.length)]);
    const todo = pairs.filter(([a, b]) => this.files.has(a) && !this.files.has(b));
    if (!todo.length) {
      if (!this.files.has(to) && isText(to)) void this.diskChanged(to);
      return;
    }
    this.doc.transact(() => {
      for (const [a, b] of todo) {
        const content = this.files.get(a)!.toString();
        this.files.delete(a);
        this.lastWritten.set(b, content);
        if (isText(b)) this.files.set(b, new Y.Text(content));
      }
    }, DISK);
  }

  private keysUnder(folder: string) {
    const prefix = folder.endsWith("/") ? folder : folder + "/";
    return Array.from(this.files.keys()).filter(k => k.startsWith(prefix));
  }
}

type AwChange = { added: number[]; updated: number[]; removed: number[] };

/** Fusion à trois par lignes. Les modifications identiques des deux côtés ne sont pas des conflits. */
export function merge3(local: string, base: string, remote: string): { clean: boolean; text: string } {
  const regions = diff3Merge(local, base, remote, { excludeFalseConflicts: true, stringSeparator: /\n/ });
  if (regions.some(r => r.conflict)) return { clean: false, text: remote };
  return { clean: true, text: regions.flatMap(r => r.ok ?? []).join("\n") };
}

function conflictPath(path: string, who: string) {
  const dot = path.lastIndexOf(".");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`;
  const safe = who.replace(/[\\/:*?"<>|#^[\]]/g, "");
  return `${path.slice(0, dot)} (conflit ${safe} ${stamp})${path.slice(dot)}`;
}

/** Remplace le contenu d'un Y.Text par `next` en ne touchant que la partie modifiée. */
export function applyDiff(ytext: Y.Text, next: string) {
  const prev = ytext.toString();
  if (prev === next) return;
  let start = 0;
  const min = Math.min(prev.length, next.length);
  while (start < min && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  if (endPrev > start) ytext.delete(start, endPrev - start);
  if (endNext > start) ytext.insert(start, next.slice(start, endNext));
}
