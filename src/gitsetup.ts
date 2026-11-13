// Assistant git : trouver / installer git, se connecter à GitHub, régler son identité.
// Pensé pour des amis sous Windows qui n'ont jamais ouvert un terminal.
import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { QUIET_ENV } from "./git";

const node = <T>(m: string): T => require(m);
const cp = () => node<typeof import("child_process")>("child_process");
const fs = () => node<typeof import("fs")>("fs");

interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

function run(bin: string, args: string[], opts: { cwd?: string; input?: string; quiet?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    let done = false;
    const env = opts.quiet ? { ...process.env, ...QUIET_ENV } : { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    let child: import("child_process").ChildProcess;
    try {
      child = cp().spawn(bin, args, { cwd: opts.cwd, env, windowsHide: true });
    } catch (e: any) {
      return resolve({ ok: false, out: "", err: e.message });
    }
    let out = "";
    let err = "";
    child.stdout?.on("data", d => (out += d));
    child.stderr?.on("data", d => (err += d));
    const finish = (ok: boolean, extra = "") => {
      if (done) return;
      done = true;
      resolve({ ok, out, err: err + extra });
    };
    child.on("error", e => finish(false, e.message));
    child.on("close", code => finish(code === 0));
    if (opts.timeoutMs) setTimeout(() => (child.kill(), finish(false, "délai dépassé")), opts.timeoutMs);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Emplacements habituels de git sous Windows (le PATH d'Obsidian n'est pas à jour juste après l'installation). */
function windowsCandidates() {
  const env = process.env;
  return [
    env.ProgramFiles && `${env.ProgramFiles}\\Git\\cmd\\git.exe`,
    env["ProgramFiles(x86)"] && `${env["ProgramFiles(x86)"]}\\Git\\cmd\\git.exe`,
    env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Programs\\Git\\cmd\\git.exe`,
  ].filter(Boolean) as string[];
}

/** Chemin de git, ou null s'il n'est pas installé. */
export async function findGit(preferred?: string): Promise<string | null> {
  if (!Platform.isDesktopApp) return null;
  const tries = [preferred, "git", ...(process.platform === "win32" ? windowsCandidates() : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"])];
  for (const t of tries) {
    if (!t) continue;
    if (t !== "git" && !fs().existsSync(t)) continue;
    const r = await run(t, ["--version"], { quiet: true, timeoutMs: 10000 });
    if (r.ok) return t;
  }
  return null;
}

/** Installe Git for Windows avec winget (Windows 10/11). */
export async function installGitWindows(onProgress: (s: string) => void): Promise<boolean> {
  onProgress("Installation de Git en cours… (Windows peut demander une autorisation)");
  const r = await run(
    "winget",
    ["install", "--id", "Git.Git", "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent"],
    { timeoutMs: 10 * 60 * 1000 },
  );
  if (!r.ok) console.warn("[collab-vault] winget", r.out, r.err);
  return r.ok || /already installed|déjà installé/i.test(r.out);
}

export interface Identity {
  name: string;
  email: string;
}

export class GitSetup {
  constructor(readonly bin: string, readonly cwd: string) {}

  /** L'accès au dépôt distant fonctionne-t-il sans rien demander ? */
  async checkAccess(): Promise<{ ok: boolean; message: string }> {
    const r = await run(this.bin, ["ls-remote", "--heads", "origin"], { cwd: this.cwd, quiet: true, timeoutMs: 30000 });
    if (r.ok) return { ok: true, message: "Accès au dépôt OK" };
    if (/Repository not found|denied|40[13]/i.test(r.err)) {
      return { ok: false, message: "GitHub refuse l'accès : connecte-toi avec le compte qui a été invité sur le dépôt." };
    }
    return { ok: false, message: r.err.trim().split("\n").pop() || "Connexion impossible" };
  }

  async remoteHost(): Promise<{ protocol: string; host: string } | null> {
    const r = await run(this.bin, ["remote", "get-url", "origin"], { cwd: this.cwd, quiet: true });
    const m = r.out.trim().match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)/);
    return m ? { protocol: m[1], host: m[2] } : null;
  }

  async helper(): Promise<string> {
    return (await run(this.bin, ["config", "--get", "credential.helper"], { cwd: this.cwd, quiet: true })).out.trim();
  }

  /**
   * Connexion visuelle : on demande un identifiant à git ; avec Git for Windows,
   * Git Credential Manager ouvre la fenêtre / la page de connexion GitHub.
   */
  async login(): Promise<{ ok: boolean; message: string }> {
    const remote = await this.remoteHost();
    if (!remote) {
      return { ok: false, message: "Le dépôt n'utilise pas une adresse https (ex. SSH) : la connexion se règle hors d'Obsidian." };
    }
    if (!(await this.helper())) {
      return {
        ok: false,
        message:
          process.platform === "win32"
            ? "Aucun gestionnaire de connexion : réinstalle Git for Windows (il inclut Git Credential Manager)."
            : "Aucun gestionnaire de connexion configuré. Dans un terminal : gh auth login puis gh auth setup-git.",
      };
    }
    const query = `protocol=${remote.protocol}\nhost=${remote.host}\n\n`;
    const fill = await run(this.bin, ["credential", "fill"], { cwd: this.cwd, input: query, timeoutMs: 5 * 60 * 1000 });
    if (!fill.ok || !/password=/.test(fill.out)) {
      return { ok: false, message: "Connexion annulée ou refusée." };
    }
    // Vérifie que ça marche, puis demande à git de mémoriser l'identifiant.
    const access = await this.checkAccess();
    await run(this.bin, ["credential", access.ok ? "approve" : "reject"], { cwd: this.cwd, input: fill.out + "\n", quiet: true });
    const user = fill.out.match(/^username=(.*)$/m)?.[1];
    return access.ok ? { ok: true, message: `Connecté${user ? ` en tant que ${user}` : ""}` } : access;
  }

  async identity(): Promise<Identity> {
    const get = async (k: string) => (await run(this.bin, ["config", "--get", k], { cwd: this.cwd, quiet: true })).out.trim();
    return { name: await get("user.name"), email: await get("user.email") };
  }

  /** Identité des commits, réglée pour ce coffre seulement. */
  async setIdentity(id: Identity) {
    await run(this.bin, ["config", "user.name", id.name], { cwd: this.cwd, quiet: true });
    await run(this.bin, ["config", "user.email", id.email], { cwd: this.cwd, quiet: true });
  }
}

/** Fenêtre d'assistant : un état par étape, avec un bouton pour chaque problème. */
export class GitSetupModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    readonly ctx: {
      cwd: string;
      hasRepo: () => boolean;
      gitBin: () => string | null;
      /** Relance la détection de git après une installation ; renvoie le chemin trouvé. */
      redetect: () => Promise<string | null>;
      /** Appelé quand tout est prêt (pour relancer la sauvegarde / la session). */
      onReady: () => void;
    },
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Git et GitHub");
    void this.render();
  }

  private async render() {
    const el = this.contentEl;
    el.empty();
    if (!Platform.isDesktopApp) {
      el.createEl("p", { text: "Sur téléphone, git n'est pas disponible : ce sont les ordinateurs de la session qui sauvegardent." });
      return;
    }
    if (!this.ctx.hasRepo()) {
      el.createEl("p", {
        text: "Ce coffre n'est pas un dépôt git. Pour la sauvegarde, clone d'abord le dépôt (par ex. avec GitHub Desktop) puis ouvre ce dossier dans Obsidian.",
      });
      return;
    }
    const status = el.createDiv({ cls: "cv-setup" });
    const step = (ok: boolean | null, title: string, desc: string) => {
      const s = new Setting(status).setName(`${ok === true ? "✅" : ok === false ? "❌" : "⏳"} ${title}`).setDesc(desc);
      return s;
    };

    // 1. git installé ?
    const bin = this.ctx.gitBin();
    if (!bin) {
      const s = step(false, "Git n'est pas installé", "Il faut le programme git pour sauvegarder le coffre sur GitHub.");
      if (process.platform === "win32") {
        s.addButton(b =>
          b
            .setButtonText("Installer Git")
            .setCta()
            .onClick(async () => {
              if (this.busy) return;
              this.busy = true;
              b.setDisabled(true);
              const ok = await installGitWindows(m => s.setDesc(m));
              const found = ok ? await this.ctx.redetect() : null;
              this.busy = false;
              if (!found) {
                new Notice("Installation automatique impossible : la page de téléchargement va s'ouvrir.", 8000);
                window.open("https://git-scm.com/download/win");
              }
              void this.render();
            }),
        );
      }
      s.addButton(b => b.setButtonText("Page de téléchargement").onClick(() => window.open("https://git-scm.com/downloads")));
      s.addButton(b =>
        b.setButtonText("Revérifier").onClick(async () => {
          await this.ctx.redetect();
          void this.render();
        }),
      );
      return;
    }
    step(true, "Git est installé", bin);

    const setup = new GitSetup(bin, this.ctx.cwd);

    // 2. identité des commits
    const id = await setup.identity();
    const idOk = !!(id.name && id.email);
    const idStep = step(idOk, "Ton nom pour les sauvegardes", idOk ? `${id.name} <${id.email}>` : "Nécessaire pour enregistrer des commits.");
    let name = id.name;
    let email = id.email;
    idStep.addText(t => t.setPlaceholder("Prénom").setValue(name).onChange(v => (name = v.trim())));
    idStep.addText(t => t.setPlaceholder("e-mail GitHub").setValue(email).onChange(v => (email = v.trim())));
    idStep.addButton(b =>
      b.setButtonText("Enregistrer").onClick(async () => {
        if (!name || !email) return new Notice("Indique un nom et un e-mail.");
        await setup.setIdentity({ name, email });
        void this.render();
      }),
    );

    // 3. accès GitHub
    const accessStep = step(null, "Connexion à GitHub", "Vérification…");
    const access = await setup.checkAccess();
    accessStep.setName(`${access.ok ? "✅" : "❌"} Connexion à GitHub`).setDesc(access.message);
    if (!access.ok) {
      accessStep.addButton(b =>
        b
          .setButtonText("Se connecter à GitHub")
          .setCta()
          .onClick(async () => {
            if (this.busy) return;
            this.busy = true;
            b.setDisabled(true);
            accessStep.setDesc("Une fenêtre de connexion GitHub va s'ouvrir (parfois derrière Obsidian)…");
            const r = await setup.login();
            this.busy = false;
            new Notice(r.message, 8000);
            void this.render();
          }),
      );
    }
    accessStep.addButton(b => b.setButtonText("Revérifier").onClick(() => void this.render()));

    if (access.ok && idOk) {
      el.createEl("p", { cls: "cv-muted", text: "Tout est prêt : la sauvegarde automatique fonctionne." });
      this.ctx.onReady();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
