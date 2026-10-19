import { useQuery } from '@tanstack/react-query';
import type { ResolvedAsset } from '@clipforge/shared';
import { useMemo, useRef } from 'react';
import { api, type MediaAssetWithUrl } from '@/lib/api';
import { qk } from '@/lib/query';

const URL_REUSE_MS = 20 * 60_000;

/**
 * The user's media library. Polls while anything is still processing and keeps signed URLs stable
 * between refetches (a new URL would make the preview reload the video).
 */
export function useMediaLibrary() {
  const cache = useRef(new Map<string, { url: string; at: number }>());
  const query = useQuery({
    queryKey: qk.media(),
    queryFn: () => api.listMedia(),
    refetchInterval: (q) => (q.state.data?.some((m) => m.status === 'pending') ? 2000 : 10 * 60_000),
  });

  const media = useMemo<MediaAssetWithUrl[]>(() => {
    const now = Date.now();
    return (query.data ?? []).map((m) => {
      if (!m.url) return m;
      const cached = cache.current.get(m.id);
      if (cached && now - cached.at < URL_REUSE_MS) return { ...m, url: cached.url };
      cache.current.set(m.id, { url: m.url, at: now });
      return m;
    });
  }, [query.data]);

  const assets = useMemo<Record<string, ResolvedAsset>>(() => {
    const out: Record<string, ResolvedAsset> = {};
    for (const m of media) {
      if (m.status !== 'ready' || !m.url) continue;
      const src = new URL(m.url, window.location.origin).toString();
      out[m.id] = { id: m.id, kind: m.kind, src, durationMs: m.durationMs, width: m.width, height: m.height };
    }
    return out;
  }, [media]);

  const byId = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  return { ...query, media, assets, byId };
}
