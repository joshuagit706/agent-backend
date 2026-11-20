import { Module, forwardRef } from '@nestjs/common';
import { AgentOrchestratorService } from './agent-orchestrator.service.js';
import { ToolExecutorService } from './tool-executor.service.js';
import { AIModule } from '../ai/ai.module.js';
import { GitHubModule } from '../github/github.module.js';
import { ExecutionModule } from '../execution/execution.module.js';

@Module({
  imports: [AIModule, GitHubModule, forwardRef(() => ExecutionModule)],
  providers: [AgentOrchestratorService, ToolExecutorService],
  exports: [AgentOrchestratorService, ToolExecutorService],
})
export class AgentsModule {}
