import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { GitHubService } from './github.service.js';
import { ConnectGitHubAccountDto } from './dto/connect-account.dto.js';

@ApiTags('GitHub')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('github')
export class GitHubController {
  constructor(private readonly githubService: GitHubService) {}

  // ─── Accounts ───────────────────────────────────────────────────────────────

  @Post('accounts')
  connectAccount(
    @CurrentUser('id') userId: string,
    @Body() dto: ConnectGitHubAccountDto,
  ) {
    return this.githubService.connectAccount(userId, dto.token);
  }

  @Get('accounts')
  getAccounts(@CurrentUser('id') userId: string) {
    return this.githubService.getAccounts(userId);
  }

  @Get('accounts/:accountId')
  getAccount(
    @CurrentUser('id') userId: string,
    @Param('accountId') accountId: string,
  ) {
    return this.githubService.getAccount(userId, accountId);
  }

  @Post('accounts/:accountId/validate')
  @HttpCode(HttpStatus.OK)
  validateToken(
    @CurrentUser('id') userId: string,
    @Param('accountId') accountId: string,
  ) {
    return this.githubService.validateToken(userId, accountId);
  }

  @Patch('accounts/:accountId/token')
  replaceToken(
    @CurrentUser('id') userId: string,
    @Param('accountId') accountId: string,
    @Body() dto: ConnectGitHubAccountDto,
  ) {
    return this.githubService.replaceToken(userId, accountId, dto.token);
  }

  @Delete('accounts/:accountId')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnectAccount(
    @CurrentUser('id') userId: string,
    @Param('accountId') accountId: string,
  ) {
    return this.githubService.disconnectAccount(userId, accountId);
  }

  @Post('accounts/:accountId/sync')
  @HttpCode(HttpStatus.OK)
  syncAccount(
    @CurrentUser('id') userId: string,
    @Param('accountId') accountId: string,
  ) {
    return this.githubService.syncRepositories(accountId);
  }

  // ─── Repositories ───────────────────────────────────────────────────────────

  @Get('repositories')
  getRepositories(
    @CurrentUser('id') userId: string,
    @Query('accountId') accountId?: string,
  ) {
    return this.githubService.getRepositories(userId, accountId);
  }

  // ─── Issues ─────────────────────────────────────────────────────────────────

  @Get('issues')
  getIssues(
    @CurrentUser('id') userId: string,
    @Query('accountId') accountId?: string,
    @Query('repositoryId') repositoryId?: string,
    @Query('state') state?: string,
    @Query('aiStatus') aiStatus?: string,
  ) {
    return this.githubService.getAssignedIssues(userId, {
      accountId,
      repositoryId,
      state,
      aiStatus,
    });
  }

  @Post('issues/sync')
  @HttpCode(HttpStatus.OK)
  syncIssues(
    @CurrentUser('id') userId: string,
    @Query('accountId') accountId?: string,
  ) {
    return this.githubService.syncAssignedIssues(userId, accountId).then((count) => ({
      synced: count,
      message: `Synced ${count} assigned issues`,
    }));
  }
}
