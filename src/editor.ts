// Relie chaque éditeur Markdown ouvert au Y.Text de sa note : édition partagée + curseurs des autres.
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { App, MarkdownView } from "obsidian";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import type * as Y from "yjs";
import { isText, Session } from "./session";

interface Binding {
  path: string;
  ytext: Y.Text;
  ext: unknown;
}

export class EditorBinder {
  private comp = new Compartment();
  private bound = new Map<EditorView, Binding>();

  /** À enregistrer avec registerEditorExtension. */
  extension() {
    return [
      this.comp.of([]),
      // Les modifs des autres ne vont pas dans l'historique local : Ctrl+Z n'annule que les tiennes.
      EditorState.transactionExtender.of(tr =>
        tr.annotation(ySyncAnnotation) !== undefined ? { annotations: Transaction.addToHistory.of(false) } : null,
      ),
    ];
  }

  private views(app: App): { cm: EditorView; path: string | null }[] {
    return app.workspace.getLeavesOfType("markdown").flatMap(leaf => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return [];
      const cm = (view.editor as any)?.cm as EditorView | undefined;
      return cm ? [{ cm, path: view.file?.path ?? null }] : [];
    });
  }

  private isLive(cm: EditorView, b: Binding) {
    return cm.dom.isConnected && this.comp.get(cm.state) === b.ext;
  }

  isBound(path: string) {
    for (const [cm, b] of this.bound) if (b.path === path && this.isLive(cm, b)) return true;
    return false;
  }

  bindAll(app: App, session: Session | null) {
    const seen = new Set<EditorView>();
    for (const { cm, path } of this.views(app)) {
      seen.add(cm);
      const ytext = session?.seeded && path && isText(path) ? session.getText(path) : undefined;
      const b = this.bound.get(cm);
      if (ytext && b && b.ytext === ytext && b.path === path && this.isLive(cm, b)) continue;

      if (!ytext || !session) {
        if (b) {
          if (this.comp.get(cm.state) === b.ext) cm.dispatch({ effects: this.comp.reconfigure([]) });
          this.bound.delete(cm);
        }
        continue;
      }
      // 1. On retire l'ancienne liaison : sinon CodeMirror garde les instances des plugins
      //    y-codemirror (même extension) encore reliées à l'ancien Y.Text (ex. après un renommage).
      const current = this.comp.get(cm.state) as unknown[] | undefined;
      if (current && current.length) cm.dispatch({ effects: this.comp.reconfigure([]) });
      // 2. L'éditeur prend le contenu partagé, 3. on branche la synchro.
      const text = ytext.toString();
      if (cm.state.doc.toString() !== text) {
        cm.dispatch({
          changes: { from: 0, to: cm.state.doc.length, insert: text },
          annotations: Transaction.addToHistory.of(false),
        });
      }
      const ext = [yCollab(ytext, session.awareness), Prec.highest(keymap.of(yUndoManagerKeymap))];
      cm.dispatch({ effects: this.comp.reconfigure(ext) });
      this.bound.set(cm, { path: path!, ytext, ext });
    }
    for (const cm of Array.from(this.bound.keys())) if (!seen.has(cm)) this.bound.delete(cm);
  }

  unbindAll(app: App) {
    for (const [cm, b] of this.bound) {
      if (this.comp.get(cm.state) === b.ext) cm.dispatch({ effects: this.comp.reconfigure([]) });
    }
    this.bound.clear();
  }
}
