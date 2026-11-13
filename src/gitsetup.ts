// Assistant git : trouver / installer git, se connecter à GitHub, régler son identité.
// Pensé pour des amis sous Windows qui n'ont jamais ouvert un terminal.
import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { isAuthError, QUIET_ENV } from "./git";

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
  async checkAccess(): Promise<{ ok: boolean; message: string; needsLogin?: boolean }> {
    const r = await run(this.bin, ["ls-remote", "--heads", "origin"], { cwd: this.cwd, quiet: true, timeoutMs: 30000 });
    if (r.ok) return { ok: true, message: "Accès au dépôt OK" };
    // Aucun identifiant enregistré sur cet ordinateur : git voudrait le demander dans un terminal.
    if (/could not read (Username|Password)|terminal prompts disabled|cannot prompt|GCM_INTERACTIVE/i.test(r.err)) {
      return { ok: false, needsLogin: true, message: "Pas encore connecté à GitHub sur cet ordinateur." };
    }
    if (/Repository not found|denied|40[13]/i.test(r.err)) {
      return {
        ok: false,
        needsLogin: true,
        message: "GitHub refuse l'accès : connecte-toi avec le compte qui a été invité sur le dépôt.",
      };
    }
    return { ok: false, message: lastLine(r.err) };
  }

  async remoteHost(): Promise<{ protocol: string; host: string } | null> {
    const r = await run(this.bin, ["remote", "get-url", "origin"], { cwd: this.cwd, quiet: true });
    const m = r.out.trim().match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)/);
    return m ? { protocol: m[1], host: m[2] } : null;
  }

  async remoteUrl(): Promise<string> {
    return (await run(this.bin, ["remote", "get-url", "origin"], { cwd: this.cwd, quiet: true })).out.trim();
  }

  /** Gestionnaire d'identifiants actif (le dernier non vide : une valeur vide annule les précédentes). */
  async helper(): Promise<string> {
    const all = (await run(this.bin, ["config", "--get-all", "credential.helper"], { cwd: this.cwd, quiet: true })).out;
    return all.replace(/\r?\n$/, "").split(/\r?\n/).pop()?.trim() ?? "";
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
      const why = fill.err.trim() ? ` (${lastLine(fill.err)})` : "";
      return { ok: false, message: `La connexion n'a pas abouti${why}. Réessaie, ou vérifie qu'une fenêtre GitHub n'est pas restée derrière Obsidian.` };
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
    // Pas encore de dépôt : on règle l'identité pour tout l'ordinateur (sinon `git config` échoue).
    const scope = fs().existsSync(this.cwd + "/.git") ? [] : ["--global"];
    await run(this.bin, ["config", ...scope, "user.name", id.name], { cwd: this.cwd, quiet: true });
    await run(this.bin, ["config", ...scope, "user.email", id.email], { cwd: this.cwd, quiet: true });
  }

  private git(args: string[], timeoutMs = 60000) {
    return run(this.bin, args, { cwd: this.cwd, quiet: true, timeoutMs });
  }

  /**
   * Transforme le coffre en dépôt git (branche main). Le .gitignore et le premier commit
   * sont faits ensuite par la sauvegarde automatique.
   */
  async initRepo(): Promise<{ ok: boolean; message: string }> {
    let r = await this.git(["init", "-b", "main"]);
    if (!r.ok) {
      // git trop ancien pour -b
      r = await this.git(["init"]);
      if (r.ok) await this.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    if (!r.ok) return { ok: false, message: "Impossible de créer le dépôt : " + lastLine(r.err) };
    // Fins de ligne identiques sur Windows, Mac et téléphone : évite des diffs fantômes.
    const attr = this.cwd + "/.gitattributes";
    if (!fs().existsSync(attr)) fs().writeFileSync(attr, "* text=auto\n");
    return { ok: true, message: "Dépôt git créé : tes notes seront enregistrées automatiquement." };
  }

  /**
   * Relie le coffre à un dépôt GitHub. Dépôt vide : la prochaine sauvegarde l'envoie.
   * Dépôt avec des notes : on les récupère et on les fusionne avec celles du coffre.
   */
  async connectRemote(url: string): Promise<{ ok: boolean; message: string }> {
    url = url.trim();
    if (!/^(https?:\/\/|git@|file:\/\/)\S+$/.test(url)) {
      return { ok: false, message: "Adresse invalide. Exemple : https://github.com/pseudo/coffre.git" };
    }
    const hasOrigin = (await this.git(["remote", "get-url", "origin"])).ok;
    await this.git(["remote", hasOrigin ? "set-url" : "add", "origin", url]);

    const head = await this.git(["ls-remote", "--symref", "origin", "HEAD"], 30000);
    if (!head.ok) {
      return isAuthError(head.err)
        ? { ok: false, message: "Dépôt relié, mais GitHub refuse l'accès : connecte-toi ci-dessous." }
        : { ok: false, message: "Dépôt injoignable : " + lastLine(head.err) };
    }
    const branch = head.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
    if (!branch) return { ok: true, message: "Relié à GitHub. Le dépôt est vide : la prochaine sauvegarde y enverra tes notes." };

    // Le dépôt contient déjà des notes : on enregistre celles d'ici, puis on fusionne.
    await this.git(["add", "-A"]);
    if ((await this.git(["status", "--porcelain"])).out.trim()) {
      const c = await this.git(["commit", "-m", "Notes du coffre avant la liaison avec GitHub"]);
      if (!c.ok) return { ok: false, message: "Commit impossible (nom et e-mail réglés ?) : " + lastLine(c.err || c.out) };
    }
    const fetch = await this.git(["fetch", "origin", branch], 5 * 60 * 1000);
    if (!fetch.ok) {
      await this.git(["remote", "remove", "origin"]);
      return { ok: false, message: "Téléchargement impossible : " + lastLine(fetch.err) };
    }
    const hasCommits = (await this.git(["rev-parse", "--verify", "HEAD"])).ok;
    await this.git(["branch", "-M", branch]);
    if (hasCommits) {
      const m = await this.git(["merge", `origin/${branch}`, "--allow-unrelated-histories", "--no-edit"], 5 * 60 * 1000);
      if (!m.ok) {
        await this.git(["merge", "--abort"]);
        // On défait la liaison : sinon chaque sauvegarde tenterait un push refusé.
        await this.git(["remote", "remove", "origin"]);
        return {
          ok: false,
          message:
            "Les notes de GitHub entrent en conflit avec celles de ce coffre. Tes notes n'ont pas été modifiées : " +
            "clone plutôt le dépôt dans un nouveau dossier (GitHub Desktop) et ouvre-le dans Obsidian.",
        };
      }
    } else {
      await this.git(["reset", "--hard", `origin/${branch}`]);
    }
    await this.git(["branch", `--set-upstream-to=origin/${branch}`]);
    return { ok: true, message: "Relié à GitHub : les notes du dépôt ont été récupérées." };
  }
}

const lastLine = (s: string) => s.trim().split("\n").pop() || "erreur inconnue";

/** Fenêtre d'assistant : un état par étape, avec un bouton pour chaque problème. */
export class GitSetupModal extends Modal {
  private busy = false;
  /** La connexion automatique a déjà été tentée pendant cette ouverture de l'assistant. */
  private autoLoginTried = false;
  /** Raison du dernier échec de connexion, affichée sous l'étape. */
  private loginResult = "";

  constructor(
    app: App,
    readonly ctx: {
      cwd: string;
      hasRepo: () => boolean;
      gitBin: () => string | null;
      /** Relance la détection de git après une installation ; renvoie le chemin trouvé. */
      redetect: () => Promise<string | null>;
      /** Appelé quand tout est prêt (pour relancer la sauvegarde / la session). `force` : sauvegarde tout de suite. */
      onReady: (force?: boolean) => void;
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

    // 3. le coffre est-il un dépôt git ?
    if (!this.ctx.hasRepo()) {
      const s = step(
        false,
        "Dépôt git du coffre",
        "Ce coffre n'est pas encore un dépôt git. Si ses notes sont déjà sur GitHub, clone plutôt le dépôt " +
          "(GitHub Desktop) et ouvre ce dossier dans Obsidian. Sinon, crée le dépôt ici." +
          (idOk ? "" : " Enregistre d'abord ton nom ci-dessus."),
      );
      s.addButton(b =>
        b
          .setButtonText("Créer le dépôt")
          .setCta()
          .setDisabled(!idOk)
          .onClick(async () => {
            if (this.busy) return;
            this.busy = true;
            b.setDisabled(true);
            const r = await setup.initRepo();
            this.busy = false;
            new Notice(r.message, 8000);
            if (r.ok) this.ctx.onReady(true);
            void this.render();
          }),
      );
      return;
    }
    step(true, "Dépôt git du coffre", this.ctx.cwd);

    // 4. relié à GitHub ?
    if (!(await setup.remoteUrl())) {
      const s = step(
        false,
        "Dépôt GitHub",
        "Pas encore relié : tes notes sont enregistrées sur cet ordinateur seulement. " +
          "Crée un dépôt privé vide sur GitHub, puis colle son adresse ici.",
      );
      let url = "";
      s.addText(t => t.setPlaceholder("https://github.com/pseudo/coffre.git").onChange(v => (url = v.trim())));
      s.addButton(b =>
        b.setButtonText("Créer sur GitHub").onClick(() => {
          const name = this.ctx.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "coffre";
          window.open(`https://github.com/new?name=${encodeURIComponent(name)}&visibility=private`);
        }),
      );
      s.addButton(b =>
        b
          .setButtonText("Relier")
          .setCta()
          .onClick(async () => {
            if (this.busy) return;
            if (!url) return new Notice("Colle l'adresse du dépôt GitHub.");
            this.busy = true;
            b.setDisabled(true);
            s.setDesc("Liaison avec GitHub…");
            const r = await setup.connectRemote(url);
            this.busy = false;
            new Notice(r.message, 10000);
            if (r.ok) this.ctx.onReady(true);
            void this.render();
          }),
      );
      return;
    }

    // 5. accès GitHub
    const accessStep = step(null, "Connexion à GitHub", "Vérification…");
    const access = await setup.checkAccess();
    accessStep
      .setName(`${access.ok ? "✅" : "❌"} Connexion à GitHub`)
      .setDesc(access.ok || !this.loginResult ? access.message : `${access.message} ${this.loginResult}`);
    if (!access.ok) {
      let button: import("obsidian").ButtonComponent | null = null;
      const login = async () => {
        if (this.busy) return;
        this.busy = true;
        button?.setDisabled(true);
        accessStep.setDesc("La page de connexion GitHub s'ouvre (fenêtre ou navigateur, parfois derrière Obsidian)…");
        const r = await setup.login();
        this.busy = false;
        this.loginResult = r.ok ? "" : r.message;
        new Notice(r.message, 8000);
        void this.render();
      };
      accessStep.addButton(b => {
        button = b;
        b.setButtonText("Se connecter à GitHub").setCta().onClick(() => void login());
      });
      // Pas d'identifiant sur cet ordinateur : on ouvre la connexion tout de suite (une fois par ouverture).
      if (access.needsLogin && !this.autoLoginTried) {
        this.autoLoginTried = true;
        void login();
      }
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
