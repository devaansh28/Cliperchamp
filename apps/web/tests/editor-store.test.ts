import { CaptionStyleSchema, type Timeline } from '@clipforge/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/features/editor/editor-store';
import { addClip, clipForAsset, insertCaption, patchCaption, reorderVideoClip } from '@/features/editor/timeline-ops';
import { api, ApiError, type MediaAssetWithUrl } from '@/lib/api';

const base: Timeline = {
  clips: [],
  captions: [],
  captionStyle: CaptionStyleSchema.parse({}),
  output: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
  backgroundColor: '#000000',
};

function asset(id: string, kind: 'video' | 'image' | 'audio', durationMs: number | null): MediaAssetWithUrl {
  return { id, projectId: null, kind, source: 'upload', status: 'ready', originalName: id, mimeType: 'video/mp4', sizeBytes: 1, durationMs, width: 1, height: 1, attribution: null, license: null, errorMessage: null, createdAt: '', url: 'http://x/y' };
}

beforeEach(() => {
  useEditorStore.getState().load('p1', base, 3);
  vi.restoreAllMocks();
});

describe('editor store', () => {
  it('undoes and redoes edits', () => {
    const s = useEditorStore.getState();
    s.update((t) => ({ ...t, backgroundColor: '#111111' }));
    s.update((t) => ({ ...t, backgroundColor: '#222222' }));
    expect(useEditorStore.getState().timeline!.backgroundColor).toBe('#222222');
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().timeline!.backgroundColor).toBe('#111111');
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().timeline!.backgroundColor).toBe('#000000');
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().timeline!.backgroundColor).toBe('#111111');
  });

  it('merges rapid edits with the same key into one undo step', () => {
    const s = useEditorStore.getState();
    for (const c of ['#100000', '#200000', '#300000']) s.update((t) => ({ ...t, backgroundColor: c }), 'bg');
    expect(useEditorStore.getState().past).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().timeline!.backgroundColor).toBe('#000000');
  });

  it('a new edit clears the redo stack', () => {
    const s = useEditorStore.getState();
    s.update((t) => ({ ...t, backgroundColor: '#111111' }));
    s.undo();
    s.update((t) => ({ ...t, backgroundColor: '#333333' }));
    expect(useEditorStore.getState().future).toHaveLength(0);
  });

  it('saves with the current revision and tracks the new one', async () => {
    const save = vi.spyOn(api, 'saveTimeline').mockResolvedValue({ revision: 4, durationMs: 1000 });
    useEditorStore.getState().update((t) => ({ ...t, backgroundColor: '#123456' }));
    expect(useEditorStore.getState().saveState).toBe('unsaved');
    await expect(useEditorStore.getState().save()).resolves.toBe(true);
    expect(save).toHaveBeenCalledWith('p1', expect.objectContaining({ backgroundColor: '#123456' }), 3);
    expect(useEditorStore.getState()).toMatchObject({ revision: 4, saveState: 'saved' });
  });

  it('reports conflicts and stops autosaving', async () => {
    vi.spyOn(api, 'saveTimeline').mockRejectedValue(new ApiError(409, 'conflict', 'changed'));
    useEditorStore.getState().update((t) => ({ ...t, backgroundColor: '#123456' }));
    await useEditorStore.getState().save();
    expect(useEditorStore.getState().saveState).toBe('conflict');
    await expect(useEditorStore.getState().save()).resolves.toBe(false);
  });
});

describe('timeline operations', () => {
  it('adds video clips back to back and reorders them', () => {
    let t = addClip(base, clipForAsset(base, asset('a', 'video', 4000), 'video'));
    t = addClip(t, clipForAsset(t, asset('b', 'image', null), 'video'));
    expect(t.clips.map((c) => [c.assetId, c.order, c.durationMs])).toEqual([
      ['a', 0, 4000],
      ['b', 1, 3000],
    ]);
    const bId = t.clips.find((c) => c.assetId === 'b')!.id;
    t = reorderVideoClip(t, bId, 0);
    expect(t.clips.sort((x, y) => x.order - y.order).map((c) => c.assetId)).toEqual(['b', 'a']);
  });

  it('keeps one narration and one looping music bed', () => {
    let t = addClip(base, clipForAsset(base, asset('v1', 'audio', 2000), 'narration'));
    t = addClip(t, clipForAsset(t, asset('v2', 'audio', 2500), 'narration'));
    t = addClip(t, clipForAsset(t, asset('m', 'audio', 60000), 'music'));
    expect(t.clips.filter((c) => c.track === 'narration').map((c) => c.assetId)).toEqual(['v2']);
    expect(t.clips.find((c) => c.track === 'music')).toMatchObject({ loop: true, volume: 0.25 });
  });

  it('marks hand-edited captions as manual and drops stale word timings', () => {
    const { timeline, id } = insertCaption(base, 500, 'hi there');
    const withWords = { ...timeline, captions: timeline.captions.map((c) => ({ ...c, timingSource: 'estimated' as const, words: [{ text: 'hi', startMs: 500, endMs: 900 }] })) };
    const edited = patchCaption(withWords, id, { text: 'hello there' });
    expect(edited.captions[0]).toMatchObject({ text: 'hello there', timingSource: 'manual' });
    expect(edited.captions[0]!.words).toBeUndefined();
  });
});
