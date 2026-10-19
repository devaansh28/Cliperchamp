import { createRequire } from 'node:module';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, selectComposition } from '@remotion/renderer';
import type { CompositionInput } from '@clipforge/shared';
import type { Logger } from '@clipforge/server-core';
import { JobCancelledError } from '../utils/job-errors.js';

const COMPOSITION_ID = 'ShortVideo';

export interface RenderOptions {
  inputProps: CompositionInput;
  outputLocation: string;
  onProgress: (progress: number) => Promise<boolean | void> | boolean | void;
  timeoutMs: number;
}

export interface RenderManagerConfig {
  browserExecutable?: string;
  gl?: 'swangle' | 'angle' | 'egl' | 'swiftshader' | 'vulkan' | 'angle-egl';
  concurrency?: number | null;
  licenseKey?: string;
  bundleDir: string;
}

/** Bundles the shared Remotion composition once, then renders jobs with it. */
export class RenderManager {
  private serveUrl: Promise<string> | null = null;

  constructor(private readonly cfg: RenderManagerConfig, private readonly log: Logger) {}

  private entryPoint(): string {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('@clipforge/video-engine/package.json')), 'src', 'entry.ts');
  }

  bundle(): Promise<string> {
    if (!this.serveUrl) {
      const started = Date.now();
      this.serveUrl = bundle({
        entryPoint: this.entryPoint(),
        outDir: this.cfg.bundleDir,
        // Our packages use ESM-style ".js" import specifiers that point at .ts/.tsx sources.
        webpackOverride: (config) => ({
          ...config,
          resolve: {
            ...config.resolve,
            extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
          },
        }),
      }).then((url) => {
        this.log.info({ ms: Date.now() - started }, 'remotion bundle ready');
        return url;
      });
      this.serveUrl.catch(() => {
        this.serveUrl = null;
      });
    }
    return this.serveUrl;
  }

  /** Render to MP4 (H.264 + AAC, yuv420p). Resolves to the frame count rendered. */
  async render(opts: RenderOptions): Promise<{ durationInFrames: number; fps: number }> {
    const serveUrl = await this.bundle();
    const chromiumOptions = this.cfg.gl ? { gl: this.cfg.gl } : {};
    const common = {
      serveUrl,
      inputProps: opts.inputProps as unknown as Record<string, unknown>,
      browserExecutable: this.cfg.browserExecutable ?? null,
      chromiumOptions,
      logLevel: 'warn' as const,
    };
    const composition = await selectComposition({ ...common, id: COMPOSITION_ID });
    const { cancelSignal, cancel } = makeCancelSignal();
    let stopReason: 'timeout' | 'user' | null = null;
    const timer = setTimeout(() => {
      stopReason = 'timeout';
      cancel();
    }, opts.timeoutMs);
    let lastReport = 0;
    try {
      await renderMedia({
        ...common,
        composition,
        codec: 'h264',
        audioCodec: 'aac',
        pixelFormat: 'yuv420p',
        // bt709 with limited ("tv") range yields standard yuv420p instead of full-range yuvj420p.
        colorSpace: 'bt709',
        outputLocation: opts.outputLocation,
        overwrite: true,
        cancelSignal,
        concurrency: this.cfg.concurrency ?? null,
        timeoutInMilliseconds: 60_000,
        licenseKey: this.cfg.licenseKey ?? null,
        onProgress: ({ progress }) => {
          const now = Date.now();
          if (now - lastReport < 1000 && progress < 1) return;
          lastReport = now;
          void Promise.resolve(opts.onProgress(progress)).then((stop) => {
            if (stop && !stopReason) {
              stopReason = 'user';
              cancel();
            }
          });
        },
      });
    } catch (err) {
      if (stopReason === 'user') throw new JobCancelledError();
      if (stopReason === 'timeout') throw new Error(`Render timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return { durationInFrames: composition.durationInFrames, fps: composition.fps };
  }
}
