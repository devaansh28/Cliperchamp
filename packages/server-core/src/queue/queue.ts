import PgBoss from 'pg-boss';
import { QUEUE_NAMES } from '@clipforge/shared';

export interface RenderVideoJob {
  renderJobId: string;
}
export interface GenerateVoiceJob {
  assetId: string;
  userId: string;
  text: string;
  voiceId: string;
  speed: number;
}
export interface ProcessMediaJob {
  assetId: string;
  userId: string;
  /** Present for stock imports; the worker only fetches from the provider's allowlisted hosts. */
  remote?: { provider: 'pexels'; externalId: string };
}
export type CleanupJob = Record<string, never>;
export interface PublishVideoJob {
  publishJobId: string;
}

export interface JobPayloads {
  [QUEUE_NAMES.renderVideo]: RenderVideoJob;
  [QUEUE_NAMES.generateVoice]: GenerateVoiceJob;
  [QUEUE_NAMES.processMedia]: ProcessMediaJob;
  [QUEUE_NAMES.cleanup]: CleanupJob;
  [QUEUE_NAMES.publishVideo]: PublishVideoJob;
}
export type QueueName = keyof JobPayloads;

export interface SendOptions {
  /** Deduplicates pending jobs with the same key. */
  singletonKey?: string;
  /** Run no earlier than this time (scheduled posts). */
  startAfter?: Date;
}

/** Queue interface; pg-boss today, swappable for BullMQ or a managed queue later. */
export interface JobQueue {
  send<N extends QueueName>(name: N, data: JobPayloads[N], opts?: SendOptions): Promise<string | null>;
  work<N extends QueueName>(
    name: N,
    opts: { concurrency: number },
    handler: (data: JobPayloads[N], meta: { jobId: string; retryCount: number }) => Promise<void>,
  ): Promise<void>;
  schedule(name: QueueName, cron: string): Promise<void>;
  cancel(name: QueueName, jobId: string): Promise<void>;
  queueSize(name: QueueName): Promise<number>;
  stop(): Promise<void>;
}

/** Retry policy per queue. Permanent failures are signalled by handlers completing without throwing. */
const QUEUE_POLICIES: Record<QueueName, { retryLimit: number; retryDelay: number; expireInSeconds: number }> = {
  [QUEUE_NAMES.renderVideo]: { retryLimit: 2, retryDelay: 30, expireInSeconds: 60 * 60 },
  [QUEUE_NAMES.generateVoice]: { retryLimit: 2, retryDelay: 10, expireInSeconds: 10 * 60 },
  [QUEUE_NAMES.processMedia]: { retryLimit: 2, retryDelay: 10, expireInSeconds: 15 * 60 },
  [QUEUE_NAMES.cleanup]: { retryLimit: 0, retryDelay: 0, expireInSeconds: 15 * 60 },
  [QUEUE_NAMES.publishVideo]: { retryLimit: 3, retryDelay: 60, expireInSeconds: 45 * 60 },
};

export class PgBossQueue implements JobQueue {
  private constructor(private readonly boss: PgBoss) {}

  static async start(connectionString: string, onError: (err: Error) => void): Promise<PgBossQueue> {
    const boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: 'clipforge' } as never);
    boss.on('error', onError);
    await boss.start();
    for (const [name, policy] of Object.entries(QUEUE_POLICIES)) {
      await boss.createQueue(name, { name, retryBackoff: true, ...policy });
    }
    return new PgBossQueue(boss);
  }

  async send<N extends QueueName>(name: N, data: JobPayloads[N], opts: SendOptions = {}): Promise<string | null> {
    return this.boss.send(name, data as object, { ...QUEUE_POLICIES[name], retryBackoff: true, ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}), ...(opts.startAfter ? { startAfter: opts.startAfter } : {}) });
  }

  async work<N extends QueueName>(
    name: N,
    opts: { concurrency: number },
    handler: (data: JobPayloads[N], meta: { jobId: string; retryCount: number }) => Promise<void>,
  ): Promise<void> {
    // One job per fetch; register `concurrency` workers for parallelism.
    for (let i = 0; i < opts.concurrency; i++) {
      await this.boss.work<JobPayloads[N]>(
        name,
        { batchSize: 1, pollingIntervalSeconds: 2, includeMetadata: true },
        async (jobs) => {
          for (const job of jobs) await handler(job.data, { jobId: job.id, retryCount: job.retryCount });
        },
      );
    }
  }

  async schedule(name: QueueName, cron: string): Promise<void> {
    await this.boss.schedule(name, cron, {});
  }

  async cancel(name: QueueName, jobId: string): Promise<void> {
    await this.boss.cancel(name, jobId);
  }

  async queueSize(name: QueueName): Promise<number> {
    return this.boss.getQueueSize(name);
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000, wait: true });
  }
}
