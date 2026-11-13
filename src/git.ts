// Sauvegarde git du coffre (ex-« Auto Git Sync »). Pendant une session, seul le
// responsable git (le plus ancien membre qui a git) commit et push.
import { execFile } from "child_process";

export interface GitSettings {
  commitMessage: string;
  push: boolean;
  pullBeforePush: boolean;
}

export class Git {
  private chain: Promise<void> = Promise.resolve();
  private syncQueued = false;
  private queuedAlwaysPull = false;
  status = "git: ok";

  constructor(
    readonly cwd: string,
    readonly settings: () => GitSettings,
    readonly onStatus: (s: string) => void,
    readonly onError: (msg: string) => void,
  ) {}

  run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: this.cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || stdout || err.message).trim()));
        else resolve(stdout.trim());
      });
    });
  }

  /** Le coffre est-il la racine d'un dépôt ? (pas juste un sous-dossier d'un autre dépôt) */
  async isRepo() {
    try {
      const fs = require("fs") as typeof import("fs");
      const top = await this.run(["rev-parse", "--show-toplevel"]);
      return fs.realpathSync(top) === fs.realpathSync(this.cwd);
    } catch {
      return false;
    }
  }

  async remoteUrl() {
    return this.run(["remote", "get-url", "origin"]).catch(() => "");
  }

  private set(s: string) {
    this.status = s;
    this.onStatus(s);
  }

  /** Les opérations git passent une par une, dans l'ordre. */
  private exclusive(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await fn();
      } catch (e: any) {
        this.set("git: erreur ⚠");
        this.onError(e.message);
        console.error("[collab-vault]", e);
      }
    });
    return this.chain;
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
      this.onError("conflit avec le dépôt distant : fusion faite en gardant la version de la session.");
    } catch (e: any) {
      await this.run(["merge", "--abort"]).catch(() => {});
      throw new Error("pull impossible (conflit) : " + e.message);
    }
  }

  /** Fichiers propres à chaque machine : jamais versionnés, sinon conflits entre amis. */
  async ensureIgnored(paths: string[]) {
    const fs = require("fs") as typeof import("fs");
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
