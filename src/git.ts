// Sauvegarde git du coffre (ex-« Auto Git Sync »). Pendant une session, seul le
// responsable git (le plus ancien membre qui a git) commit et push.
// Modules Node chargés à la demande : ils n'existent pas sur Android/iOS.
const node = <T>(m: string): T => require(m);
const cp = () => node<typeof import("child_process")>("child_process");
const fsm = () => node<typeof import("fs")>("fs");

/** Environnement des commandes en arrière-plan : jamais de question dans un terminal invisible. */
export const QUIET_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

/** L'erreur ressemble-t-elle à un problème de connexion / de droits GitHub ? */
export function isAuthError(msg: string) {
  return /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied|Repository not found|returned error: 40[13]|denied to|Invalid username or password|GCM_INTERACTIVE|cannot prompt/i.test(
    msg,
  );
}

/** Compare deux chemins de dossier (Windows : insensible à la casse et aux / ou \\). */
export function samePath(a: string, b: string) {
  const fs = fsm();
  const norm = (p: string) => {
    let r = p;
    try {
      r = fs.realpathSync.native(p);
    } catch {}
    r = r.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export interface GitSettings {
  commitMessage: string;
  push: boolean;
  pullBeforePush: boolean;
}

export type ChangeKind = "M" | "A" | "D" | "R" | "?";
export interface Change {
  kind: ChangeKind;
  path: string;
  from?: string;
}
export interface Commit {
  hash: string;
  author: string;
  at: number; // ms
  subject: string;
  pushed: boolean;
}
export interface GitInfo {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Différences entre le disque et ce qui est sur le dépôt distant. */
  changes: Change[];
  log: Commit[];
}

export class Git {
  private chain: Promise<void> = Promise.resolve();
  private syncQueued = false;
  private queuedAlwaysPull = false;
  status = "git: ok";
  lastError: { message: string; at: number; auth: boolean } | null = null;
  lastOk: number | null = null;

  constructor(
    readonly cwd: string,
    readonly bin: string,
    readonly settings: () => GitSettings,
    readonly onStatus: (s: string) => void,
    readonly onError: (msg: string, auth: boolean) => void,
  ) {}

  run(args: string[]): Promise<string> {
    return this.runRaw(args).then(s => s.trim());
  }

  /** Sortie brute (sans trim : indispensable pour les formats -z / porcelain). */
  runRaw(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...QUIET_ENV };
      cp().execFile(this.bin, args, { cwd: this.cwd, env, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || stdout || err.message).trim()));
        else resolve(stdout);
      });
    });
  }

  /** Lecture seule, sans prendre de verrou (ne gêne pas un commit en cours). */
  private ro(args: string[]) {
    return this.runRaw(["--no-optional-locks", "-c", "core.quotePath=false", ...args]);
  }

  /** Le coffre est-il la racine d'un dépôt ? (pas juste un sous-dossier d'un autre dépôt) */
  async isRepo() {
    try {
      return samePath(await this.run(["rev-parse", "--show-toplevel"]), this.cwd);
    } catch {
      return false;
    }
  }

  async remoteUrl() {
    return this.run(["remote", "get-url", "origin"]).catch(() => "");
  }

  private set(s: string) {
    this.status = s;
    if (s.startsWith("git: ok")) {
      this.lastOk = Date.now();
      this.lastError = null;
    }
    this.onStatus(s);
  }

  /** Les opérations git passent une par une, dans l'ordre. `quiet` : pas de notification d'erreur. */
  private exclusive(fn: () => Promise<void>, quiet = false): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await fn();
      } catch (e: any) {
        if (quiet) return console.warn("[collab-vault]", e);
        const auth = isAuthError(e.message);
        this.lastError = { message: e.message, at: Date.now(), auth };
        this.set(auth ? "git: connexion GitHub ⚠" : "git: erreur ⚠");
        this.onError(e.message, auth);
        console.error("[collab-vault]", e);
      }
    });
    return this.chain;
  }

  /** Met à jour la vue du dépôt distant (sans toucher aux fichiers). */
  fetch() {
    return this.exclusive(() => this.run(["fetch", "--quiet"]).then(() => {}), true);
  }

  async info(): Promise<GitInfo> {
    const branch = (await this.ro(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const upstream = (await this.ro(["rev-parse", "--abbrev-ref", "@{u}"]).catch(() => "")).trim() || null;
    let ahead = 0;
    let behind = 0;
    const changes: Change[] = [];
    if (upstream) {
      const [a, b] = (await this.ro(["rev-list", "--left-right", "--count", "HEAD...@{u}"])).trim().split(/\s+/);
      ahead = Number(a) || 0;
      behind = Number(b) || 0;
      // disque (fichiers suivis) comparé au dépôt distant
      const parts = (await this.ro(["diff", "-M", "--name-status", "-z", "@{u}", "--"])).split("\0");
      for (let i = 0; i < parts.length - 1; ) {
        const code = parts[i++];
        if (!code) continue;
        if (code[0] === "R" || code[0] === "C") {
          const from = parts[i++];
          changes.push({ kind: "R", from, path: parts[i++] });
        } else {
          changes.push({ kind: (code[0] === "A" || code[0] === "D" ? code[0] : "M") as ChangeKind, path: parts[i++] });
        }
      }
    } else {
      const parts = (await this.ro(["status", "--porcelain", "-z", "--untracked-files=no"])).split("\0");
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.length < 4) continue;
        const code = p.slice(0, 2);
        if (code.includes("R")) {
          changes.push({ kind: "R", path: p.slice(3), from: parts[++i] });
        } else {
          changes.push({ kind: code.includes("D") ? "D" : code.includes("A") ? "A" : "M", path: p.slice(3) });
        }
      }
    }
    for (const p of (await this.ro(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0")) {
      if (p) changes.push({ kind: "?", path: p });
    }

    const refs = upstream ? ["HEAD", "@{u}"] : ["HEAD"];
    const unpushed = new Set(
      upstream ? (await this.ro(["rev-list", "HEAD", "^@{u}"])).split("\n").filter(Boolean) : [],
    );
    const log = (await this.ro(["log", "-n", "30", "--format=%H%x1f%an%x1f%at%x1f%s%x1e", ...refs]).catch(() => ""))
      .split("\x1e")
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [hash, author, at, subject] = l.split("\x1f");
        return { hash, author, at: Number(at) * 1000, subject, pushed: upstream ? !unpushed.has(hash) : false };
      });
    return { branch, upstream, ahead, behind, changes, log };
  }

  /** Fichiers modifiés par un commit. */
  async commitFiles(hash: string): Promise<Change[]> {
    const parts = (await this.ro(["show", "-M", "--name-status", "-z", "--format=", hash])).split("\0");
    const out: Change[] = [];
    for (let i = 0; i < parts.length - 1; ) {
      const code = parts[i++].trim();
      if (!code) continue;
      if (code[0] === "R" || code[0] === "C") {
        const from = parts[i++];
        out.push({ kind: "R", from, path: parts[i++] });
      } else out.push({ kind: (code[0] === "A" || code[0] === "D" ? code[0] : "M") as ChangeKind, path: parts[i++] });
    }
    return out;
  }

  private async pullRebase() {
    try {
      await this.run(["pull", "--rebase", "--autostash"]);
      return;
    } catch (e: any) {
      await this.run(["rebase", "--abort"]).catch(() => {});
      console.warn("[collab-vault] rebase impossible, on tente un merge", e);
    }
    // Conflit : on fusionne en gardant notre version pour les lignes en conflit
    // (notre disque = l'état de la session, le plus récent). Sinon la sauvegarde resterait bloquée.
    try {
      await this.run(["pull", "--no-rebase", "--no-edit", "-X", "ours"]);
      this.onError("conflit avec le dépôt distant : fusion faite en gardant la version de la session.", false);
    } catch (e: any) {
      await this.run(["merge", "--abort"]).catch(() => {});
      throw new Error("pull impossible (conflit) : " + e.message);
    }
  }

  /** Fichiers propres à chaque machine : jamais versionnés, sinon conflits entre amis. */
  async ensureIgnored(paths: string[]) {
    const fs = fsm();
    const file = this.cwd + "/.gitignore";
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = new Set(current.split(/\r?\n/).map(l => l.trim()));
    const missing = paths.filter(p => !lines.has(p));
    if (missing.length) {
      const sep = current && !current.endsWith("\n") ? "\n" : "";
      fs.writeFileSync(file, current + sep + "# Collab Vault : réglages propres à chaque machine\n" + missing.join("\n") + "\n");
    }
    for (const p of paths) {
      const tracked = await this.run(["ls-files", "--", p]).catch(() => "");
      if (tracked) await this.run(["rm", "--cached", "-q", "--", p]).catch(() => {});
    }
  }

  pull() {
    return this.exclusive(async () => {
      this.set("git: pull…");
      await this.pullRebase();
      this.set("git: ok " + time());
    });
  }

  /** Commit des changements, puis pull + push. `alwaysPull` : récupère aussi s'il n'y a rien à pousser. */
  sync(alwaysPull = false) {
    this.queuedAlwaysPull ||= alwaysPull;
    if (this.syncQueued) return this.chain; // une synchro est déjà prévue, elle prendra tout
    this.syncQueued = true;
    return this.exclusive(async () => {
      this.syncQueued = false;
      alwaysPull = this.queuedAlwaysPull;
      this.queuedAlwaysPull = false;
      const s = this.settings();
      await this.run(["add", "-A"]);
      const status = await this.run(["status", "--porcelain"]);
      if (status) {
        const count = status.split("\n").length;
        const msg = s.commitMessage.replace("{{date}}", date()).replace("{{count}}", String(count));
        this.set("git: commit…");
        await this.run(["commit", "-m", msg]);
      }
      if (!s.push) {
        this.set("git: ok " + time());
        return;
      }
      const ahead = await this.run(["rev-list", "--count", "@{u}..HEAD"]).catch(() => "1");
      if (ahead !== "0" || alwaysPull) {
        if (s.pullBeforePush || alwaysPull) {
          this.set("git: pull…");
          await this.pullRebase();
        }
        const aheadNow = await this.run(["rev-list", "--count", "@{u}..HEAD"]).catch(() => "1");
        if (aheadNow !== "0") {
          this.set("git: push…");
          await this.run(["push"]);
        }
      }
      this.set("git: ok " + time());
    });
  }

  /**
   * On devient responsable git après avoir été simple invité : le disque reflète déjà
   * la session (plus récent que tout), on aligne juste l'historique sur le distant sans
   * toucher aux fichiers, puis on commit la différence.
   */
  adopt() {
    return this.exclusive(async () => {
      this.set("git: reprise…");
      await this.run(["fetch"]);
      await this.run(["reset", "--mixed", "@{u}"]);
      this.set("git: ok");
    }).then(() => this.sync());
    // (si fetch/reset échoue, l'erreur est notifiée et sync() refait un pull --rebase classique)
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const time = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const date = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time(d)}`;
