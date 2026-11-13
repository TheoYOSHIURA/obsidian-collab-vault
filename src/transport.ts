// Réseau pair-à-pair : WebRTC via Trystero. La mise en relation passe par des relais
// Nostr publics (chiffrée avec le secret du coffre), ensuite tout va directement de pair à pair.
import { joinRoom } from "trystero";
import type { Hello, Transport, YKind } from "./session";

const APP_ID = "obsidian-collab-vault/v1";

export type FileOp =
  | { op: "put"; path: string }
  | { op: "del"; path: string }
  | { op: "mv"; path: string; to: string }
  /** L'hôte annonce ses fichiers non texte à un nouveau venu : [chemin, taille][] */
  | { op: "manifest"; files: [string, number][] }
  /** Le nouveau venu demande ceux qui lui manquent. */
  | { op: "get"; paths: string[] };

export class TrysteroTransport implements Transport {
  private room: ReturnType<typeof joinRoom>;
  private hello;
  private y;
  private aw;
  private file;
  private rekey;

  private constructor(roomId: string, secret: string, readonly selfId: string, room: ReturnType<typeof joinRoom>) {
    this.room = room;
    this.hello = room.makeAction<any>("hello");
    this.y = room.makeAction<Uint8Array>("y");
    this.aw = room.makeAction<Uint8Array>("aw");
    this.file = room.makeAction<Uint8Array>("file");
    this.rekey = room.makeAction<any>("rekey");
  }

  static async connect(roomId: string, secret: string) {
    const room = joinRoom({ appId: APP_ID, password: secret, identity: "none" }, roomId);
    const self = await room.getSelf();
    return new TrysteroTransport(roomId, secret, self.peerId, room);
  }

  private opts(to?: string, metadata?: any) {
    const o: any = {};
    if (to) o.target = to;
    if (metadata !== undefined) o.metadata = metadata;
    return o;
  }

  private fire(p: Promise<unknown>) {
    p.catch(e => console.warn("[collab-vault] envoi échoué", e));
  }

  sendHello(h: Hello, to?: string) {
    this.fire(this.hello.send(h, this.opts(to)));
  }
  sendY(kind: YKind, data: Uint8Array, to?: string) {
    this.fire(this.y.send(data, this.opts(to, kind)));
  }
  sendAw(data: Uint8Array) {
    this.fire(this.aw.send(data));
  }
  sendFile(op: FileOp, data?: Uint8Array, to?: string) {
    return this.file.send(data ?? new Uint8Array(0), this.opts(to, op)).catch(e => console.warn("[collab-vault] envoi échoué", e));
  }

  /** Envoie la nouvelle clé du coffre à UN pair (jamais en diffusion : on exclut la personne retirée). */
  sendRekey(cfg: { room: string; secret: string }, to: string) {
    return this.rekey.send(cfg, { target: to }).catch(e => console.warn("[collab-vault] envoi clé échoué", e));
  }
  onRekey(cb: (cfg: { room: string; secret: string }, from: string) => void) {
    this.rekey.onMessage((d, ctx) => cb(d as any, ctx.peerId));
  }

  onHello(cb: (h: Hello, from: string) => void) {
    this.hello.onMessage((d, ctx) => cb(d as Hello, ctx.peerId));
  }
  onY(cb: (kind: YKind, data: Uint8Array, from: string) => void) {
    this.y.onMessage((d, ctx) => cb(ctx.metadata as YKind, toBytes(d), ctx.peerId));
  }
  onAw(cb: (data: Uint8Array, from: string) => void) {
    this.aw.onMessage((d, ctx) => cb(toBytes(d), ctx.peerId));
  }
  onFile(cb: (op: FileOp, data: Uint8Array, from: string) => void) {
    this.file.onMessage((d, ctx) => cb(ctx.metadata as FileOp, toBytes(d), ctx.peerId));
  }
  onJoin(cb: (id: string) => void) {
    this.room.onPeerJoin(({ peerId }) => cb(peerId));
  }
  onLeave(cb: (id: string) => void) {
    this.room.onPeerLeave(({ peerId }) => cb(peerId));
  }
  onError(cb: (e: unknown) => void) {
    this.room.onError(cb);
  }
  async leave() {
    await this.room.leave();
  }
}

function toBytes(d: unknown): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  throw new Error("donnée binaire attendue");
}
