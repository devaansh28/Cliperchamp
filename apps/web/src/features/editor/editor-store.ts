import type { Timeline } from '@clipforge/shared';
import { create } from 'zustand';
import { api, ApiError, errorMessage } from '@/lib/api';

export type Selection = { type: 'clip' | 'caption'; id: string } | null;
export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';

const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

interface EditorState {
  projectId: string | null;
  timeline: Timeline | null;
  revision: number;
  past: Timeline[];
  future: Timeline[];
  lastEdit: { key: string; at: number } | null;
  /** Increments on every change; lets autosave know whether a save is still current. */
  version: number;
  savedVersion: number;
  saveState: SaveState;
  saveError: string | null;
  selection: Selection;
  currentMs: number;

  load: (projectId: string, timeline: Timeline, revision: number) => void;
  /** Apply an edit. Edits with the same `coalesceKey` in quick succession share one undo step (slider drags, typing). */
  update: (fn: (t: Timeline) => Timeline, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  select: (selection: Selection) => void;
  setCurrentMs: (ms: number) => void;
  save: () => Promise<boolean>;
}

let inFlight: Promise<boolean> | null = null;

export const useEditorStore = create<EditorState>((set, get) => ({
  projectId: null,
  timeline: null,
  revision: 0,
  past: [],
  future: [],
  lastEdit: null,
  version: 0,
  savedVersion: 0,
  saveState: 'saved',
  saveError: null,
  selection: null,
  currentMs: 0,

  load: (projectId, timeline, revision) =>
    set({ projectId, timeline, revision, past: [], future: [], lastEdit: null, version: 0, savedVersion: 0, saveState: 'saved', saveError: null, selection: null, currentMs: 0 }),

  update: (fn, coalesceKey) => {
    const { timeline, past, lastEdit, version } = get();
    if (!timeline) return;
    const next = fn(timeline);
    if (next === timeline) return;
    const now = Date.now();
    const coalesce = coalesceKey !== undefined && lastEdit?.key === coalesceKey && now - lastEdit.at < COALESCE_MS;
    set({
      timeline: next,
      past: coalesce ? past : [...past, timeline].slice(-HISTORY_LIMIT),
      future: [],
      lastEdit: coalesceKey ? { key: coalesceKey, at: now } : null,
      version: version + 1,
      saveState: get().saveState === 'conflict' ? 'conflict' : 'unsaved',
    });
  },

  undo: () => {
    const { past, future, timeline, version } = get();
    const prev = past[past.length - 1];
    if (!prev || !timeline) return;
    set({ timeline: prev, past: past.slice(0, -1), future: [timeline, ...future], lastEdit: null, version: version + 1, saveState: 'unsaved' });
  },

  redo: () => {
    const { past, future, timeline, version } = get();
    const next = future[0];
    if (!next || !timeline) return;
    set({ timeline: next, past: [...past, timeline], future: future.slice(1), lastEdit: null, version: version + 1, saveState: 'unsaved' });
  },

  select: (selection) => set({ selection }),
  setCurrentMs: (currentMs) => set({ currentMs }),

  /** Saves the current timeline. Serialized: a call during a save waits and then saves again if needed. */
  save: async () => {
    if (inFlight) await inFlight.catch(() => false);
    const { projectId, timeline, revision, version, savedVersion, saveState } = get();
    if (!projectId || !timeline) return false;
    if (saveState === 'conflict') return false;
    if (version === savedVersion) return true;
    set({ saveState: 'saving', saveError: null });
    inFlight = (async () => {
      try {
        const res = await api.saveTimeline(projectId, timeline, revision);
        const stillCurrent = get().version === version;
        set({ revision: res.revision, savedVersion: version, saveState: stillCurrent ? 'saved' : 'unsaved' });
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          set({ saveState: 'conflict', saveError: 'This project changed in another tab. Reload to get the latest version.' });
        } else {
          set({ saveState: 'error', saveError: errorMessage(err) });
        }
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));
