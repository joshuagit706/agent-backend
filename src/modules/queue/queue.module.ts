import { Module, forwardRef } from '@nestjs/common';
import { ExecutionQueueService } from './execution-queue.service.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ExecutionModule } from '../execution/execution.module.js';

@Module({
  imports: [forwardRef(() => AgentsModule), forwardRef(() => ExecutionModule)],
  providers: [ExecutionQueueService],
  exports: [ExecutionQueueService],
})
export class QueueModule {}
