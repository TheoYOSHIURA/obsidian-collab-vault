// Réseau et disque simulés, partagés par les tests.
import { Session, Transport, Hello, YKind, Disk, isText, BaseStore } from "../src/session";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let failures = 0;
export function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✔" : "✘"} ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", detail);
  }
}
export const failed = () => failures;

// --------------------------------------------------------------- réseau simulé
export class Hub {
  nodes = new Map<string, FakeTransport>();
  latency = 5;
  deliver(from: string, to: string | undefined, fn: (t: FakeTransport) => void) {
    for (const [id, t] of this.nodes) {
      if (id === from || (to && id !== to) || !t.connected.has(from)) continue;
      setTimeout(() => this.nodes.get(id) === t && fn(t), this.latency);
    }
  }
  connect(t: FakeTransport) {
    for (const [id, o] of this.nodes) {
      o.connected.add(t.selfId);
      t.connected.add(id);
      setTimeout(() => {
        o.joinCb(t.selfId);
        t.joinCb(id);
      }, this.latency);
    }
    this.nodes.set(t.selfId, t);
  }
  disconnect(t: FakeTransport) {
    this.nodes.delete(t.selfId);
    for (const o of this.nodes.values()) {
      o.connected.delete(t.selfId);
      o.leaveCb(t.selfId);
    }
  }
}

export class FakeTransport implements Transport {
  connected = new Set<string>();
  joinCb: (id: string) => void = () => {};
  leaveCb: (id: string) => void = () => {};
  helloCb: (h: Hello, from: string) => void = () => {};
  yCb: (k: YKind, d: Uint8Array, from: string) => void = () => {};
  awCb: (d: Uint8Array, from: string) => void = () => {};
  constructor(readonly hub: Hub, readonly selfId: string) {}
  sendHello(h: Hello, to?: string) {
    const copy = JSON.parse(JSON.stringify(h));
    this.hub.deliver(this.selfId, to, t => t.helloCb(copy, this.selfId));
  }
  sendY(kind: YKind, data: Uint8Array, to?: string) {
    const copy = data.slice();
    this.hub.deliver(this.selfId, to, t => t.yCb(kind, copy, this.selfId));
  }
  sendAw(data: Uint8Array) {
    const copy = data.slice();
    this.hub.deliver(this.selfId, undefined, t => t.awCb(copy, this.selfId));
  }
  onHello(cb: any) { this.helloCb = cb; }
  onY(cb: any) { this.yCb = cb; }
  onAw(cb: any) { this.awCb = cb; }
  onJoin(cb: any) { this.joinCb = cb; }
  onLeave(cb: any) { this.leaveCb = cb; }
  async leave() { this.hub.disconnect(this); }
}

// --------------------------------------------------------------- disque simulé
export class MemDisk implements Disk {
  files = new Map<string, string>();
  session?: Session;
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async listText() { return Array.from(this.files.keys()).filter(isText); }
  async read(p: string) { return this.files.get(p) ?? null; }
  // Comme Obsidian : chaque écriture déclenche un évènement du coffre.
  async write(p: string, c: string) {
    this.files.set(p, c);
    setTimeout(() => this.session?.diskChanged(p), 1);
  }
  async remove(p: string) {
    this.files.delete(p);
    setTimeout(() => this.session?.diskDeleted(p), 1);
  }
  async rename(a: string, b: string) {
    const c = this.files.get(a);
    if (c == null) return;
    this.files.delete(a);
    this.files.set(b, c);
    setTimeout(() => this.session?.diskRenamed(a, b), 1);
  }
  // Modification « utilisateur » hors éditeur.
  edit(p: string, c: string) {
    this.files.set(p, c);
    void this.session?.diskChanged(p);
  }
}


export class MemBase implements BaseStore {
  data: Record<string, string> | null = null;
  async load() { return this.data ? { ...this.data } : null; }
  async save(t: Record<string, string>) { this.data = { ...t }; }
}

export function makePeer(hub: Hub, id: string, disk: MemDisk, opts: { git?: boolean; base?: MemBase; timeout?: number } = {}) {
  const t = new FakeTransport(hub, id);
  const s = new Session(t, disk, {
    name: id, color: "#ff0000", git: opts.git ?? true, joinTimeoutMs: opts.timeout ?? 100,
    base: opts.base, baseSaveDelayMs: 20,
  }, { isBound: () => false, onStructure: () => {}, onPeers: () => {}, log: () => {} });
  disk.session = s;
  hub.connect(t);
  s.start();
  return s;
}
