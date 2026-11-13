import {
  App,
  FileSystemAdapter,
  Platform,
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
import { Git, GitBase } from "./git";
import { MobileGit } from "./mobilegit";
import { MobileGitSetupModal } from "./mobilesetup";
import { obsidianFs, obsidianHttp } from "./obsfs";
import { findGit, GitSetup, GitSetupModal } from "./gitsetup";
import { GIT_VIEW, GitView } from "./gitview";
import { BaseStore, Disk, isText, Session } from "./session";
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
  /** Chemin de git trouvé (Windows : souvent hors du PATH juste après l'installation). */
  gitPath: string;
  /** Téléphone : dépôt, jeton GitHub et identité des commits (jamais versionnés). */
  mobileRepo: string;
  githubToken: string;
  authorName: string;
  authorEmail: string;
  /** L'assistant git a déjà été proposé pour ce coffre (on ne le propose qu'une fois). */
  gitSetupOffered: boolean;
}

interface RoomConfig {
  room: string;
  secret: string;
  /** Adresse https du dépôt, pour pré-remplir la config git des téléphones. */
  repo?: string;
}

export default class CollabVault extends Plugin {
  /** Pour les tests de bout en bout (simuler un téléphone). */
  static platform = Platform;
  declare settings: Settings;
  cwd = "";
  git: GitBase | null = null;
  session: Session | null = null;
  transport: TrysteroTransport | null = null;
  binder = new EditorBinder();
  statusBar!: HTMLElement;
  private gitTimer: number | null = null;
  /** Heure prévue du prochain commit automatique (pour le compte à rebours du panneau). */
  gitDueAt: number | null = null;
  private viewTimer: number | null = null;
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
        gitPath: "",
        mobileRepo: "",
        githubToken: "",
        authorName: "",
        authorEmail: "",
        gitSetupOffered: false,
      },
      await this.loadData(),
    );
    await this.saveData(this.settings);

    // Sur Android/iOS il n'y a pas de dossier accessible ni de git : collaboration seule.
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) this.cwd = adapter.getBasePath();

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.onClickEvent(() => new MembersModal(this.app, this).open());
    this.registerEditorExtension(this.binder.extension());
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerCommands();
    this.registerObsidianProtocolHandler("collab-vault", params => this.handleInviteLink(params));
    this.addRibbonIcon("users", "Collab Vault : qui est là ?", () => new MembersModal(this.app, this).open());
    this.registerView(GIT_VIEW, leaf => new GitView(leaf, this));
    this.addRibbonIcon("git-branch", "Collab Vault : état de la sauvegarde git", () => void this.openGitView());

    this.app.workspace.onLayoutReady(() => void this.startup());
  }

  async openGitView() {
    const existing = this.app.workspace.getLeavesOfType(GIT_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: GIT_VIEW, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  /** Rafraîchit le panneau git (regroupé : au plus une fois toutes les 1,5 s). */
  refreshGitView(now = false) {
    const views = this.app.workspace.getLeavesOfType(GIT_VIEW).map(l => l.view).filter(v => v instanceof GitView);
    if (!views.length) return;
    if (this.viewTimer) window.clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => {
      this.viewTimer = null;
      for (const v of views) void v.refresh();
    }, now ? 0 : 1500);
  }

  onunload() {
    if (this.viewTimer) window.clearTimeout(this.viewTimer);
    if (this.gitTimer) window.clearTimeout(this.gitTimer);
    this.binder.unbindAll(this.app);
    void this.session?.stop();
  }

  // ------------------------------------------------------------------ démarrage

  /** Le dossier du coffre contient-il un dépôt git ? (indépendamment de git installé ou non) */
  hasRepoFolder() {
    if (!this.cwd || !Platform.isDesktopApp) return false;
    try {
      return (require("fs") as typeof import("fs")).existsSync(this.cwd + "/.git");
    } catch {
      return false;
    }
  }

  /** Détecte git et prépare la sauvegarde. Renvoie le chemin de git (ou null). */
  private ignored() {
    return [
      ".obsidian/workspace.json",
      ".obsidian/workspace-mobile.json",
      // Créé quand on ouvre par erreur le dossier .obsidian comme un coffre.
      ".obsidian/.obsidian/",
      `${this.manifest.dir}/data.json`,
      `${this.manifest.dir}/base-*.json`,
    ];
  }

  private gitCallbacks() {
    return [
      () => this.settings,
      () => {
        this.updateStatus();
        this.refreshGitView(true);
      },
      (msg: string, auth: boolean) => this.gitError(msg, auth),
    ] as const;
  }

  private mobileGit() {
    return new MobileGit(
      {
        fs: obsidianFs(this.app),
        http: obsidianHttp,
        dir: "/",
        token: () => this.settings.githubToken,
        author: () => ({
          name: this.settings.authorName || this.settings.name,
          email: this.settings.authorEmail || "mobile@collab-vault",
        }),
      },
      ...this.gitCallbacks(),
    );
  }

  async initGit(): Promise<string | null> {
    this.git = null;
    if (!Platform.isDesktopApp) {
      // Téléphone : git intégré, seulement si un jeton est configuré.
      if (!this.settings.githubToken) return null;
      const mg = this.mobileGit();
      if (!(await mg.isRepo())) return null;
      this.git = mg;
      await mg.ensureIgnored(this.ignored());
      return "mobile";
    }
    if (!this.cwd) return null;
    const bin = await findGit(this.settings.gitPath || undefined);
    if (bin && bin !== this.settings.gitPath) {
      this.settings.gitPath = bin;
      await this.saveData(this.settings);
    }
    if (!bin) return null;
    const git = new Git(this.cwd, bin, ...this.gitCallbacks());
    if (await git.isRepo()) {
      this.git = git;
      await git.ensureIgnored(this.ignored());
    }
    return bin;
  }

  private lastAuthNotice = 0;
  private gitError(msg: string, auth: boolean) {
    if (!auth) return void new Notice("Collab Vault : erreur git\n" + msg, 10000);
    if (Date.now() - this.lastAuthNotice < 10 * 60 * 1000) return; // pas de rafale
    this.lastAuthNotice = Date.now();
    this.noticeWithButton("Collab Vault : la sauvegarde ne peut pas se connecter à GitHub.", "Se connecter", () =>
      this.openGitSetup(),
    );
  }

  noticeWithButton(text: string, label: string, onClick: () => void) {
    const frag = document.createDocumentFragment();
    frag.createDiv({ text });
    const btn = frag.createEl("button", { text: label, cls: "mod-cta" });
    btn.style.marginTop = "8px";
    const n = new Notice(frag, 0);
    btn.onclick = () => {
      n.hide();
      onClick();
    };
  }

  openGitSetup() {
    if (!Platform.isDesktopApp) return void this.openMobileGitSetup();
    new GitSetupModal(this.app, {
      cwd: this.cwd,
      hasRepo: () => this.hasRepoFolder(),
      gitBin: () => this.settings.gitPath || null,
      redetect: async () => {
        const bin = await findGit(this.settings.gitPath || undefined);
        this.settings.gitPath = bin ?? "";
        await this.saveData(this.settings);
        return bin;
      },
      setGitPath: async path => {
        // findGit renvoie un autre git si celui-ci ne marche pas : on ne garde que le chemin demandé.
        if ((await findGit(path)) !== path) return null;
        this.settings.gitPath = path;
        await this.saveData(this.settings);
        await this.reloadGit(true);
        return path;
      },
      onReady: force => void this.reloadGit(force),
    }).open();
  }

  private async openMobileGitSetup() {
    const room = await this.readRoom();
    const s = this.settings;
    new MobileGitSetupModal(this.app, {
      repo: s.mobileRepo || room?.repo || (this.git ? await this.git.remoteUrl() : ""),
      token: s.githubToken,
      name: s.authorName || s.name,
      email: s.authorEmail,
      connected: !!this.git,
      save: async (v, onProgress) => {
        Object.assign(s, { mobileRepo: v.repo, githubToken: v.token, authorName: v.name, authorEmail: v.email });
        await this.saveData(s);
        const mg = this.mobileGit();
        await mg.connect(v.repo, onProgress);
        await mg.ensureIgnored(this.ignored());
        this.git = null; // pour que reloadGit relance la session avec le rôle git
        await this.reloadGit();
      },
      disconnect: async () => {
        s.githubToken = "";
        await this.saveData(s);
        this.git = null;
        await this.reloadGit(true);
      },
    }).open();
  }

  /** Après installation / connexion : on relance git et on se réannonce dans la session (rôle git). */
  private reloading = false;
  async reloadGit(force = false) {
    if (this.reloading) return;
    const hadGit = !!this.git;
    this.reloading = true;
    try {
      await this.initGit();
      if ((this.git && !hadGit) || force) {
        if (this.git && this.isGitLeader()) await this.git.sync(true);
        if (this.session) {
          await this.stopSession();
          await this.startSession();
        }
      }
      this.updateStatus();
      this.refreshGitView(true);
    } finally {
      this.reloading = false;
    }
  }

  private async startup() {
    const bin = await this.initGit();
    if (this.hasRepoFolder() && !bin) {
      this.noticeWithButton(
        "Collab Vault : ce coffre est un dépôt git, mais git n'est pas installé sur cet ordinateur. Sans lui, tes modifs ne sont sauvegardées que si quelqu'un d'autre est connecté.",
        "Installer / configurer git",
        () => this.openGitSetup(),
      );
    } else if (bin && !this.git && !this.hasRepoFolder() && !this.settings.gitSetupOffered) {
      // Coffre neuf : on propose une fois de le sauvegarder avec git.
      this.settings.gitSetupOffered = true;
      await this.saveData(this.settings);
      this.noticeWithButton(
        "Collab Vault : ce coffre n'est pas encore sauvegardé avec git. L'assistant peut créer le dépôt et le relier à GitHub.",
        "Configurer la sauvegarde",
        () => this.openGitSetup(),
      );
    } else if (this.git instanceof Git) {
      // Vérifie la connexion GitHub en arrière-plan (sans fenêtre).
      void new GitSetup(this.git.bin, this.cwd).checkAccess().then(r => {
        if (!r.ok) this.gitError(r.message, true);
      });
    } else if (this.git instanceof MobileGit) {
      void MobileGit.checkAccess(obsidianHttp, await this.git.remoteUrl(), this.settings.githubToken).then(r => {
        if (!r.ok) this.gitError(r.message, true);
      });
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

    // Invitation reçue par git pendant qu'Obsidian est ouvert : on la remarque en quelques secondes.
    this.registerInterval(window.setInterval(() => void this.checkRoom(), 10 * 1000));

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
    if (!r.repo) {
      const url = this.git ? await this.git.remoteUrl() : "";
      // Adresse https publique uniquement (sans identifiant), pour les téléphones.
      if (/^https?:\/\//.test(url)) r.repo = url.replace(/\/\/[^@/]+@/, "//");
      else if (/^git@github\.com:/.test(url)) r.repo = url.replace(/^git@github\.com:/, "https://github.com/");
    }
    if (!(await this.app.vault.adapter.exists(".collab"))) await this.app.vault.adapter.mkdir(".collab");
    await this.app.vault.adapter.write(ROOM_FILE, JSON.stringify(r, null, 2) + "\n");
  }

  private lastNetworkNotice = 0;
  /**
   * Un membre est trouvé (via les relais) mais la connexion directe échoue : souvent un réseau
   * trop fermé (école, entreprise). On le dit, sinon on croit être dans la session alors qu'on est seul.
   */
  private networkError(e: unknown) {
    console.warn("[collab-vault] réseau", e);
    if ((e as any)?.code !== "peer-connect-failed") return;
    if (Date.now() - this.lastNetworkNotice < 10 * 60 * 1000) return;
    this.lastNetworkNotice = Date.now();
    new Notice(
      "Collab Vault : impossible de se connecter directement à un autre membre. Le réseau de cet ordinateur " +
        "bloque sans doute les connexions directes (réseau d'école ou d'entreprise). Tes modifs passent quand même " +
        "par GitHub, avec quelques minutes de délai.",
      15000,
    );
  }

  /** Identifiant de la session en cours (pour voir si room.json a changé). */
  private currentRoom: string | null = null;
  /** Dernier échec de connexion : on ne réessaie pas en boucle. */
  private startFailedAt = 0;

  /**
   * room.json peut arriver ou changer par git (activation ou nouvelle clé faite par un autre
   * membre) : on rejoint alors la session sans attendre un redémarrage d'Obsidian.
   */
  async checkRoom() {
    if (this.starting || Date.now() - this.startFailedAt < 5 * 60 * 1000) return;
    const room = await this.readRoom();
    if (!room) return;
    if (!this.session) {
      console.log("[collab-vault] invitation trouvée dans le coffre : on rejoint la session");
      return this.startSession();
    }
    if (this.currentRoom && room.room !== this.currentRoom) {
      console.log("[collab-vault] la clé du coffre a changé : on rejoint la nouvelle session");
      await this.stopSession();
      await this.startSession();
    }
  }

  async startSession() {
    if (this.session || this.starting) return;
    const room = await this.readRoom();
    if (!room) return;
    this.starting = true;
    this.updateStatus();
    try {
      const transport = await TrysteroTransport.connect(room.room, room.secret);
      this.currentRoom = room.room;
      this.startFailedAt = 0;
      const session = new Session(
        transport,
        this.disk(),
        {
          name: this.settings.name,
          color: this.settings.color,
          git: !!this.git,
          gitMobile: !!this.git?.mobile,
          joinTimeoutMs: 5000,
          base: this.baseStore(room.room),
        },
        {
          isBound: p => this.binder.isBound(p),
          onStructure: () => this.rebind(),
          onPeers: () => this.onPeersChanged(),
          log: (...a) => console.log("[collab-vault]", ...a),
        },
      );
      transport.onFile((op, data, from) => void this.onRemoteFile(op, data, from));
      transport.onRekey((cfg, from) => void this.onRemoteRekey(cfg, from));
      transport.onError(e => this.networkError(e));
      this.transport = transport;
      this.session = session;
      session.start();
      session.setActiveFile(this.app.workspace.getActiveFile()?.path ?? null);
    } catch (e: any) {
      this.startFailedAt = Date.now();
      new Notice("Collab Vault : connexion impossible\n" + e.message, 10000);
      console.error(e);
    } finally {
      this.starting = false;
      this.updateStatus();
    }
  }

  /**
   * Change la clé du coffre. Les membres connectés (sauf `exclude`) reçoivent la nouvelle
   * directement ; les autres la récupèrent par git au prochain démarrage.
   */
  async rotateKey(exclude?: string) {
    const s = this.session;
    const cfg = { room: randomId(12), secret: randomId(24) };
    let sent = 0;
    if (s?.seeded && this.transport) {
      for (const m of s.members()) {
        if (m.self || m.id === exclude) continue;
        await this.transport.sendRekey(cfg, m.id);
        sent++;
      }
    }
    await this.switchRoom(cfg);
    new Notice(
      `Clé du coffre changée (${sent} membre(s) connecté(s) suivent).` +
        (this.git ? " Les membres avec git la recevront au prochain démarrage." : "") +
        " Les amis sans git devront recevoir un nouveau lien.",
      10000,
    );
  }

  private async onRemoteRekey(cfg: RoomConfig, from: string) {
    const s = this.session;
    if (!cfg?.room || !cfg?.secret || !s?.seeded || s.peers.get(from)?.origin !== s.origin) return;
    new Notice(`Collab Vault : ${s.peers.get(from)?.name ?? "un membre"} a changé la clé du coffre.`);
    await this.switchRoom(cfg);
  }

  private async switchRoom(cfg: RoomConfig) {
    await this.stopSession();
    await this.writeRoom(cfg);
    await this.startSession();
    this.scheduleGit(); // .collab/ est caché : pas d'évènement du coffre, on prévoit le commit nous-mêmes
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
        this.gitDueAt = null;
      }
    }
    this.wasLeader = leader;
    this.updateStatus();
    this.refreshGitView();
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
    this.refreshGitView();
    if (!this.git || !this.isGitLeader()) return;
    if (this.gitTimer) window.clearTimeout(this.gitTimer);
    const delay = Math.max(1, this.settings.delaySeconds) * 1000;
    this.gitDueAt = Date.now() + delay;
    this.gitTimer = window.setTimeout(() => {
      this.gitTimer = null;
      this.gitDueAt = null;
      if (this.isGitLeader()) void this.git!.sync();
    }, delay);
    this.updateStatus("git: modifs en attente…");
  }

  // ------------------------------------------------------------------ disque

  /** Dernière version partagée, gardée sur cet appareil (hors git) pour fusionner les modifs hors ligne. */
  private baseStore(room: string): BaseStore {
    const path = `${this.manifest.dir}/base-${room.replace(/[^\w-]/g, "")}.json`;
    const a = this.app.vault.adapter;
    return {
      load: async () => ((await a.exists(path)) ? JSON.parse(await a.read(path)) : null),
      save: async texts => a.write(path, JSON.stringify(texts)),
    };
  }

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
      id: "rotate-key",
      name: "Changer la clé du coffre (retirer quelqu'un)",
      callback: async () => {
        if (!(await this.readRoom())) return new Notice("La collaboration n'est pas activée ici.");
        new ConfirmModal(
          this.app,
          "Changer la clé du coffre ?",
          "Les personnes connectées et celles qui ont accès au dépôt git recevront la nouvelle clé. Pour retirer quelqu'un, enlève-le d'abord du dépôt GitHub. Les amis sans git devront recevoir un nouveau lien d'invitation.",
          () => void this.rotateKey(),
          "Changer la clé",
        ).open();
      },
    });
    this.addCommand({ id: "git-setup", name: "Configurer git et la connexion GitHub", callback: () => this.openGitSetup() });
    this.addCommand({ id: "git-view", name: "Afficher l'état de la sauvegarde git", callback: () => void this.openGitView() });
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
    const { room, secret, name, repo } = params;
    if (!room || !secret) return new Notice("Lien d'invitation invalide.");
    new ConfirmModal(
      this.app,
      `Rejoindre « ${name ?? "coffre partagé"} » ?`,
      `Ce coffre (« ${this.app.vault.getName()} ») sera synchronisé avec la session : les notes partagées y seront écrites et remplacent les versions locales qui portent le même nom.`,
      async () => {
        await this.stopSession();
        await this.writeRoom({ room, secret, repo: repo || undefined });
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
        })
        .addExtraButton(b => {
          if (m.self) return b.extraSettingsEl.hide();
          b.setIcon("user-x").setTooltip(`Retirer ${m.name} du coffre`).onClick(() => {
            this.close();
            new ConfirmModal(
              this.app,
              `Retirer ${m.name} ?`,
              `La clé du coffre est changée et envoyée à tout le monde sauf ${m.name}, qui se retrouve seul·e dans l'ancienne session. ` +
                `Retire-le aussi du dépôt GitHub, sinon il récupérera la nouvelle clé par git. ` +
                `Il garde la copie des notes qu'il a déjà sur son ordinateur.`,
              () => void this.plugin.rotateKey(m.id),
              "Retirer",
              true,
            ).open();
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
    const link =
      `obsidian://collab-vault?room=${encodeURIComponent(this.room.room)}&secret=${encodeURIComponent(this.room.secret)}` +
      `&name=${encodeURIComponent(this.vaultName)}` +
      (this.room.repo ? `&repo=${encodeURIComponent(this.room.repo)}` : "");
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
  constructor(
    app: App,
    readonly title: string,
    readonly text: string,
    readonly onYes: () => void,
    readonly yesLabel = "Rejoindre",
    readonly danger = false,
  ) {
    super(app);
  }
  onOpen() {
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.text });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText("Annuler").onClick(() => this.close()))
      .addButton(b =>
        (this.danger ? b.setWarning() : b.setCta()).setButtonText(this.yesLabel).onClick(() => {
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
      .setName("Git et connexion GitHub")
      .setDesc(
        !Platform.isDesktopApp
          ? this.plugin.git
            ? "Sauvegarde git intégrée active (jeton GitHub). Les ordinateurs de la session sauvegardent en priorité."
            : "Optionnel : branche ce téléphone sur le dépôt avec un jeton GitHub pour qu'il sauvegarde quand il est seul."
          : this.plugin.git
            ? `git : ${this.plugin.git.label}`
            : "Git n'est pas prêt sur cet ordinateur.",
      )
      .addButton(b => b.setButtonText("Ouvrir l'assistant").setCta().onClick(() => this.plugin.openGitSetup()));
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
  if (!Platform.isDesktopApp) return Platform.isAndroidApp ? "Android" : Platform.isIosApp ? "iPhone" : "Mobile";
  try {
    return require("os").userInfo().username as string;
  } catch {
    return "Anonyme";
  }
}
