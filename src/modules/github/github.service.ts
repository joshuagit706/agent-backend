import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { encrypt, decrypt, maskToken } from '../../common/crypto.util.js';
import { Octokit } from '@octokit/rest';

export interface GitHubAccountSummary {
  id: string;
  githubUsername: string;
  githubEmail: string | null;
  avatarUrl: string | null;
  accountType: string;
  repoCount: number;
  openIssueCount: number;
  isValid: boolean;
  lastSyncedAt: Date | null;
  lastValidatedAt: Date | null;
  tokenLastFour: string;
  createdAt: Date;
}

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private getOctokit(token: string): Octokit {
    return new Octokit({ auth: token });
  }

  private decryptToken(encryptedToken: string): string {
    const key = this.configService.get<string>('crypto.encryptionKey') ?? '';
    return decrypt(encryptedToken, key);
  }

  private encryptToken(token: string): string {
    const key = this.configService.get<string>('crypto.encryptionKey') ?? '';
    return encrypt(token, key);
  }

  async connectAccount(userId: string, rawToken: string): Promise<GitHubAccountSummary> {
    // Validate the token against GitHub API
    const octokit = this.getOctokit(rawToken);
    let githubUser: Awaited<ReturnType<typeof octokit.users.getAuthenticated>>['data'];
    try {
      const { data } = await octokit.users.getAuthenticated();
      githubUser = data;
    } catch (err: any) {
      throw new BadRequestException(
        `GitHub token validation failed: ${err.message || 'Invalid or expired token'}`,
      );
    }

    // Check required scopes / permissions via rate limit endpoint
    let scopes: string[] = [];
    try {
      const { headers } = await octokit.rateLimit.get();
      const scopeHeader = (headers as any)['x-oauth-scopes'] ?? '';
      scopes = scopeHeader.split(',').map((s: string) => s.trim()).filter(Boolean);
    } catch {
      // Fine-grained PATs don't expose scopes this way
    }

    // Check if this GitHub account is already connected to this user
    const existing = await this.prisma.gitHubAccount.findFirst({
      where: { userId, githubUserId: String(githubUser.id) },
    });

    if (existing) {
      throw new ConflictException(
        `GitHub account @${githubUser.login} is already connected to your account`,
      );
    }

    const encryptedToken = this.encryptToken(rawToken);
    const account = await this.prisma.gitHubAccount.create({
      data: {
        userId,
        githubUserId: String(githubUser.id),
        githubUsername: githubUser.login,
        githubEmail: githubUser.email ?? null,
        avatarUrl: githubUser.avatar_url ?? null,
        accountType: githubUser.type ?? 'User',
        encryptedToken,
        tokenLastFour: maskToken(rawToken),
        scopes,
        isActive: true,
        isValid: true,
        lastValidatedAt: new Date(),
      },
    });

    // Kick off async repo sync (non-blocking)
    this.syncRepositories(account.id, rawToken).catch((err) =>
      this.logger.error(`Failed to sync repos for account ${account.id}: ${err.message}`),
    );

    return this.formatAccount(account);
  }

  async getAccounts(userId: string): Promise<GitHubAccountSummary[]> {
    const accounts = await this.prisma.gitHubAccount.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map(this.formatAccount);
  }

  async getAccount(userId: string, accountId: string): Promise<GitHubAccountSummary> {
    const account = await this.prisma.gitHubAccount.findFirst({
      where: { id: accountId, userId, isActive: true },
    });
    if (!account) throw new NotFoundException('GitHub account not found');
    return this.formatAccount(account);
  }

  async validateToken(userId: string, accountId: string): Promise<{ isValid: boolean; message: string }> {
    const account = await this.prisma.gitHubAccount.findFirst({
      where: { id: accountId, userId, isActive: true },
    });
    if (!account) throw new NotFoundException('GitHub account not found');

    const rawToken = this.decryptToken(account.encryptedToken);
    const octokit = this.getOctokit(rawToken);

    try {
      await octokit.users.getAuthenticated();
      await this.prisma.gitHubAccount.update({
        where: { id: accountId },
        data: { isValid: true, lastValidatedAt: new Date() },
      });
      return { isValid: true, message: 'Token is valid' };
    } catch {
      await this.prisma.gitHubAccount.update({
        where: { id: accountId },
        data: { isValid: false },
      });
      return { isValid: false, message: 'Token is invalid or has been revoked' };
    }
  }

  async replaceToken(userId: string, accountId: string, newRawToken: string): Promise<GitHubAccountSummary> {
    const account = await this.prisma.gitHubAccount.findFirst({
      where: { id: accountId, userId, isActive: true },
    });
    if (!account) throw new NotFoundException('GitHub account not found');

    // Validate the new token and confirm it belongs to the same GitHub user
    const octokit = this.getOctokit(newRawToken);
    let githubUser: Awaited<ReturnType<typeof octokit.users.getAuthenticated>>['data'];
    try {
      const { data } = await octokit.users.getAuthenticated();
      githubUser = data;
    } catch (err: any) {
      throw new BadRequestException(`Token validation failed: ${err.message}`);
    }

    if (String(githubUser.id) !== account.githubUserId) {
      throw new BadRequestException(
        'The new token belongs to a different GitHub account',
      );
    }

    const updated = await this.prisma.gitHubAccount.update({
      where: { id: accountId },
      data: {
        encryptedToken: this.encryptToken(newRawToken),
        tokenLastFour: maskToken(newRawToken),
        isValid: true,
        lastValidatedAt: new Date(),
      },
    });

    return this.formatAccount(updated);
  }

  async disconnectAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.gitHubAccount.findFirst({
      where: { id: accountId, userId, isActive: true },
    });
    if (!account) throw new NotFoundException('GitHub account not found');

    await this.prisma.gitHubAccount.update({
      where: { id: accountId },
      data: { isActive: false, encryptedToken: '' },
    });
  }

  async syncRepositories(accountId: string, rawToken?: string): Promise<void> {
    const account = await this.prisma.gitHubAccount.findUnique({ where: { id: accountId } });
    if (!account) return;

    const token = rawToken ?? this.decryptToken(account.encryptedToken);
    const octokit = this.getOctokit(token);

    try {
      const repos: Awaited<ReturnType<typeof octokit.repos.listForAuthenticatedUser>>['data'] = [];
      for await (const response of octokit.paginate.iterator(
        octokit.repos.listForAuthenticatedUser,
        { per_page: 100, sort: 'pushed' },
      )) {
        repos.push(...response.data);
      }

      for (const repo of repos) {
        await this.prisma.gitHubRepository.upsert({
          where: {
            githubAccountId_githubRepoId: {
              githubAccountId: accountId,
              githubRepoId: String(repo.id),
            },
          },
          update: {
            owner: repo.owner.login,
            name: repo.name,
            fullName: repo.full_name,
            description: repo.description ?? null,
            isPrivate: repo.private,
            defaultBranch: repo.default_branch,
            language: repo.language ?? null,
            topics: repo.topics ?? [],
            htmlUrl: repo.html_url,
            cloneUrl: repo.clone_url ?? '',
            sshUrl: repo.ssh_url ?? '',
            openIssuesCount: repo.open_issues_count ?? 0,
            starCount: repo.stargazers_count ?? 0,
            forkCount: repo.forks_count ?? 0,
            lastPushedAt: repo.pushed_at ? new Date(repo.pushed_at) : null,
          },
          create: {
            githubAccountId: accountId,
            githubRepoId: String(repo.id),
            owner: repo.owner.login,
            name: repo.name,
            fullName: repo.full_name,
            description: repo.description ?? null,
            isPrivate: repo.private,
            defaultBranch: repo.default_branch,
            language: repo.language ?? null,
            topics: repo.topics ?? [],
            htmlUrl: repo.html_url,
            cloneUrl: repo.clone_url ?? '',
            sshUrl: repo.ssh_url ?? '',
            openIssuesCount: repo.open_issues_count ?? 0,
            starCount: repo.stargazers_count ?? 0,
            forkCount: repo.forks_count ?? 0,
            lastPushedAt: repo.pushed_at ? new Date(repo.pushed_at) : null,
          },
        });
      }

      await this.prisma.gitHubAccount.update({
        where: { id: accountId },
        data: { repoCount: repos.length, lastSyncedAt: new Date() },
      });

      this.logger.log(`Synced ${repos.length} repos for account ${accountId}`);
    } catch (err: any) {
      this.logger.error(`Repo sync failed for ${accountId}: ${err.message}`);
      throw err;
    }
  }

  async getRepositories(userId: string, accountId?: string) {
    const where: any = { githubAccount: { userId } };
    if (accountId) where.githubAccountId = accountId;

    return this.prisma.gitHubRepository.findMany({
      where,
      include: { githubAccount: { select: { githubUsername: true, avatarUrl: true } } },
      orderBy: { lastPushedAt: 'desc' },
    });
  }

  async syncAssignedIssues(userId: string, accountId?: string): Promise<number> {
    const accounts = await this.prisma.gitHubAccount.findMany({
      where: {
        userId,
        isActive: true,
        isValid: true,
        ...(accountId ? { id: accountId } : {}),
      },
    });

    let totalSynced = 0;
    for (const account of accounts) {
      const rawToken = this.decryptToken(account.encryptedToken);
      const synced = await this.syncAccountIssues(account.id, account.githubUsername, rawToken);
      totalSynced += synced;
    }

    return totalSynced;
  }

  private async syncAccountIssues(accountId: string, username: string, rawToken: string): Promise<number> {
    const octokit = this.getOctokit(rawToken);

    try {
      // Use search API to find ALL issues assigned to the user across any repo
      const searchResults: any[] = [];
      for await (const response of octokit.paginate.iterator(octokit.search.issuesAndPullRequests, {
        q: `assignee:${username} is:issue is:open`,
        per_page: 100,
      })) {
        searchResults.push(...response.data);
      }

      let synced = 0;

      for (const issue of searchResults) {
        const repoUrl: string = issue.repository_url ?? '';
        const fullName = repoUrl.replace('https://api.github.com/repos/', '');
        const [owner, repoName] = fullName.split('/');
        if (!owner || !repoName) continue;

        // Find or auto-create the repository record
        let repoRecord = await this.prisma.gitHubRepository.findFirst({
          where: { githubAccountId: accountId, fullName },
        });

        if (!repoRecord) {
          // Fetch repo details so we can store it properly
          let repoData: any = {};
          try {
            const { data } = await octokit.repos.get({ owner, repo: repoName });
            repoData = data;
          } catch {
            repoData = { id: 0, full_name: fullName, name: repoName, private: false, default_branch: 'main', language: null, description: null, stargazers_count: 0, open_issues_count: 0, clone_url: `https://github.com/${fullName}.git`, pushed_at: null };
          }
          repoRecord = await this.prisma.gitHubRepository.upsert({
            where: { githubAccountId_githubRepoId: { githubAccountId: accountId, githubRepoId: String(repoData.id || fullName) } },
            update: {},
            create: {
              githubAccountId: accountId,
              githubRepoId: String(repoData.id || fullName),
              name: repoName,
              fullName,
              owner,
              isPrivate: repoData.private ?? false,
              defaultBranch: repoData.default_branch ?? 'main',
              language: repoData.language ?? null,
              description: repoData.description ?? null,
              starCount: repoData.stargazers_count ?? 0,
              openIssuesCount: repoData.open_issues_count ?? 0,
              htmlUrl: repoData.html_url ?? `https://github.com/${fullName}`,
              cloneUrl: repoData.clone_url ?? `https://github.com/${fullName}.git`,
              sshUrl: repoData.ssh_url ?? `git@github.com:${fullName}.git`,
              lastPushedAt: repoData.pushed_at ? new Date(repoData.pushed_at) : null,
            },
          });
        }

        // Fetch comments
        let comments: any[] = [];
        try {
          const { data } = await octokit.issues.listComments({ owner, repo: repoName, issue_number: issue.number, per_page: 50 });
          comments = data.map((c) => ({ id: c.id, user: c.user?.login, body: c.body, createdAt: c.created_at }));
        } catch { /* non-fatal */ }

        const issueFields = {
          title: issue.title,
          body: issue.body ?? null,
          state: issue.state,
          labels: (issue.labels ?? []).map((l: any) => typeof l === 'string' ? { name: l } : { name: l.name, color: l.color }),
          assignees: (issue.assignees ?? []).map((a: any) => ({ login: a.login, avatar_url: a.avatar_url })),
          comments,
          htmlUrl: issue.html_url,
          lastGithubSync: new Date(),
          closedAt: issue.closed_at ? new Date(issue.closed_at) : null,
        };

        await this.prisma.assignedIssue.upsert({
          where: { repositoryId_issueNumber: { repositoryId: repoRecord.id, issueNumber: issue.number } },
          update: issueFields,
          create: {
            githubAccountId: accountId,
            repositoryId: repoRecord.id,
            githubIssueId: String(issue.id),
            issueNumber: issue.number,
            ...issueFields,
          },
        });
        synced++;
      }

      await this.prisma.gitHubAccount.update({
        where: { id: accountId },
        data: { openIssueCount: synced, lastSyncedAt: new Date() },
      });

      this.logger.log(`Synced ${synced} issues for account ${accountId}`);
      return synced;
    } catch (err: any) {
      this.logger.error(`Issue sync failed for account ${accountId}: ${err.message}`);
      throw err;
    }
  }

  async getAssignedIssues(userId: string, filters?: {
    accountId?: string;
    repositoryId?: string;
    state?: string;
    aiStatus?: string;
    label?: string;
  }) {
    const where: any = {
      githubAccount: { userId },
    };

    if (filters?.accountId) where.githubAccountId = filters.accountId;
    if (filters?.repositoryId) where.repositoryId = filters.repositoryId;
    if (filters?.state) where.state = filters.state;
    if (filters?.aiStatus) where.aiStatus = filters.aiStatus;

    return this.prisma.assignedIssue.findMany({
      where,
      include: {
        repository: {
          select: { name: true, fullName: true, owner: true, defaultBranch: true, language: true },
        },
        githubAccount: {
          select: { githubUsername: true, avatarUrl: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Returns the decrypted token for internal use by other services */
  async getDecryptedToken(accountId: string): Promise<string> {
    const account = await this.prisma.gitHubAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException('GitHub account not found');
    return this.decryptToken(account.encryptedToken);
  }

  private formatAccount(account: any): GitHubAccountSummary {
    return {
      id: account.id,
      githubUsername: account.githubUsername,
      githubEmail: account.githubEmail,
      avatarUrl: account.avatarUrl,
      accountType: account.accountType,
      repoCount: account.repoCount,
      openIssueCount: account.openIssueCount,
      isValid: account.isValid,
      lastSyncedAt: account.lastSyncedAt,
      lastValidatedAt: account.lastValidatedAt,
      tokenLastFour: account.tokenLastFour,
      createdAt: account.createdAt,
    };
  }
}
