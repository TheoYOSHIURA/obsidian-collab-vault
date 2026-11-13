// Assistant git sur téléphone : adresse du dépôt + jeton GitHub, puis branchement du coffre.
import { App, Modal, Notice, Setting } from "obsidian";
import { MobileGit } from "./mobilegit";
import { obsidianHttp } from "./obsfs";

export interface MobileSetupCtx {
  repo: string;
  token: string;
  name: string;
  email: string;
  /** Enregistre les réglages et branche le coffre sur le dépôt. */
  save: (v: { repo: string; token: string; name: string; email: string }, onProgress: (s: string) => void) => Promise<void>;
  disconnect: () => Promise<void>;
  connected: boolean;
}

export class MobileGitSetupModal extends Modal {
  constructor(app: App, readonly ctx: MobileSetupCtx) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Sauvegarde git sur ce téléphone");
    const el = this.contentEl;
    const v = { repo: this.ctx.repo, token: this.ctx.token, name: this.ctx.name, email: this.ctx.email };

    el.createEl("p", {
      text: "Seul, le téléphone envoie lui-même ses modifications sur GitHub. Dès qu'un ordinateur est dans la session, c'est lui qui sauvegarde.",
    });
    if (this.ctx.connected) el.createEl("p", { text: "✅ Ce coffre est branché sur le dépôt.", cls: "cv-ok" });

    new Setting(el)
      .setName("Adresse du dépôt")
      .setDesc("Ex. https://github.com/pseudo/coffre.git")
      .addText(t => t.setPlaceholder("https://github.com/…").setValue(v.repo).onChange(x => (v.repo = x.trim())));

    const tokenSetting = new Setting(el).setName("Jeton GitHub").addText(t => {
      t.inputEl.type = "password";
      t.setPlaceholder("github_pat_…").setValue(v.token).onChange(x => (v.token = x.trim()));
    });
    const desc = tokenSetting.descEl;
    desc.appendText("Jeton « fine-grained » limité à ce dépôt, avec le droit ");
    desc.createEl("b", { text: "Contents : Read and write" });
    desc.appendText(". ");
    const a = desc.createEl("a", { text: "Créer un jeton", href: "https://github.com/settings/personal-access-tokens/new" });
    a.setAttr("target", "_blank");
    desc.appendText(" (il reste sur ce téléphone, jamais dans le dépôt).");

    new Setting(el)
      .setName("Ton nom pour les sauvegardes")
      .addText(t => t.setPlaceholder("Prénom").setValue(v.name).onChange(x => (v.name = x.trim())))
      .addText(t => t.setPlaceholder("e-mail").setValue(v.email).onChange(x => (v.email = x.trim())));

    const status = el.createDiv({ cls: "cv-muted" });
    new Setting(el)
      .addButton(b => {
        if (!this.ctx.connected) return b.buttonEl.hide();
        b.setButtonText("Débrancher").setWarning().onClick(async () => {
          await this.ctx.disconnect();
          new Notice("Sauvegarde git désactivée sur ce téléphone (le dossier .git est conservé).");
          this.close();
        });
      })
      .addButton(b =>
        b
          .setButtonText(this.ctx.connected ? "Enregistrer" : "Brancher sur le dépôt")
          .setCta()
          .onClick(async () => {
            if (!/^https:\/\/|^http:\/\//.test(v.repo)) return new Notice("Adresse du dépôt en https:// attendue.");
            if (!v.token) return new Notice("Colle un jeton GitHub.");
            if (!v.name || !v.email) return new Notice("Indique un nom et un e-mail.");
            b.setDisabled(true);
            status.setText("Vérification du jeton…");
            const access = await MobileGit.checkAccess(obsidianHttp, v.repo, v.token);
            if (!access.ok) {
              status.setText("❌ " + access.message);
              b.setDisabled(false);
              return;
            }
            try {
              await this.ctx.save(v, s => status.setText(s));
              new Notice("Coffre branché sur le dépôt ✅");
              this.close();
            } catch (e: any) {
              status.setText("❌ " + (e?.message ?? e));
              b.setDisabled(false);
            }
          }),
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
