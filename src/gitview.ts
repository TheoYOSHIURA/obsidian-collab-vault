// Panneau latéral « Sauvegarde git » : état, fichiers pas encore envoyés, historique.
import { ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type CollabVault from "./main";
import type { Change, GitInfo } from "./git";

export const GIT_VIEW = "collab-vault-git";
const FETCH_EVERY_MS = 60_000;

const KIND_LABEL: Record<Change["kind"], string> = {
  M: "modifié",
  A: "ajouté",
  D: "supprimé",
  R: "renommé",
  "?": "nouveau",
};

export class GitView extends ItemView {
  private info: GitInfo | null = null;
  private loading = false;
  private again = false;
  private lastFetch = 0;
  private expanded = new Set<string>();
  private countdownEl: HTMLElement | null = null;
  private githubUrl: string | null = null;

  constructor(leaf: WorkspaceLeaf, readonly plugin: CollabVault) {
    super(leaf);
  }

  getViewType() {
    return GIT_VIEW;
  }
  getDisplayText() {
    return "Sauvegarde git";
  }
  getIcon() {
    return "git-branch";
  }

  async onOpen() {
    this.contentEl.addClass("cv-git");
    const remote = this.plugin.git ? await this.plugin.git.remoteUrl() : "";
    const gh = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
    this.githubUrl = gh ? `https://github.com/${gh[1]}/${gh[2]}` : null;
    this.registerInterval(window.setInterval(() => this.tickCountdown(), 1000));
    this.registerInterval(window.setInterval(() => void this.refresh(), 30_000));
    void this.refresh(true);
  }

  /** Relit l'état git. Les appels rapprochés sont regroupés. */
  async refresh(fetch = false) {
    const git = this.plugin.git;
    if (!git) return this.render();
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    try {
      // Les invité·es ne font pas de pull : un fetch suffit pour voir ce qu'a envoyé le responsable.
      if (fetch || Date.now() - this.lastFetch > FETCH_EVERY_MS) {
        this.lastFetch = Date.now();
        await git.fetch();
      }
      this.info = await git.info();
    } catch (e) {
      console.warn("[collab-vault] état git", e);
    } finally {
      this.loading = false;
    }
    this.render();
    if (this.again) {
      this.again = false;
      void this.refresh();
    }
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    this.countdownEl = null;
    const p = this.plugin;
    const git = p.git;

    const head = el.createDiv("cv-head");
    head.createEl("h4", { text: "Sauvegarde git" });
    const refreshBtn = head.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Rafraîchir" } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.onclick = () => void this.refresh(true);

    const s = p.session;
    const leader = s?.seeded ? s.gitLeader() : undefined;
    if (!git) {
      const box = el.createDiv("cv-card");
      box.createDiv({ text: "Ce coffre n'utilise pas git." });
      if (leader) box.createDiv({ cls: "cv-muted", text: `${leader.name} sauvegarde la session.` });
      else if (s?.seeded) box.createDiv({ cls: "cv-warn", text: "Personne avec git n'est connecté : rien n'est sauvegardé." });
      return;
    }
    const info = this.info;
    if (!info) {
      el.createDiv({ cls: "cv-muted", text: "Chargement…" });
      return;
    }

    // --- carte d'état
    const card = el.createDiv("cv-card");
    const amLeader = p.isGitLeader();
    const pending = info.changes.length;
    const line = card.createDiv("cv-state");
    if (git.lastError) {
      line.addClass("cv-warn");
      setIcon(line.createSpan("cv-icon"), "alert-triangle");
      line.createSpan({ text: "Erreur" });
      card.createDiv({ cls: "cv-error", text: git.lastError.message });
    } else if (git.status.includes("…")) {
      setIcon(line.createSpan("cv-icon"), "loader");
      line.createSpan({ text: git.status.replace(/^git: /, "") });
    } else if (pending === 0 && info.ahead === 0) {
      line.addClass("cv-ok");
      setIcon(line.createSpan("cv-icon"), "check-circle");
      line.createSpan({ text: "Tout est sur GitHub" });
    } else {
      setIcon(line.createSpan("cv-icon"), "clock");
      line.createSpan({ text: `${pending || info.ahead} ${pending ? "fichier(s)" : "commit(s)"} en attente` });
    }
    this.countdownEl = card.createDiv("cv-muted");
    this.tickCountdown();

    const role = card.createDiv("cv-muted");
    if (amLeader) role.setText(s?.seeded && s.members().length > 1 ? "C'est toi qui sauvegardes la session." : "Sauvegarde automatique activée.");
    else if (leader) role.setText(`${leader.name} sauvegarde la session : tes modifs partent avec les siennes.`);
    else if (s && !s.seeded) role.setText("Connexion à la session…");

    const sync = card.createDiv("cv-muted");
    const bits = [`branche ${info.branch}`];
    if (!info.upstream) bits.push("pas de dépôt distant suivi");
    if (info.behind) bits.push(`${info.behind} commit(s) à récupérer`);
    if (info.ahead) bits.push(`${info.ahead} commit(s) à envoyer`);
    if (git.lastOk) bits.push(`dernière synchro ${ago(git.lastOk)}`);
    sync.setText(bits.join(" · "));

    const actions = card.createDiv("cv-actions");
    const pushBtn = actions.createEl("button", { text: "Commit & push", cls: amLeader ? "mod-cta" : "" });
    pushBtn.disabled = !amLeader;
    if (!amLeader) pushBtn.title = "Pendant la session, seul le responsable git envoie les changements.";
    pushBtn.onclick = async () => {
      pushBtn.disabled = true;
      await p.git?.sync(true);
      await this.refresh(true);
    };
    const pullBtn = actions.createEl("button", { text: "Récupérer" });
    pullBtn.disabled = !amLeader;
    pullBtn.onclick = async () => {
      pullBtn.disabled = true;
      await p.git?.pull();
      await this.refresh(true);
    };

    // --- fichiers pas encore sur GitHub
    const changesSec = this.section(el, `Pas encore sur GitHub (${pending})`, "upload-cloud");
    if (!pending) changesSec.createDiv({ cls: "cv-muted cv-pad", text: "Rien en attente." });
    for (const c of info.changes.slice(0, 200)) this.fileRow(changesSec, c);
    if (pending > 200) changesSec.createDiv({ cls: "cv-muted cv-pad", text: `… et ${pending - 200} autres` });

    // --- historique
    const logSec = this.section(el, "Historique", "history");
    for (const c of info.log) {
      const row = logSec.createDiv("cv-commit");
      const top = row.createDiv("cv-commit-top");
      const chevron = top.createSpan("cv-icon cv-chevron");
      setIcon(chevron, this.expanded.has(c.hash) ? "chevron-down" : "chevron-right");
      top.createSpan({ cls: "cv-subject", text: c.subject });
      if (!c.pushed) top.createSpan({ cls: "cv-badge", text: "pas envoyé" });
      row.createDiv({ cls: "cv-muted cv-meta", text: `${c.author} · ${ago(c.at)} · ${c.hash.slice(0, 7)}` });
      const files = row.createDiv("cv-files");
      const toggle = async () => {
        if (this.expanded.has(c.hash)) {
          this.expanded.delete(c.hash);
          files.empty();
          setIcon(chevron, "chevron-right");
          return;
        }
        this.expanded.add(c.hash);
        setIcon(chevron, "chevron-down");
        await this.fillCommit(files, c.hash, c.pushed);
      };
      top.onclick = () => void toggle();
      if (this.expanded.has(c.hash)) void this.fillCommit(files, c.hash, c.pushed);
    }
  }

  private async fillCommit(files: HTMLElement, hash: string, pushed: boolean) {
    files.empty();
    const list = await this.plugin.git!.commitFiles(hash).catch(() => [] as Change[]);
    for (const f of list) this.fileRow(files, f);
    if (this.githubUrl && pushed) {
      const a = files.createEl("a", { text: "Voir sur GitHub", href: `${this.githubUrl}/commit/${hash}`, cls: "cv-link" });
      a.setAttr("target", "_blank");
    }
  }

  private section(el: HTMLElement, title: string, icon: string) {
    const sec = el.createDiv("cv-section");
    const h = sec.createDiv("cv-section-title");
    setIcon(h.createSpan("cv-icon"), icon);
    h.createSpan({ text: title });
    return sec;
  }

  private fileRow(parent: HTMLElement, c: Change) {
    const row = parent.createDiv({ cls: "cv-file", attr: { "aria-label": KIND_LABEL[c.kind] } });
    row.createSpan({ cls: `cv-kind cv-kind-${c.kind === "?" ? "N" : c.kind}`, text: c.kind === "?" ? "N" : c.kind });
    const name = c.path.split("/").pop()!;
    const dir = c.path.slice(0, c.path.length - name.length);
    row.createSpan({ cls: "cv-name", text: name });
    if (dir || c.from) row.createSpan({ cls: "cv-dir", text: c.from ? `← ${c.from}` : dir });
    row.onclick = () => {
      const f = this.app.vault.getAbstractFileByPath(c.path);
      if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
      else new Notice(c.kind === "D" ? "Ce fichier a été supprimé." : "Fichier introuvable dans le coffre.");
    };
  }

  private tickCountdown() {
    if (!this.countdownEl) return;
    const due = this.plugin.gitDueAt;
    if (due && this.plugin.isGitLeader()) {
      const sec = Math.max(0, Math.ceil((due - Date.now()) / 1000));
      this.countdownEl.setText(`Commit automatique dans ${sec} s`);
      this.countdownEl.show();
    } else this.countdownEl.hide();
  }
}

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(t).toLocaleDateString("fr-FR");
}
