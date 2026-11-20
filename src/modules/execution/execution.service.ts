import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateExecutionBatchDto } from './dto/create-batch.dto.js';

export const JOB_STATUSES = [
  'pending',
  'analysing',
  'awaiting_approval',
  'implementing',
  'testing',
  'reviewing',
  'completed',
  'failed',
  'cancelled',
  'awaiting_consolidation',
  'pr_created',
  'awaiting_merge',
  'closed',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createBatch(userId: string, dto: CreateExecutionBatchDto) {
    if (!dto.issueIds.length) {
      throw new BadRequestException('At least one issue must be selected');
    }

    // Verify all issues belong to this user and are not already actively running
    const issues = await this.prisma.assignedIssue.findMany({
      where: {
        id: { in: dto.issueIds },
        githubAccount: { userId },
      },
    });

    if (issues.length !== dto.issueIds.length) {
      throw new BadRequestException('One or more issues not found or not owned by user');
    }

    // Check for duplicate active executions
    for (const issue of issues) {
      const activeJob = await this.prisma.executionJob.findFirst({
        where: {
          issueId: issue.id,
          status: { in: ['pending', 'analysing', 'awaiting_approval', 'implementing', 'testing', 'reviewing'] },
        },
      });
      if (activeJob) {
        throw new ConflictException(
          `Issue #${issue.issueNumber} already has an active execution job`,
        );
      }
    }

    // Get user settings for defaults
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });

    const batch = await this.prisma.executionBatch.create({
      data: {
        userId,
        name: dto.name ?? `Batch ${new Date().toISOString().slice(0, 10)}`,
        status: 'pending',
        concurrencyLimit: dto.concurrencyLimit ?? settings?.concurrencyLimit ?? 3,
        branchPrefix: dto.branchPrefix ?? settings?.branchPrefix ?? 'ai',
        requirePlanApproval: dto.requirePlanApproval ?? settings?.requirePlanApproval ?? false,
        retryLimit: dto.retryLimit ?? settings?.retryLimit ?? 2,
        executionJobs: {
          create: dto.issueIds.map((issueId, index) => ({
            issueId,
            status: 'pending' as JobStatus,
            priority: index,
            maxRetries: dto.retryLimit ?? settings?.retryLimit ?? 2,
          })),
        },
      },
      include: {
        executionJobs: {
          include: { issue: { select: { issueNumber: true, title: true, repositoryId: true } } },
        },
      },
    });

    // Update issue statuses
    await this.prisma.assignedIssue.updateMany({
      where: { id: { in: dto.issueIds } },
      data: { aiStatus: 'queued' },
    });

    this.logger.log(`Created batch ${batch.id} with ${dto.issueIds.length} jobs`);
    return batch;
  }

  async getBatches(userId: string) {
    return this.prisma.executionBatch.findMany({
      where: { userId },
      include: {
        _count: { select: { executionJobs: true } },
        executionJobs: {
          select: { status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBatch(userId: string, batchId: string) {
    const batch = await this.prisma.executionBatch.findFirst({
      where: { id: batchId, userId },
      include: {
        executionJobs: {
          include: {
            issue: {
              include: {
                repository: { select: { name: true, fullName: true, owner: true } },
                githubAccount: { select: { githubUsername: true } },
              },
            },
            issueBranch: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        consolidatedBranches: {
          include: { pullRequest: true, repository: { select: { name: true, fullName: true } } },
        },
      },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  async getJob(userId: string, jobId: string) {
    const job = await this.prisma.executionJob.findFirst({
      where: { id: jobId, batch: { userId } },
      include: {
        issue: {
          include: {
            repository: true,
            githubAccount: { select: { githubUsername: true, avatarUrl: true } },
          },
        },
        executionLogs: { orderBy: { timestamp: 'asc' }, take: 500 },
        testResults: { orderBy: { createdAt: 'asc' } },
        agentExecutions: { orderBy: { createdAt: 'asc' } },
        issueBranch: true,
        tokenUsages: true,
      },
    });
    if (!job) throw new NotFoundException('Execution job not found');
    return job;
  }

  async cancelJob(userId: string, jobId: string) {
    const job = await this.prisma.executionJob.findFirst({
      where: { id: jobId, batch: { userId } },
    });
    if (!job) throw new NotFoundException('Execution job not found');

    const cancellable: JobStatus[] = ['pending', 'analysing', 'awaiting_approval'];
    if (!cancellable.includes(job.status as JobStatus)) {
      throw new BadRequestException(`Cannot cancel job in status '${job.status}'`);
    }

    await this.prisma.executionJob.update({
      where: { id: jobId },
      data: { status: 'cancelled' },
    });

    return { message: 'Job cancelled' };
  }

  async deleteJob(userId: string, jobId: string) {
    const job = await this.prisma.executionJob.findFirst({
      where: { id: jobId, batch: { userId } },
      include: { issue: { select: { id: true } } },
    });
    if (!job) throw new NotFoundException('Execution job not found');

    const deletable: JobStatus[] = ['failed', 'cancelled', 'completed'];
    if (!deletable.includes(job.status as JobStatus)) {
      throw new BadRequestException(`Cannot delete job in status '${job.status}'`);
    }

    await this.prisma.$transaction([
      this.prisma.executionJob.delete({ where: { id: jobId } }),
      this.prisma.assignedIssue.update({
        where: { id: job.issue.id },
        data: { aiStatus: 'pending' },
      }),
    ]);

    return { message: 'Job deleted' };
  }

  async retryJob(userId: string, jobId: string) {
    const job = await this.prisma.executionJob.findFirst({
      where: { id: jobId, batch: { userId } },
      include: {
        batch: { select: { id: true, branchPrefix: true, retryLimit: true, requirePlanApproval: true } },
        issue: { select: { id: true } },
      },
    });
    if (!job) throw new NotFoundException('Execution job not found');

    const retryable: JobStatus[] = ['failed', 'cancelled'];
    if (!retryable.includes(job.status as JobStatus)) {
      throw new BadRequestException(`Cannot retry job in status '${job.status}'`);
    }

    await this.prisma.executionJob.update({
      where: { id: jobId },
      data: {
        status: 'pending',
        errorMessage: null,
        currentAgent: null,
        currentActivity: null,
        startedAt: null,
        completedAt: null,
      },
    });

    return job;
  }

  async getExecutionLogs(userId: string, jobId: string, since?: Date) {
    const job = await this.prisma.executionJob.findFirst({
      where: { id: jobId, batch: { userId } },
    });
    if (!job) throw new NotFoundException('Execution job not found');

    return this.prisma.executionLog.findMany({
      where: {
        executionJobId: jobId,
        ...(since ? { timestamp: { gt: since } } : {}),
      },
      orderBy: { timestamp: 'asc' },
      take: 1000,
    });
  }

  async getUserSettings(userId: string) {
    return this.prisma.userSettings.findUnique({ where: { userId } });
  }

  async updateJobStatus(jobId: string, status: JobStatus, extra?: {
    currentAgent?: string;
    currentActivity?: string;
    errorMessage?: string;
    startedAt?: Date;
    completedAt?: Date;
    workingDirectory?: string;
  }) {
    return this.prisma.executionJob.update({
      where: { id: jobId },
      data: { status, ...extra },
    });
  }

  async appendLog(jobId: string, level: string, message: string, metadata?: object, agentType?: string) {
    return this.prisma.executionLog.create({
      data: {
        executionJobId: jobId,
        level,
        message,
        metadata: metadata ?? undefined,
        agentType: agentType ?? null,
      },
    });
  }

  async getQueue(userId: string) {
    return this.prisma.executionJob.findMany({
      where: { batch: { userId } },
      include: {
        issue: {
          select: {
            issueNumber: true,
            title: true,
            repository: { select: { name: true } },
            githubAccount: { select: { githubUsername: true } },
          },
        },
        batch: { select: { name: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }
}
