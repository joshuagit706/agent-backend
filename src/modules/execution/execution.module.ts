import { Module, forwardRef } from '@nestjs/common';
import { ExecutionService } from './execution.service.js';
import { ExecutionController } from './execution.controller.js';
import { WorkspaceService } from './workspace.service.js';
import { QueueModule } from '../queue/queue.module.js';

@Module({
  imports: [forwardRef(() => QueueModule)],
  controllers: [ExecutionController],
  providers: [ExecutionService, WorkspaceService],
  exports: [ExecutionService, WorkspaceService],
})
export class ExecutionModule {}
