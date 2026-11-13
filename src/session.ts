// Cœur de la collaboration : un Y.Doc par coffre, synchronisé en pair-à-pair.
// Indépendant d'Obsidian (disque et réseau sont injectés) pour pouvoir être testé seul.
import * as Y from "yjs";
import * as aw from "y-protocols/awareness";

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

export interface Hello {
  v: 1;
  startedAt: number;
  seeded: boolean;
  /** Pair qui a créé la version du document qu'on partage (null = pas encore synchronisé). */
  origin: string | null;
  originAt: number;
  git: boolean;
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
  /** Temps d'attente d'un hôte avant de devenir soi-même l'hôte. */
  joinTimeoutMs: number;
  writeDelayMs?: number;
}

export interface Member {
  id: string;
  self: boolean;
  name: string;
  git: boolean;
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
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dirtyDuringConnect = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

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
      list.push({ id: this.selfId, self: true, name: this.opts.name, git: this.opts.git, startedAt: this.startedAt });
    }
    for (const [id, h] of this.peers) {
      if (h.seeded && this.origin && h.origin === this.origin) {
        list.push({ id, self: false, name: h.name, git: h.git, startedAt: h.startedAt });
      }
    }
    return list.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  }

  host(): Member | undefined {
    return this.members()[0];
  }

  /** Le pair chargé de commit/push : le plus ancien membre qui a git. */
  gitLeader(): Member | undefined {
    return this.members().find(m => m.git);
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
      const contents = await Promise.all(paths.map(p => this.disk.read(p)));
      if (this.seeded || this.stopped) return;
      this.doc.transact(() => {
        paths.forEach((p, i) => {
          const c = contents[i];
          if (c != null && !this.files.has(p)) this.files.set(p, new Y.Text(c));
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

  /** Après la synchro initiale : le doc de la session fait foi, on met le disque à jour. */
  private async materializeAll() {
    let written = 0;
    for (const [path, ytext] of Array.from(this.files.entries())) {
      const content = ytext.toString();
      const onDisk = await this.disk.read(path);
      if (onDisk === content) continue;
      if (onDisk != null && this.dirtyDuringConnect.has(path)) {
        // Modifié localement pendant la connexion : on garde la modif et on la partage.
        this.doc.transact(() => applyDiff(ytext, onDisk), DISK);
        continue;
      }
      this.lastWritten.set(path, content);
      await this.disk.write(path, content);
      written++;
    }
    this.dirtyDuringConnect.clear();
    this.markSeeded();
    this.hooks.log(`session rejointe, ${written} fichier(s) mis à jour`);
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

  private onDocChange(events: Y.YEvent<any>[], tr: Y.Transaction) {
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
        if ((await this.disk.read(d)) === content) {
          renamedFrom = d;
          break;
        }
      }
      this.lastWritten.set(path, content);
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
          await this.disk.write(path, content);
        });
      }, this.opts.writeDelayMs ?? 150),
    );
  }

  // ---------------------------------------------------------------- disque -> doc

  /** Un fichier texte a été créé ou modifié sur le disque (hors éditeur lié). */
  async diskChanged(path: string) {
    if (!isText(path) || this.stopped) return;
    if (!this.seeded) {
      this.dirtyDuringConnect.add(path);
      return;
    }
    if (this.hooks.isBound(path)) return;
    const content = await this.disk.read(path);
    if (content == null || !this.seeded) return;
    const ytext = this.files.get(path);
    if (ytext && ytext.toString() === content) return;
    if (this.lastWritten.get(path) === content) return; // écho d'une de nos propres écritures
    this.doc.transact(() => {
      if (ytext) applyDiff(ytext, content);
      else this.files.set(path, new Y.Text(content));
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
