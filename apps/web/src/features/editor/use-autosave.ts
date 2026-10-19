import { useEffect } from 'react';
import { useEditorStore } from './editor-store';

const DEBOUNCE_MS = 1200;

/** Debounced autosave plus a leave-page warning while edits are unsaved. */
export function useAutosave() {
  const version = useEditorStore((s) => s.version);
  const saveState = useEditorStore((s) => s.saveState);

  useEffect(() => {
    if (saveState !== 'unsaved') return;
    const t = setTimeout(() => void useEditorStore.getState().save(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [version, saveState]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useEditorStore.getState();
      if (s.version !== s.savedVersion) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}

/** Undo/redo/delete shortcuts. Ignored while typing in a field. */
export function useEditorShortcuts(onTogglePlay: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (typing) return;
      const s = useEditorStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void s.save();
      } else if (e.key === ' ') {
        e.preventDefault();
        onTogglePlay();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection) {
        e.preventDefault();
        const sel = s.selection;
        s.update((t) =>
          sel.type === 'clip'
            ? { ...t, clips: t.clips.filter((c) => c.id !== sel.id) }
            : { ...t, captions: t.captions.filter((c) => c.id !== sel.id) },
        );
        s.select(null);
      } else if (e.key === 'Escape') {
        s.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onTogglePlay]);
}
