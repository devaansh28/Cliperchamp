import path from 'node:path';
import type { ServerContext } from '@clipforge/server-core';
import { AssetServer } from './render/asset-server.js';
import { FfmpegService } from './render/ffmpeg-service.js';
import { RenderManager } from './render/render-manager.js';

export interface WorkerContext extends ServerContext {
  renderer: RenderManager;
  assetServer: AssetServer;
  ffmpeg: FfmpegService;
  tempRoot: string;
}

export async function createWorkerContext(base: ServerContext): Promise<WorkerContext> {
  const tempRoot = path.resolve(base.env.TEMP_RENDER_DIR);
  const assetServer = new AssetServer();
  await assetServer.start();
  return {
    ...base,
    tempRoot,
    assetServer,
    ffmpeg: new FfmpegService(base.env.FFMPEG_PATH),
    renderer: new RenderManager(
      {
        browserExecutable: base.env.RENDER_BROWSER_EXECUTABLE,
        gl: base.env.RENDER_GL,
        licenseKey: base.env.REMOTION_LICENSE_KEY,
        bundleDir: path.join(tempRoot, '..', 'remotion-bundle'),
      },
      base.log,
    ),
  };
}
