// Git sans le programme `git` (Android / iOS) : isomorphic-git, authentification par jeton.
// Le système de fichiers et le réseau sont injectés (Obsidian sur téléphone, Node dans les tests).
import { Buffer } from "buffer";
import git, { TREE, Errors, type HttpClient } from "isomorphic-git";
import { GitBase, GitSettings, GitInfo, Change, Commit } from "./git";
import { merge3 } from "./session";

// isomorphic-git utilise Buffer, absent des WebView Android.
(globalThis as any).Buffer ??= Buffer;

export interface MobileGitOptions {
  fs: any; // client « fs » au format isomorphic-git (avec .promises)
  http: HttpClient;
  dir: string;
  token: () => string;
  author: () => { name: string; email: string };
}

export class MobileGit extends GitBase {
  readonly mobile = true;
  readonly label = "git intégré (sans programme git)";
  private cache = {};

  constructor(
    readonly o: MobileGitOptions,
    settings: () => GitSettings,
    onStatus: (s: string) => void,
    onError: (msg: string, auth: boolean) => void,
  ) {
    super(settings, onStatus, onError);
  }

  private get base() {
    const tokenAuth = () => {
      const t = this.o.token();
      return t ? { username: "x-access-token", password: t } : { cancel: true };
    };
    return {
      fs: this.o.fs,
      http: this.o.http,
      dir: this.o.dir,
      cache: this.cache,
      onAuth: tokenAuth,
      onAuthFailure: () => ({ cancel: true }),
    };
  }

  /** Erreurs d'isomorphic-git → message clair (et reconnu comme problème de connexion). */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      const status = e?.data?.statusCode;
      if (e?.code === "UserCanceledError" || (e?.code === "HttpError" && [401, 403, 404].includes(status))) {
        throw new Error("Authentication failed : jeton GitHub refusé, expiré, ou sans accès à ce dépôt.");
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ connexion au dépôt

  /** Teste l'accès au dépôt avec le jeton (sans rien écrire). */
  static async checkAccess(http: HttpClient, url: string, token: string): Promise<{ ok: boolean; message: string }> {
    try {
      await git.getRemoteInfo({
        http,
        url,
        onAuth: () => ({ username: "x-access-token", password: token }),
        onAuthFailure: () => ({ cancel: true }),
      });
      return { ok: true, message: "Accès au dépôt OK" };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/401|403|404|auth|cancel/i.test(msg) || e?.code === "HttpError" || e?.code === "UserCanceledError") {
        return { ok: false, message: "GitHub refuse l'accès : vérifie le jeton (droit « Contents : lecture et écriture » sur ce dépôt)." };
      }
      return { ok: false, message: msg };
    }
  }

  /**
   * Branche le coffre sur le dépôt SANS écraser les notes déjà présentes : l'historique
   * devient celui du dépôt, les fichiers locaux restent, ceux qui manquent sont récupérés.
   * Sur un coffre vide, c'est un clone.
   */
  async connect(url: string, onProgress?: (s: string) => void): Promise<void> {
    return this.guard(() => this.connectInner(url, onProgress));
  }

  private async connectInner(url: string, onProgress?: (s: string) => void): Promise<void> {
    const b = this.base;
    if (!(await this.isRepo())) {
      await git.init({ fs: b.fs, dir: b.dir, defaultBranch: "main" });
      await git.addRemote({ fs: b.fs, dir: b.dir, remote: "origin", url });
    } else {
      await git.setConfig({ fs: b.fs, dir: b.dir, path: "remote.origin.url", value: url });
    }
    onProgress?.("Téléchargement de l'historique…");
    const res = await git.fetch({
      ...b,
      remote: "origin",
      singleBranch: true,
      onProgress: p => onProgress?.(`Téléchargement… ${p.phase} ${p.total ? Math.round((p.loaded / p.total) * 100) + " %" : ""}`),
    });
    const branch = (res.defaultBranch ?? "refs/heads/main").replace("refs/heads/", "");
    const remoteRef = `refs/remotes/origin/${branch}`;
    const oid = res.fetchHead ?? (await git.resolveRef({ fs: b.fs, dir: b.dir, ref: remoteRef }));
    await git.writeRef({ fs: b.fs, dir: b.dir, ref: `refs/heads/${branch}`, value: oid, force: true });
    await git.writeRef({ fs: b.fs, dir: b.dir, ref: "HEAD", value: `refs/heads/${branch}`, symbolic: true, force: true });
    await git.setConfig({ fs: b.fs, dir: b.dir, path: `branch.${branch}.remote`, value: "origin" });
    await git.setConfig({ fs: b.fs, dir: b.dir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
    onProgress?.("Préparation des fichiers…");
    await this.mixedReset(oid);
    // Fichiers du dépôt absents du coffre : on les récupère.
    const missing: string[] = [];
    for (const f of await git.listFiles({ fs: b.fs, dir: b.dir, ref: oid })) {
      if (!(await exists(b.fs, `${b.dir}/${f}`))) missing.push(f);
    }
    if (missing.length) {
      onProgress?.(`Récupération de ${missing.length} fichier(s)…`);
      await git.checkout({ ...b, ref: branch, filepaths: missing, noUpdateHead: true, force: true });
    }
  }

  /** Équivalent de `git reset --mixed <oid>` : index = arbre du commit, fichiers du coffre intacts. */
  private async mixedReset(oid: string) {
    const b = this.base;
    const inTree = new Set(await git.listFiles({ fs: b.fs, dir: b.dir, ref: oid }));
    const inIndex = await git.listFiles({ fs: b.fs, dir: b.dir }).catch(() => [] as string[]);
    for (const f of new Set([...inTree, ...inIndex])) {
      await git.resetIndex({ fs: b.fs, dir: b.dir, filepath: f, ref: oid, cache: this.cache });
    }
  }

  // ------------------------------------------------------------------ GitBase

  async isRepo() {
    return exists(this.o.fs, `${this.o.dir}/.git/HEAD`);
  }

  async remoteUrl() {
    return (await git.getConfig({ fs: this.o.fs, dir: this.o.dir, path: "remote.origin.url" }).catch(() => "")) ?? "";
  }

  private async branch() {
    return (await git.currentBranch({ fs: this.o.fs, dir: this.o.dir })) ?? "main";
  }

  async ensureIgnored(paths: string[]) {
    const { fs, dir } = this.o;
    const file = `${dir}/.gitignore`;
    const current: string = (await exists(fs, file)) ? await fs.promises.readFile(file, "utf8") : "";
    const lines = new Set(current.split(/\r?\n/).map(l => l.trim()));
    const missing = paths.filter(p => !lines.has(p));
    if (missing.length) {
      const sep = current && !current.endsWith("\n") ? "\n" : "";
      await fs.promises.writeFile(file, current + sep + "# Collab Vault : réglages propres à chaque machine\n" + missing.join("\n") + "\n", "utf8");
    }
    const tracked = await git.listFiles({ fs, dir }).catch(() => [] as string[]);
    const globs = paths.map(p => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$"));
    for (const f of tracked) if (globs.some(g => g.test(f))) await git.remove({ fs, dir, filepath: f, cache: this.cache });
  }

  /** Ajoute au commit tout ce qui a changé (équivalent de `git add -A`). */
  private async stageAll(): Promise<number> {
    const b = this.base;
    const matrix = await git.statusMatrix({ fs: b.fs, dir: b.dir, cache: this.cache, filter: f => !f.startsWith(".git/") });
    let n = 0;
    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) continue;
      if (workdir === 0) {
        if (head !== 0 || stage !== 0) await git.remove({ fs: b.fs, dir: b.dir, filepath, cache: this.cache });
      } else if (workdir !== stage) {
        await git.add({ fs: b.fs, dir: b.dir, filepath, cache: this.cache });
      }
      if (!(head === 0 && workdir === 0)) n++;
    }
    return n;
  }

  /**
   * Commits atteignables depuis `oid` (chacun une seule fois). `git.log` d'isomorphic-git
   * repasse par les mêmes commits à chaque fusion : inutilisable sur un historique réel.
   */
  private async ancestors(oid: string, limit = 3000, stopAt?: Set<string>) {
    const { fs, dir } = this.o;
    const seen = new Map<string, Awaited<ReturnType<typeof git.readCommit>>>();
    const queue = [oid];
    while (queue.length && seen.size < limit) {
      const o = queue.shift()!;
      if (seen.has(o) || stopAt?.has(o)) continue;
      const c = await git.readCommit({ fs, dir, oid: o, cache: this.cache }).catch(() => null);
      if (!c) continue;
      seen.set(o, c);
      queue.push(...c.commit.parent);
    }
    return seen;
  }

  private async aheadBehind(branch: string): Promise<{ ahead: number; behind: number; remoteOid: string | null }> {
    const { fs, dir } = this.o;
    const local = await git.resolveRef({ fs, dir, ref: `refs/heads/${branch}` }).catch(() => null);
    const remote = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => null);
    if (!local || !remote) return { ahead: local ? 1 : 0, behind: 0, remoteOid: remote };
    if (local === remote) return { ahead: 0, behind: 0, remoteOid: remote };
    const l = await this.ancestors(local);
    const r = await this.ancestors(remote);
    let ahead = 0;
    let behind = 0;
    for (const o of l.keys()) if (!r.has(o)) ahead++;
    for (const o of r.keys()) if (!l.has(o)) behind++;
    return { ahead, behind, remoteOid: remote };
  }

  /** Récupère le distant et fusionne. En cas de conflit sur une ligne, notre version (la session) gagne. */
  private async fetchAndMerge(branch: string) {
    const b = this.base;
    this.set("git: pull…");
    await git.fetch({ ...b, remote: "origin", ref: branch, singleBranch: true });
    const { behind } = await this.aheadBehind(branch);
    if (!behind) return;
    const author = this.o.author();
    let conflicts = 0;
    await git.merge({
      fs: b.fs,
      dir: b.dir,
      cache: this.cache,
      ours: branch,
      theirs: `remotes/origin/${branch}`,
      author,
      message: `Fusion de origin/${branch}`,
      mergeDriver: ({ contents: [base, ours, theirs] }) => {
        const m = merge3(ours, base, theirs);
        if (!m.clean) conflicts++;
        return { cleanMerge: true, mergedText: m.clean ? m.text : ours };
      },
    });
    await git.checkout({ ...b, ref: branch });
    if (conflicts) this.onError(`conflit avec le dépôt distant (${conflicts} fichier(s)) : fusion faite en gardant la version de la session.`, false);
  }

  protected doSync(alwaysPull: boolean) {
    return this.guard(() => this.doSyncInner(alwaysPull));
  }

  private async doSyncInner(alwaysPull: boolean) {
    const b = this.base;
    const s = this.settings();
    const branch = await this.branch();
    const n = await this.stageAll();
    if (n) {
      this.set("git: commit…");
      await git.commit({ fs: b.fs, dir: b.dir, cache: this.cache, message: this.commitMessage(n), author: this.o.author() });
    }
    if (!s.push) return;
    const { ahead } = await this.aheadBehind(branch);
    if (ahead || alwaysPull) {
      if (s.pullBeforePush || alwaysPull) await this.fetchAndMerge(branch);
      if ((await this.aheadBehind(branch)).ahead) {
        this.set("git: push…");
        const r = await git.push({ ...b, remote: "origin", ref: branch });
        if (!r.ok) throw new Error("push refusé : " + (r.error ?? JSON.stringify(r.refs)));
      }
    }
  }

  protected doPull() {
    return this.guard(() => this.doPullInner());
  }

  private async doPullInner() {
    const branch = await this.branch();
    if (await this.stageAll()) {
      await git.commit({ ...this.base, message: this.commitMessage(1), author: this.o.author() });
    }
    await this.fetchAndMerge(branch);
  }

  protected doAdopt() {
    return this.guard(() => this.doAdoptInner());
  }

  private async doAdoptInner() {
    const b = this.base;
    const branch = await this.branch();
    await git.fetch({ ...b, remote: "origin", ref: branch, singleBranch: true });
    const oid = await git.resolveRef({ fs: b.fs, dir: b.dir, ref: `refs/remotes/origin/${branch}` });
    await git.writeRef({ fs: b.fs, dir: b.dir, ref: `refs/heads/${branch}`, value: oid, force: true });
    await this.mixedReset(oid);
  }

  protected doFetch() {
    return this.guard(() => this.doFetchInner());
  }

  private async doFetchInner() {
    await git.fetch({ ...this.base, remote: "origin", ref: await this.branch(), singleBranch: true });
  }

  async info(): Promise<GitInfo> {
    const { fs, dir } = this.o;
    const branch = await this.branch();
    const { ahead, behind, remoteOid } = await this.aheadBehind(branch);
    const changes: Change[] = [];
    const matrix = await git.statusMatrix({ fs, dir, cache: this.cache, filter: f => !f.startsWith(".git/") });
    for (const [path, head, workdir] of matrix) {
      if (head === 1 && workdir === 1) continue;
      changes.push({ kind: workdir === 0 ? "D" : head === 0 ? "?" : "M", path });
    }
    const head = await git.resolveRef({ fs, dir, ref: `refs/heads/${branch}` }).catch(() => null);
    const remoteSet = remoteOid ? new Set((await this.ancestors(remoteOid)).keys()) : new Set<string>();
    const recent = head ? [...(await this.ancestors(head, 300)).values()] : [];
    const log: Commit[] = recent
      .sort((a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp)
      .slice(0, 30)
      .map(c => ({
        hash: c.oid,
        author: c.commit.author.name,
        at: c.commit.author.timestamp * 1000,
        subject: c.commit.message.split("\n")[0],
        pushed: remoteSet.has(c.oid),
      }));
    return { branch, upstream: remoteOid ? `origin/${branch}` : null, ahead, behind, changes, log };
  }

  async commitFiles(hash: string): Promise<Change[]> {
    const { fs, dir } = this.o;
    const c = await git.readCommit({ fs, dir, oid: hash, cache: this.cache });
    const parent = c.commit.parent[0];
    const trees = parent ? [TREE({ ref: parent }), TREE({ ref: hash })] : [TREE({ ref: hash })];
    const out: Change[] = [];
    await git.walk({
      fs,
      dir,
      cache: this.cache,
      trees,
      map: async (filepath, entries) => {
        if (filepath === ".") return true;
        const [a, b] = parent ? entries : [null, entries[0]];
        const ta = a ? await a.type() : null;
        const tb = b ? await b.type() : null;
        if (ta === "tree" || tb === "tree") return true;
        const oa = a ? await a.oid() : null;
        const ob = b ? await b.oid() : null;
        if (oa === ob) return null;
        out.push({ kind: !oa ? "A" : !ob ? "D" : "M", path: filepath });
        return null;
      },
    });
    return out;
  }
}

async function exists(fs: any, path: string) {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

export { Errors };
