import {
  App,
  FileSystemAdapter,
  Modal,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import { EditorBinder } from "./editor";
import { Git } from "./git";
import { Disk, isText, Session } from "./session";
import { FileOp, TrysteroTransport } from "./transport";

const ROOM_FILE = ".collab/room.json";
const MAX_BINARY = 50 * 1024 * 1024;
const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

interface Settings {
  name: string;
  color: string;
  delaySeconds: number;
  commitMessage: string;
  push: boolean;
  pullBeforePush: boolean;
  pullOnStartup: boolean;
  pullIntervalMin: number;
  notifySuccess: boolean;
}

interface RoomConfig {
  room: string;
  secret: string;
}

export default class CollabVault extends Plugin {
  declare settings: Settings;
  cwd = "";
  git: Git | null = null;
  session: Session | null = null;
  transport: TrysteroTransport | null = null;
  binder = new EditorBinder();
  statusBar!: HTMLElement;
  private gitTimer: number | null = null;
  private wasFollower = false;
  private wasLeader = false;
  private recentBinary = new Map<string, number>();
  private starting = false;
  private knownMembers = new Set<string>();

  async onload() {
    this.settings = Object.assign(
      {
        name: defaultName(),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        delaySeconds: 30,
        commitMessage: "vault: {{date}} ({{count}} fichier(s))",
        push: true,
        pullBeforePush: true,
        pullOnStartup: true,
        pullIntervalMin: 2,
        notifySuccess: false,
      },
      await this.loadData(),
    );
    await this.saveData(this.settings);

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("Collab Vault : coffre non local, plugin désactivé.");
      return;
    }
    this.cwd = adapter.getBasePath();

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.onClickEvent(() => new MembersModal(this.app, this).open());
    this.registerEditorExtension(this.binder.extension());
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerCommands();
    this.registerObsidianProtocolHandler("collab-vault", params => this.handleInviteLink(params));
    this.addRibbonIcon("users", "Collab Vault : qui est là ?", () => new MembersModal(this.app, this).open());

    this.app.workspace.onLayoutReady(() => void this.startup());
  }

  onunload() {
    if (this.gitTimer) window.clearTimeout(this.gitTimer);
    this.binder.unbindAll(this.app);
    void this.session?.stop();
  }

  // ------------------------------------------------------------------ démarrage

  private async startup() {
    const git = new Git(
      this.cwd,
      () => this.settings,
      () => this.updateStatus(),
      msg => new Notice("Collab Vault : erreur git\n" + msg, 10000),
    );
    if (await git.isRepo()) {
      this.git = git;
      await git.ensureIgnored([
        ".obsidian/workspace.json",
        ".obsidian/workspace-mobile.json",
        `${this.manifest.dir}/data.json`,
      ]);
    }

    // Les évènements « create » du chargement du coffre sont passés : on peut écouter.
    this.registerEvent(this.app.vault.on("create", f => this.onCreateOrModify(f)));
    this.registerEvent(this.app.vault.on("modify", f => this.onCreateOrModify(f)));
    this.registerEvent(this.app.vault.on("delete", f => this.onDelete(f)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => this.onRename(f, old)));
    const rebind = () => this.rebind();
    this.registerEvent(this.app.workspace.on("layout-change", rebind));
    this.registerEvent(this.app.workspace.on("file-open", rebind));
    this.registerEvent(this.app.workspace.on("active-leaf-change", rebind));
    this.registerInterval(
      window.setInterval(() => {
        if (this.git && this.isGitLeader()) void this.git.sync(true);
      }, Math.max(1, this.settings.pullIntervalMin) * 60 * 1000),
    );

    // Avant de rejoindre : on envoie ses modifs locales et on récupère celles des autres.
    if (this.git && this.settings.pullOnStartup) await this.git.sync(true);
    await this.startSession();
    this.updateStatus();
  }

  async readRoom(): Promise<RoomConfig | null> {
    try {
      const raw = await this.app.vault.adapter.read(ROOM_FILE);
      const r = JSON.parse(raw);
      return r?.room && r?.secret ? r : null;
    } catch {
      return null;
    }
  }

  async writeRoom(r: RoomConfig) {
    if (!(await this.app.vault.adapter.exists(".collab"))) await this.app.vault.adapter.mkdir(".collab");
    await this.app.vault.adapter.write(ROOM_FILE, JSON.stringify(r, null, 2) + "\n");
  }

  async startSession() {
    if (this.session || this.starting) return;
    const room = await this.readRoom();
    if (!room) return;
    this.starting = true;
    this.updateStatus();
    try {
      const transport = await TrysteroTransport.connect(room.room, room.secret);
      const session = new Session(
        transport,
        this.disk(),
        { name: this.settings.name, color: this.settings.color, git: !!this.git, joinTimeoutMs: 5000 },
        {
          isBound: p => this.binder.isBound(p),
          onStructure: () => this.rebind(),
          onPeers: () => this.onPeersChanged(),
          log: (...a) => console.log("[collab-vault]", ...a),
        },
      );
      transport.onFile((op, data, from) => void this.onRemoteFile(op, data, from));
      transport.onError(e => console.warn("[collab-vault] réseau", e));
      this.transport = transport;
      this.session = session;
      session.start();
      session.setActiveFile(this.app.workspace.getActiveFile()?.path ?? null);
    } catch (e: any) {
      new Notice("Collab Vault : connexion impossible\n" + e.message, 10000);
      console.error(e);
    } finally {
      this.starting = false;
      this.updateStatus();
    }
  }

  async stopSession() {
    const s = this.session;
    this.session = null;
    this.transport = null;
    this.binder.unbindAll(this.app);
    this.wasFollower = false;
    await s?.stop();
    this.updateStatus();
  }

  // ------------------------------------------------------------------ rôles & git

  /** Est-ce à moi de commit/push ? (toujours, hors session) */
  isGitLeader() {
    if (!this.git) return false;
    if (!this.session) return !this.starting;
    return !!this.session.seeded && !!this.session.gitLeader()?.self;
  }

  private onPeersChanged() {
    this.welcomeNewMembers();
    const leader = this.isGitLeader();
    if (this.session?.seeded) {
      if (leader && !this.wasLeader && this.wasFollower && this.git) {
        // L'ancien responsable git est parti : on reprend la sauvegarde.
        this.wasFollower = false;
        void this.git.adopt();
      }
      if (!leader) {
        this.wasFollower = true;
        if (this.gitTimer) window.clearTimeout(this.gitTimer);
      }
    }
    this.wasLeader = leader;
    this.updateStatus();
  }

  /** L'hôte envoie la liste de ses fichiers non texte aux nouveaux venus (images, PDF…). */
  private welcomeNewMembers() {
    const s = this.session;
    if (!s?.seeded) return this.knownMembers.clear();
    const members = s.members();
    const isHost = !!members[0]?.self;
    for (const m of members) {
      if (m.self || this.knownMembers.has(m.id)) continue;
      if (isHost) {
        const files = this.app.vault
          .getFiles()
          .filter(f => !isText(f.path) && f.stat.size <= MAX_BINARY)
          .map(f => [f.path, f.stat.size] as [string, number]);
        if (files.length) void this.transport?.sendFile({ op: "manifest", files }, undefined, m.id);
      }
    }
    this.knownMembers = new Set(members.map(m => m.id));
  }

  scheduleGit() {
    if (!this.git || !this.isGitLeader()) return;
    if (this.gitTimer) window.clearTimeout(this.gitTimer);
    this.gitTimer = window.setTimeout(() => {
      this.gitTimer = null;
      if (this.isGitLeader()) void this.git!.sync();
    }, Math.max(1, this.settings.delaySeconds) * 1000);
    this.updateStatus("git: modifs en attente…");
  }

  // ------------------------------------------------------------------ disque

  private disk(): Disk {
    const vault = this.app.vault;
    const get = (p: string) => vault.getAbstractFileByPath(normalizePath(p));
    return {
      listText: async () => vault.getFiles().filter(f => isText(f.path)).map(f => f.path),
      read: async p => {
        const f = get(p);
        return f instanceof TFile ? vault.read(f) : null;
      },
      write: async (p, c) => {
        const f = get(p);
        if (f instanceof TFile) await vault.modify(f, c);
        else if (!f) {
          await this.ensureParent(p);
          await vault.create(normalizePath(p), c);
        }
      },
      remove: async p => {
        const f = get(p);
        if (f) await this.app.fileManager.trashFile(f);
      },
      // vault.rename et pas fileManager.renameFile : les liens ont déjà été mis à jour
      // chez celui qui a renommé, et ces modifs arrivent par la synchro.
      rename: async (a, b) => {
        const f = get(a);
        if (!f || get(b)) return;
        await this.ensureParent(b);
        await vault.rename(f, normalizePath(b));
      },
    };
  }

  private async ensureParent(path: string) {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
      await this.app.vault.createFolder(parent).catch(() => {});
    }
  }

  private markBinary(path: string) {
    this.recentBinary.set(path, Date.now());
  }
  private isEchoBinary(path: string) {
    const t = this.recentBinary.get(path);
    return t !== undefined && Date.now() - t < 3000;
  }
  private canShareFiles() {
    return !!this.session?.seeded && !!this.transport;
  }

  private onCreateOrModify(f: TAbstractFile) {
    this.scheduleGit();
    if (!(f instanceof TFile) || !this.session) return;
    if (isText(f.path)) {
      void this.session.diskChanged(f.path);
    } else if (this.canShareFiles() && !this.isEchoBinary(f.path) && f.stat.size <= MAX_BINARY) {
      void this.app.vault.readBinary(f).then(buf => this.transport?.sendFile({ op: "put", path: f.path }, new Uint8Array(buf)));
    }
  }

  private onDelete(f: TAbstractFile) {
    this.scheduleGit();
    if (!this.session) return;
    this.session.diskDeleted(f.path);
    if (this.canShareFiles() && !this.isEchoBinary(f.path) && (f instanceof TFolder || !isText(f.path))) {
      this.transport!.sendFile({ op: "del", path: f.path });
    }
  }

  private onRename(f: TAbstractFile, old: string) {
    this.scheduleGit();
    if (!this.session) return;
    this.session.diskRenamed(old, f.path);
    if (!this.canShareFiles() || this.isEchoBinary(f.path)) return;
    const binaries =
      f instanceof TFolder
        ? allFiles(f).filter(c => !isText(c.path)).map(c => [old + c.path.slice(f.path.length), c.path])
        : !isText(f.path)
          ? [[old, f.path]]
          : [];
    for (const [a, b] of binaries) this.transport!.sendFile({ op: "mv", path: a, to: b });
  }

  private async onRemoteFile(op: FileOp, data: Uint8Array, from: string) {
    const s = this.session;
    if (!s?.seeded || s.peers.get(from)?.origin !== s.origin) return;
    const vault = this.app.vault;
    const get = (p: string) => vault.getAbstractFileByPath(normalizePath(p));
    try {
      if (op.op === "put" && !isText(op.path)) {
        const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        this.markBinary(op.path);
        const f = get(op.path);
        if (f instanceof TFile) await vault.modifyBinary(f, buf);
        else if (!f) {
          await this.ensureParent(op.path);
          await vault.createBinary(normalizePath(op.path), buf);
        }
      } else if (op.op === "del") {
        const f = get(op.path);
        if (f) {
          this.markBinary(op.path);
          await this.app.fileManager.trashFile(f);
        }
      } else if (op.op === "manifest") {
        const missing = op.files
          .filter(([p, size]) => {
            const f = get(p);
            return !isText(p) && !(f instanceof TFolder) && !(f instanceof TFile && f.stat.size === size);
          })
          .map(([p]) => p);
        if (missing.length) {
          new Notice(`Collab Vault : réception de ${missing.length} fichier(s) (images, PDF…)`);
          void this.transport?.sendFile({ op: "get", paths: missing }, undefined, from);
        }
      } else if (op.op === "get") {
        for (const p of op.paths) {
          const f = get(p);
          if (!(f instanceof TFile) || isText(p) || f.stat.size > MAX_BINARY) continue;
          const buf = await vault.readBinary(f);
          await this.transport?.sendFile({ op: "put", path: p }, new Uint8Array(buf), from);
        }
      } else if (op.op === "mv" && !isText(op.path)) {
        const f = get(op.path);
        if (f && !get(op.to)) {
          this.markBinary(op.to);
          await this.ensureParent(op.to);
          await vault.rename(f, normalizePath(op.to));
        }
      }
    } catch (e) {
      console.warn("[collab-vault] fichier reçu", op, e);
    }
  }

  // ------------------------------------------------------------------ UI

  rebind() {
    this.binder.bindAll(this.app, this.session);
    this.session?.setActiveFile(this.app.workspace.getActiveFile()?.path ?? null);
  }

  updateStatus(gitOverride?: string) {
    if (!this.statusBar) return;
    const parts: string[] = [];
    const s = this.session;
    if (this.starting || (s && !s.seeded)) parts.push("⟳ connexion…");
    else if (s) {
      const members = s.members();
      const host = members[0];
      parts.push(members.length <= 1 ? "● seul·e (hôte)" : `👥 ${members.length} · ${host?.self ? "hôte" : "invité·e"}`);
    }
    if (this.git) {
      if (s?.seeded && !this.isGitLeader()) parts.push(`git: ${s.gitLeader()?.name ?? "?"} sauvegarde`);
      else parts.push(gitOverride ?? this.git.status);
    } else if (s?.seeded) {
      parts.push(s.gitLeader() ? `git: ${s.gitLeader()!.name} sauvegarde` : "⚠ personne ne sauvegarde");
    }
    this.statusBar.setText(parts.join(" · "));
  }

  private registerCommands() {
    this.addCommand({
      id: "enable",
      name: "Activer la collaboration dans ce coffre",
      callback: async () => {
        if (await this.readRoom()) return new Notice("La collaboration est déjà activée ici.");
        await this.writeRoom({ room: randomId(12), secret: randomId(24) });
        new Notice("Collaboration activée ! Utilise « Inviter quelqu'un » pour partager le coffre.");
        await this.startSession();
        this.scheduleGit();
      },
    });
    this.addCommand({ id: "invite", name: "Inviter quelqu'un", callback: () => void this.openInvite() });
    this.addCommand({ id: "members", name: "Qui est connecté ?", callback: () => new MembersModal(this.app, this).open() });
    this.addCommand({
      id: "sync-now",
      name: "Commit & push maintenant",
      callback: () => {
        if (!this.git) return new Notice("Ce coffre n'est pas un dépôt git.");
        if (!this.isGitLeader()) return new Notice(`C'est ${this.session?.gitLeader()?.name} qui sauvegarde pendant la session.`);
        void this.git.sync(true);
      },
    });
    this.addCommand({
      id: "reconnect",
      name: "Reconnecter la session",
      callback: async () => {
        await this.stopSession();
        await this.startSession();
      },
    });
  }

  private async openInvite() {
    let room = await this.readRoom();
    if (!room) {
      await this.writeRoom({ room: randomId(12), secret: randomId(24) });
      room = (await this.readRoom())!;
      await this.startSession();
      this.scheduleGit();
    }
    const remote = this.git ? await this.git.remoteUrl() : "";
    new InviteModal(this.app, room, this.app.vault.getName(), remote).open();
  }

  private handleInviteLink(params: Record<string, string>) {
    const { room, secret, name } = params;
    if (!room || !secret) return new Notice("Lien d'invitation invalide.");
    new ConfirmModal(
      this.app,
      `Rejoindre « ${name ?? "coffre partagé"} » ?`,
      `Ce coffre (« ${this.app.vault.getName()} ») sera synchronisé avec la session : les notes partagées y seront écrites et remplacent les versions locales qui portent le même nom.`,
      async () => {
        await this.stopSession();
        await this.writeRoom({ room, secret });
        await this.startSession();
      },
    ).open();
  }
}

// ==================================================================== modales

class MembersModal extends Modal {
  constructor(app: App, readonly plugin: CollabVault) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    const s = this.plugin.session;
    contentEl.createEl("h3", { text: "Session de collaboration" });
    if (!s) {
      contentEl.createEl("p", { text: "La collaboration n'est pas activée dans ce coffre." });
      new Setting(contentEl).addButton(b =>
        b.setButtonText("Inviter quelqu'un").setCta().onClick(() => {
          this.close();
          (this.app as any).commands.executeCommandById("collab-vault:invite");
        }),
      );
      return;
    }
    if (!s.seeded) {
      contentEl.createEl("p", { text: "Connexion en cours…" });
      return;
    }
    const leader = s.gitLeader();
    const states = s.awareness.getStates();
    for (const m of s.members()) {
      const clientId = m.self ? s.doc.clientID : s.peers.get(m.id)?.clientId;
      const file = clientId !== undefined ? (states.get(clientId)?.file as string | undefined) : undefined;
      const roles = [m.id === s.host()?.id ? "hôte" : null, m.id === leader?.id ? "sauvegarde git" : null].filter(Boolean);
      new Setting(contentEl)
        .setName(`${m.name}${m.self ? " (toi)" : ""}`)
        .setDesc([roles.join(" · "), file ? `sur ${file}` : null].filter(Boolean).join(" — "))
        .addExtraButton(b => {
          if (!file || m.self) return b.extraSettingsEl.hide();
          b.setIcon("arrow-right").setTooltip("Ouvrir la même note").onClick(() => {
            this.close();
            void this.app.workspace.openLinkText(file, "");
          });
        });
    }
    new Setting(contentEl).addButton(b =>
      b.setButtonText("Inviter quelqu'un").onClick(() => {
        this.close();
        (this.app as any).commands.executeCommandById("collab-vault:invite");
      }),
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class InviteModal extends Modal {
  constructor(app: App, readonly room: RoomConfig, readonly vaultName: string, readonly remote: string) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    const link = `obsidian://collab-vault?room=${encodeURIComponent(this.room.room)}&secret=${encodeURIComponent(this.room.secret)}&name=${encodeURIComponent(this.vaultName)}`;
    contentEl.createEl("h3", { text: "Inviter quelqu'un" });

    const gh = this.remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    contentEl.createEl("h4", { text: "Ami·e avec accès au dépôt git (recommandé)" });
    contentEl.createEl("p", {
      text: "Ajoute-le comme collaborateur du dépôt. Après un clone, le plugin et l'invitation sont déjà dans le coffre : il suffit d'ouvrir le dossier dans Obsidian et d'activer les plugins communautaires.",
    });
    if (gh) {
      new Setting(contentEl).setName(`${gh[1]}/${gh[2]}`).addButton(b =>
        b.setButtonText("Ajouter sur GitHub").setCta().onClick(() => window.open(`https://github.com/${gh[1]}/${gh[2]}/settings/access`)),
      );
    }

    contentEl.createEl("h4", { text: "Ami·e sans accès git" });
    contentEl.createEl("p", {
      text: "Il installe le plugin dans un coffre vide, puis clique sur ce lien : les notes arrivent depuis la session (il ne fait pas de sauvegarde git, c'est toi qui t'en charges).",
    });
    new Setting(contentEl)
      .setName("Lien d'invitation")
      .setDesc("Ce lien donne accès au coffre : ne l'envoie qu'à des gens de confiance.")
      .addButton(b =>
        b.setButtonText("Copier").onClick(async () => {
          await navigator.clipboard.writeText(link);
          new Notice("Lien copié !");
        }),
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(app: App, readonly title: string, readonly text: string, readonly onYes: () => void) {
    super(app);
  }
  onOpen() {
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.text });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText("Annuler").onClick(() => this.close()))
      .addButton(b =>
        b.setButtonText("Rejoindre").setCta().onClick(() => {
          this.close();
          this.onYes();
        }),
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, readonly plugin: CollabVault) {
    super(app, plugin);
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveData(s);
    containerEl.empty();

    containerEl.createEl("h3", { text: "Collaboration" });
    new Setting(containerEl)
      .setName("Ton nom")
      .setDesc("Affiché à côté de ton curseur chez les autres (prend effet à la reconnexion).")
      .addText(t => t.setValue(s.name).onChange(v => { s.name = v.trim() || defaultName(); save(); }));
    new Setting(containerEl)
      .setName("Ta couleur")
      .addColorPicker(c => c.setValue(s.color).onChange(v => { s.color = v; save(); }));

    containerEl.createEl("h3", { text: "Sauvegarde git" });
    new Setting(containerEl)
      .setName("Délai avant commit (secondes)")
      .setDesc("Attend ce délai sans nouvelle modification avant de commit/push.")
      .addText(t => t.setValue(String(s.delaySeconds)).onChange(v => {
        const n = parseInt(v, 10);
        if (n > 0) { s.delaySeconds = n; save(); }
      }));
    new Setting(containerEl)
      .setName("Récupérer les changements toutes les (minutes)")
      .setDesc("Pull régulier quand tu es responsable de la sauvegarde.")
      .addText(t => t.setValue(String(s.pullIntervalMin)).onChange(v => {
        const n = parseInt(v, 10);
        if (n > 0) { s.pullIntervalMin = n; save(); }
      }));
    new Setting(containerEl)
      .setName("Message de commit")
      .setDesc("Variables : {{date}}, {{count}}")
      .addText(t => t.setValue(s.commitMessage).onChange(v => { s.commitMessage = v || "vault: {{date}}"; save(); }));
    new Setting(containerEl).setName("Push automatique").addToggle(t => t.setValue(s.push).onChange(v => { s.push = v; save(); }));
    new Setting(containerEl)
      .setName("Pull avant push")
      .addToggle(t => t.setValue(s.pullBeforePush).onChange(v => { s.pullBeforePush = v; save(); }));
    new Setting(containerEl)
      .setName("Synchroniser au démarrage")
      .setDesc("Envoie tes modifs et récupère celles des autres avant de rejoindre la session.")
      .addToggle(t => t.setValue(s.pullOnStartup).onChange(v => { s.pullOnStartup = v; save(); }));
  }
}

// ==================================================================== utilitaires

function allFiles(folder: TFolder): TFile[] {
  return folder.children.flatMap(c => (c instanceof TFolder ? allFiles(c) : c instanceof TFile ? [c] : []));
}

function randomId(bytes: number) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function defaultName() {
  try {
    return require("os").userInfo().username as string;
  } catch {
    return "Anonyme";
  }
}
