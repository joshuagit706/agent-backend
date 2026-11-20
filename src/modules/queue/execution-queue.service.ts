import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Bull, { Queue, Job } from 'bull';
import { AgentOrchestratorService, OrchestrationContext } from '../agents/agent-orchestrator.service.js';
import { ExecutionService } from '../execution/execution.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export const EXECUTION_QUEUE_NAME = 'execution-jobs';

@Injectable()
export class ExecutionQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionQueueService.name);
  private queue!: Queue;

  constructor(
    private readonly configService: ConfigService,
    private readonly orchestrator: AgentOrchestratorService,
    private readonly executionService: ExecutionService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('redis.url') ?? 'redis://localhost:6379';
    const url = new URL(redisUrl);

    this.queue = new Bull(EXECUTION_QUEUE_NAME, {
      redis: {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
      },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });

    this.queue.process(async (job: Job<OrchestrationContext>) => {
      this.logger.log(`Processing job ${job.data.jobId}`);
      await this.orchestrator.runJob(job.data);
    });

    this.queue.on('completed', (job) => {
      this.logger.log(`Queue job completed: ${job.data.jobId}`);
    });

    this.queue.on('failed', (job, err) => {
      this.logger.error(`Queue job failed: ${job.data.jobId} - ${err.message}`);
    });

    this.logger.log('Execution queue initialized');

    // Re-enqueue any jobs that were left in an active state from a previous run
    setImmediate(() => this.recoverOrphanedJobs());
  }

  private async recoverOrphanedJobs(): Promise<void> {
    const activeStatuses = ['analysing', 'implementing', 'testing', 'reviewing'];
    const orphans = await this.prisma.executionJob.findMany({
      where: { status: { in: activeStatuses } },
      include: {
        batch: { select: { id: true, userId: true, branchPrefix: true, retryLimit: true, requirePlanApproval: true } },
        issue: { select: { id: true } },
      },
    });

    if (!orphans.length) return;

    this.logger.warn(`Found ${orphans.length} orphaned job(s) — resetting and re-enqueueing`);

    for (const job of orphans) {
      await this.prisma.executionJob.update({
        where: { id: job.id },
        data: { status: 'pending', currentAgent: null, currentActivity: null },
      });

      const settings = await this.prisma.userSettings.findUnique({
        where: { userId: job.batch.userId },
      });

      const ctx: OrchestrationContext = {
        jobId: job.id,
        batchId: job.batch.id,
        userId: job.batch.userId,
        issueId: job.issue.id,
        branchPrefix: job.batch.branchPrefix,
        model: settings?.defaultAiModel ?? 'deepseek-chat',
        providerName: settings?.defaultAiProvider ?? 'deepseek',
        requirePlanApproval: job.batch.requirePlanApproval,
        maxRetries: job.batch.retryLimit,
      };

      await this.enqueueJob(ctx);
      this.logger.log(`Re-enqueued orphaned job ${job.id}`);
    }
  }

  async onModuleDestroy() {
    await this.queue?.close();
  }

  async enqueueJob(ctx: OrchestrationContext, concurrencySlot?: number): Promise<void> {
    // Use a unique Bull job ID so retries are never silently deduplicated.
    // The DB job ID is tracked via ctx.jobId inside the payload.
    await this.queue.add(ctx, {
      priority: concurrencySlot,
      jobId: `${ctx.jobId}-${Date.now()}`,
    });
    this.logger.log(`Enqueued job ${ctx.jobId}`);
  }

  async enqueueBatch(batchId: string, userId: string): Promise<void> {
    const batch = await this.prisma.executionBatch.findUnique({
      where: { id: batchId },
      include: {
        executionJobs: {
          where: { status: 'pending' },
          include: {
            issue: { select: { id: true } },
          },
        },
      },
    });

    if (!batch) return;

    await this.prisma.executionBatch.update({
      where: { id: batchId },
      data: { status: 'running' },
    });

    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    const model = settings?.defaultAiModel ?? 'deepseek-chat';
    const providerName = settings?.defaultAiProvider ?? 'deepseek';

    for (let i = 0; i < batch.executionJobs.length; i++) {
      const job = batch.executionJobs[i];
      const ctx: OrchestrationContext = {
        jobId: job.id,
        batchId,
        userId,
        issueId: job.issue.id,
        branchPrefix: batch.branchPrefix,
        model,
        providerName,
        requirePlanApproval: batch.requirePlanApproval,
        maxRetries: batch.retryLimit,
      };
      // Stagger jobs within concurrency limit
      const slot = i % batch.concurrencyLimit;
      await this.enqueueJob(ctx, slot);
    }

    this.logger.log(`Enqueued ${batch.executionJobs.length} jobs for batch ${batchId}`);
  }

  async getQueueStatus() {
    const [waiting, active, completed, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
    ]);
    return { waiting, active, completed, failed };
  }
}
