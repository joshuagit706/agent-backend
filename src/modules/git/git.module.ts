import { Module } from '@nestjs/common';
import { GitService } from './git.service.js';
import { GitController } from './git.controller.js';
import { GitHubModule } from '../github/github.module.js';

@Module({
  imports: [GitHubModule],
  controllers: [GitController],
  providers: [GitService],
  exports: [GitService],
})
export class GitModule {}
