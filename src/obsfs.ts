// Ponts entre isomorphic-git et Obsidian (fonctionnent sur Android / iOS).
import { App, normalizePath, requestUrl, TFile } from "obsidian";
import type { HttpClient } from "isomorphic-git";

const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });

/**
 * Système de fichiers au format attendu par isomorphic-git, avec dir = "/" = racine du coffre.
 * Les notes passent par l'API du coffre (Obsidian voit les changements, la session aussi) ;
 * `.git` et les fichiers cachés passent par l'adaptateur bas niveau.
 */
export function obsidianFs(app: App) {
  const a = app.vault.adapter;
  const vault = app.vault;
  const rel = (p: string) => normalizePath(p.replace(/^\/+/, "") || "/");
  const hidden = (r: string) => r.split("/").some(seg => seg.startsWith("."));
  const isRoot = (r: string) => r === "/" || r === "";

  async function ensureParent(r: string) {
    const parent = r.split("/").slice(0, -1).join("/");
    if (parent && !(await a.exists(parent))) await a.mkdir(parent);
  }

  async function write(p: string, data: string | Uint8Array) {
    const r = rel(p);
    const f = hidden(r) ? null : vault.getAbstractFileByPath(r);
    if (typeof data === "string") {
      if (f instanceof TFile) return vault.modify(f, data);
      await ensureParent(r);
      return hidden(r) ? a.write(r, data) : void (await vault.create(r, data));
    }
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (f instanceof TFile) return vault.modifyBinary(f, buf);
    await ensureParent(r);
    return hidden(r) ? a.writeBinary(r, buf) : void (await vault.createBinary(r, buf));
  }

  const promises = {
    async readFile(p: string, opts?: string | { encoding?: string }) {
      const r = rel(p);
      if (isRoot(r) || !(await a.exists(r))) throw err("ENOENT", p);
      const enc = typeof opts === "string" ? opts : opts?.encoding;
      if (enc === "utf8" || enc === "utf-8") return a.read(r);
      return new Uint8Array(await a.readBinary(r));
    },
    async writeFile(p: string, data: string | Uint8Array) {
      await write(p, data);
    },
    async unlink(p: string) {
      const r = rel(p);
      if (!(await a.exists(r))) throw err("ENOENT", p);
      const f = hidden(r) ? null : vault.getAbstractFileByPath(r);
      if (f instanceof TFile) await vault.delete(f);
      else await a.remove(r);
    },
    async readdir(p: string) {
      const r = rel(p);
      const st = isRoot(r) ? { type: "folder" } : await a.stat(r);
      if (!st) throw err("ENOENT", p);
      if (st.type !== "folder") throw err("ENOTDIR", p);
      const l = await a.list(isRoot(r) ? "/" : r);
      return [...l.files, ...l.folders].map(x => x.split("/").pop()!).filter(Boolean);
    },
    async mkdir(p: string) {
      const r = rel(p);
      if (isRoot(r) || (await a.exists(r))) throw err("EEXIST", p);
      await a.mkdir(r);
    },
    async rmdir(p: string) {
      const r = rel(p);
      if (!(await a.exists(r))) throw err("ENOENT", p);
      await a.rmdir(r, false);
    },
    async stat(p: string) {
      const r = rel(p);
      if (isRoot(r)) return mkStat("folder", 0, 0, 0);
      const st = await a.stat(r);
      if (!st) throw err("ENOENT", p);
      return mkStat(st.type, st.size, st.mtime, st.ctime);
    },
    async lstat(p: string) {
      return promises.stat(p);
    },
    async readlink(p: string): Promise<string> {
      throw err("ENOENT", p);
    },
    async symlink(_t: string, p: string) {
      throw err("EPERM", p);
    },
    async chmod() {},
  };
  return { promises };
}

function mkStat(type: string, size: number, mtime: number, ctime: number) {
  const file = type === "file";
  return {
    type: file ? "file" : "dir",
    mode: file ? 0o100644 : 0o40000,
    size: size ?? 0,
    ino: 0,
    uid: 0,
    gid: 0,
    dev: 0,
    mtimeMs: mtime ?? 0,
    ctimeMs: ctime || mtime || 0,
    isFile: () => file,
    isDirectory: () => !file,
    isSymbolicLink: () => false,
  };
}

/** Client HTTP isomorphic-git basé sur requestUrl (pas de blocage CORS sur téléphone). */
export const obsidianHttp: HttpClient = {
  async request({ url, method = "GET", headers = {}, body }) {
    let data: ArrayBuffer | undefined;
    if (body) {
      const chunks: Uint8Array[] = [];
      for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      data = all.buffer;
    }
    const h = { ...headers } as Record<string, string>;
    const contentType = h["content-type"];
    delete h["content-type"];
    const r = await requestUrl({ url, method, headers: h, body: data, contentType, throw: false });
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) outHeaders[k.toLowerCase()] = String(v);
    return {
      url,
      method,
      statusCode: r.status,
      statusMessage: String(r.status),
      headers: outHeaders,
      body: (async function* () {
        yield new Uint8Array(r.arrayBuffer);
      })(),
    };
  },
};
