import { Module } from '@nestjs/common';
import { GitHubService } from './github.service.js';
import { GitHubController } from './github.controller.js';
import { RepositoriesController } from './repositories.controller.js';

@Module({
  controllers: [GitHubController, RepositoriesController],
  providers: [GitHubService],
  exports: [GitHubService],
})
export class GitHubModule {}
