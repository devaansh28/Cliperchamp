import { fetchWithTimeout, isTransientStatus, ProviderError, ProviderNotConfiguredError } from '../errors.js';

export interface StockResult {
  provider: 'pexels';
  externalId: string;
  kind: 'video' | 'image';
  previewUrl: string;
  width: number;
  height: number;
  durationMs: number | null;
  attribution: string;
  license: string;
  pageUrl: string;
}

export interface StockDownload {
  url: string;
  kind: 'video' | 'image';
  mimeType: string;
  width: number;
  height: number;
  durationMs: number | null;
  attribution: string;
  license: string;
  pageUrl: string;
}

export interface MediaProvider {
  readonly provider: string;
  readonly configured: boolean;
  /** Hosts the worker may download from for this provider. */
  readonly allowedDownloadHosts: string[];
  search(query: string, opts: { orientation: 'portrait'; perPage: number }): Promise<StockResult[]>;
  resolveDownload(externalId: string): Promise<StockDownload>;
}

export class NoMediaProvider implements MediaProvider {
  readonly provider = 'none';
  readonly configured = false;
  readonly allowedDownloadHosts: string[] = [];
  async search(): Promise<StockResult[]> {
    throw new ProviderNotConfiguredError('media', 'Set MEDIA_PROVIDER=pexels and MEDIA_API_KEY to search stock footage. You can upload your own media instead.');
  }
  async resolveDownload(): Promise<StockDownload> {
    return this.search() as never;
  }
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user: { name: string };
  video_files: { link: string; width: number; height: number; file_type: string; quality: string }[];
}

/** Pexels video search (free API key; attribution required by the Pexels license). */
export class PexelsProvider implements MediaProvider {
  readonly provider = 'pexels';
  readonly configured = true;
  readonly allowedDownloadHosts = ['videos.pexels.com', 'player.vimeo.com', 'images.pexels.com'];
  constructor(private readonly apiKey: string) {}

  private async get<T>(url: string): Promise<T> {
    const res = await fetchWithTimeout(url, { headers: { authorization: this.apiKey } }, 20_000);
    if (!res.ok) throw new ProviderError(`Pexels HTTP ${res.status}`, isTransientStatus(res.status), 'Stock media search failed.');
    return (await res.json()) as T;
  }

  async search(query: string, opts: { orientation: 'portrait'; perPage: number }): Promise<StockResult[]> {
    const params = new URLSearchParams({ query, orientation: opts.orientation, per_page: String(opts.perPage), size: 'medium' });
    const body = await this.get<{ videos?: PexelsVideo[] }>(`https://api.pexels.com/videos/search?${params}`);
    return (body.videos ?? []).map((v) => ({
      provider: 'pexels' as const,
      externalId: String(v.id),
      kind: 'video' as const,
      previewUrl: v.image,
      width: v.width,
      height: v.height,
      durationMs: v.duration * 1000,
      attribution: `Video by ${v.user.name} on Pexels`,
      license: 'Pexels License',
      pageUrl: v.url,
    }));
  }

  async resolveDownload(externalId: string): Promise<StockDownload> {
    if (!/^\d{1,20}$/u.test(externalId)) throw new ProviderError('Invalid id', false, 'Invalid stock media id.');
    const v = await this.get<PexelsVideo>(`https://api.pexels.com/videos/videos/${externalId}`);
    const files = v.video_files
      .filter((f) => f.file_type === 'video/mp4' && f.height <= 1920)
      .sort((a, b) => b.height - a.height);
    const file = files[0];
    if (!file) throw new ProviderError('No mp4 rendition', false, 'This stock video has no compatible file.');
    return {
      url: file.link,
      kind: 'video',
      mimeType: 'video/mp4',
      width: file.width,
      height: file.height,
      durationMs: v.duration * 1000,
      attribution: `Video by ${v.user.name} on Pexels`,
      license: 'Pexels License',
      pageUrl: v.url,
    };
  }
}

export function createMediaProvider(env: { MEDIA_PROVIDER: 'none' | 'pexels'; MEDIA_API_KEY?: string }): MediaProvider {
  return env.MEDIA_PROVIDER === 'pexels' ? new PexelsProvider(env.MEDIA_API_KEY!) : new NoMediaProvider();
}
