import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { GitHubService } from './github.service.js';

@ApiTags('Repositories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('repositories')
export class RepositoriesController {
  constructor(private readonly githubService: GitHubService) {}

  @Get()
  getAll(@CurrentUser('id') userId: string) {
    return this.githubService.getRepositories(userId);
  }

  @Post(':repoId/sync-issues')
  syncIssues(
    @CurrentUser('id') userId: string,
    @Param('repoId') repoId: string,
  ) {
    return this.githubService.syncAssignedIssues(userId).then((count) => ({ synced: count }));
  }
}
