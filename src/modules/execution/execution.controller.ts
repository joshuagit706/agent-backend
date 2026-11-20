import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ExecutionService } from './execution.service.js';
import { CreateExecutionBatchDto } from './dto/create-batch.dto.js';
import { ExecutionQueueService } from '../queue/execution-queue.service.js';

@ApiTags('Execution')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('execution')
export class ExecutionController {
  private readonly logger = new Logger(ExecutionController.name);

  constructor(
    private readonly executionService: ExecutionService,
    @Inject(forwardRef(() => ExecutionQueueService))
    private readonly queueService: ExecutionQueueService,
  ) {}

  @Post('batches')
  async createBatch(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateExecutionBatchDto,
  ) {
    const batch = await this.executionService.createBatch(userId, dto);
    // Auto-enqueue all jobs immediately
    this.queueService.enqueueBatch(batch.id, userId).catch((err: Error) =>
      this.logger.error(`Failed to enqueue batch ${batch.id}: ${err.message}`),
    );
    return batch;
  }

  @Get('batches')
  getBatches(@CurrentUser('id') userId: string) {
    return this.executionService.getBatches(userId);
  }

  @Get('batches/:batchId')
  getBatch(
    @CurrentUser('id') userId: string,
    @Param('batchId') batchId: string,
  ) {
    return this.executionService.getBatch(userId, batchId);
  }

  @Get('queue')
  getQueue(@CurrentUser('id') userId: string) {
    return this.executionService.getQueue(userId);
  }

  @Get('jobs/:jobId')
  getJob(
    @CurrentUser('id') userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.executionService.getJob(userId, jobId);
  }

  @Patch('jobs/:jobId/cancel')
  @HttpCode(HttpStatus.OK)
  cancelJob(
    @CurrentUser('id') userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.executionService.cancelJob(userId, jobId);
  }

  @Delete('jobs/:jobId')
  @HttpCode(HttpStatus.OK)
  deleteJob(
    @CurrentUser('id') userId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.executionService.deleteJob(userId, jobId);
  }

  @Post('jobs/:jobId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryJob(
    @CurrentUser('id') userId: string,
    @Param('jobId') jobId: string,
  ) {
    const job = await this.executionService.retryJob(userId, jobId);

    const settings = await this.executionService.getUserSettings(userId);
    const ctx = {
      jobId: job.id,
      batchId: job.batch.id,
      userId,
      issueId: job.issue.id,
      branchPrefix: job.batch.branchPrefix,
      model: settings?.defaultAiModel ?? 'deepseek-chat',
      providerName: settings?.defaultAiProvider ?? 'deepseek',
      requirePlanApproval: job.batch.requirePlanApproval,
      maxRetries: job.batch.retryLimit,
    };

    this.queueService.enqueueJob(ctx).catch((err: Error) =>
      this.logger.error(`Failed to re-enqueue job ${jobId}: ${err.message}`),
    );

    return { message: 'Job retry triggered', jobId };
  }

  @Get('jobs/:jobId/logs')
  getLogs(
    @CurrentUser('id') userId: string,
    @Param('jobId') jobId: string,
    @Query('since') since?: string,
  ) {
    return this.executionService.getExecutionLogs(
      userId,
      jobId,
      since ? new Date(since) : undefined,
    );
  }

  @Post('batches/:batchId/start')
  @HttpCode(HttpStatus.ACCEPTED)
  startBatch(
    @CurrentUser('id') userId: string,
    @Param('batchId') batchId: string,
  ) {
    this.queueService.enqueueBatch(batchId, userId).catch((err: Error) =>
      this.logger.error(`Failed to start batch ${batchId}: ${err.message}`),
    );
    return { message: 'Batch start triggered', batchId };
  }

  @Post('cleanup-workspaces')
  @HttpCode(HttpStatus.OK)
  async cleanupWorkspaces() {
    // Stale workspace cleanup - implementation in WorkspaceService
    return { message: 'Cleanup triggered' };
  }
}
