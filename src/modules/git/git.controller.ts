import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { GitService } from './git.service.js';

@ApiTags('Git')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('git')
export class GitController {
  constructor(private readonly gitService: GitService) {}

  @Post('batches/:batchId/consolidate')
  @HttpCode(HttpStatus.ACCEPTED)
  consolidate(
    @CurrentUser('id') userId: string,
    @Param('batchId') batchId: string,
  ) {
    this.gitService.consolidateBatch(batchId, userId).catch(() => {});
    return { message: 'Consolidation started' };
  }

  @Post('consolidated/:consolidatedBranchId/pr')
  createPR(
    @CurrentUser('id') userId: string,
    @Param('consolidatedBranchId') id: string,
  ) {
    return this.gitService.createPullRequest(id, userId);
  }

  @Post('pull-requests/:prId/sync')
  @HttpCode(HttpStatus.OK)
  syncPR(@Param('prId') prId: string) {
    return this.gitService.syncPullRequestStatus(prId);
  }

  @Get('pull-requests')
  getPRs(@CurrentUser('id') userId: string) {
    return this.gitService.getPullRequests(userId);
  }
}
