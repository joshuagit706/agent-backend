import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PrismaService } from '../../prisma/prisma.service.js';
import { GitHubService } from '../github/github.service.js';
import { Octokit } from '@octokit/rest';

const execAsync = promisify(exec);

@Injectable()
export class GitService {
  private readonly logger = new Logger(GitService.name);
  private readonly workspaceRoot: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly githubService: GitHubService,
  ) {
    this.workspaceRoot = process.env.EXECUTION_WORKSPACE ?? '/tmp/executions';
  }

  async consolidateBatch(batchId: string, userId: string): Promise<void> {
    const batch = await this.prisma.executionBatch.findFirst({
      where: { id: batchId, userId },
      include: {
        executionJobs: {
          where: { status: 'completed' },
          include: {
            issue: {
              include: { repository: true, githubAccount: true },
            },
            issueBranch: { where: { status: 'ready' } },
          },
        },
      },
    });

    if (!batch) throw new NotFoundException('Batch not found');

    // Group completed jobs by repository
    const repoGroups = new Map<string, typeof batch.executionJobs>();
    for (const job of batch.executionJobs) {
      if (!job.issueBranch) continue;
      const repoId = job.issue.repositoryId;
      if (!repoGroups.has(repoId)) repoGroups.set(repoId, []);
      repoGroups.get(repoId)!.push(job);
    }

    this.logger.log(`Consolidating ${repoGroups.size} repositories for batch ${batchId}`);

    for (const [repoId, jobs] of repoGroups) {
      await this.consolidateRepository(batchId, repoId, jobs, batch.branchPrefix);
    }

    // Check if all repos are done
    const allConsolidated = await this.prisma.consolidatedBranch.findMany({
      where: { batchId },
    });

    const allReady = allConsolidated.every((cb) =>
      ['ready', 'pr_created', 'merged'].includes(cb.status),
    );

    if (allReady) {
      await this.prisma.executionBatch.update({
        where: { id: batchId },
        data: { status: 'consolidated' },
      });
    }
  }

  private async consolidateRepository(
    batchId: string,
    repositoryId: string,
    jobs: any[],
    branchPrefix: string,
  ): Promise<void> {
    const repository = jobs[0].issue.repository;
    const githubAccount = jobs[0].issue.githubAccount;
    const consolidatedBranchName = `${branchPrefix}/batch-${repository.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

    this.logger.log(`Consolidating ${jobs.length} branches for ${repository.fullName}`);

    // Create or update consolidated branch record
    const consolidatedBranch = await this.prisma.consolidatedBranch.upsert({
      where: { batchId_repositoryId: { batchId, repositoryId } },
      update: { status: 'consolidating', branchName: consolidatedBranchName },
      create: {
        batchId,
        repositoryId,
        branchName: consolidatedBranchName,
        baseBranch: repository.defaultBranch,
        status: 'consolidating',
      },
    });

    const workDir = path.join(this.workspaceRoot, `consolidation-${batchId}-${repositoryId}`);

    try {
      await fs.mkdir(workDir, { recursive: true });

      const rawToken = await this.githubService.getDecryptedToken(githubAccount.id);
      const cloneUrl = repository.cloneUrl.replace('https://', `https://x-access-token:${rawToken}@`);

      // Clone from default branch
      await execAsync(`git clone --depth=100 "${cloneUrl}" "${workDir}" 2>&1`, { timeout: 120_000 });
      await execAsync(`git config user.email "ai@gitresolver.app"`, { cwd: workDir });
      await execAsync(`git config user.name "GitResolver AI"`, { cwd: workDir });
      await execAsync(`git fetch --all 2>&1`, { cwd: workDir, timeout: 60_000 });

      // Create consolidation branch from default branch
      await execAsync(
        `git checkout -b ${consolidatedBranchName} origin/${repository.defaultBranch} 2>&1`,
        { cwd: workDir },
      );

      const conflictFiles: string[] = [];
      const mergedIssues: number[] = [];
      const failedIssues: number[] = [];

      for (const job of jobs) {
        const issueBranch = job.issueBranch;
        const issueNumber = job.issue.issueNumber;

        try {
          this.logger.log(`Merging branch ${issueBranch.branchName} for issue #${issueNumber}`);

          // Attempt merge
          const { stdout, stderr } = await execAsync(
            `git merge --no-ff origin/${issueBranch.branchName} -m "Merge ai/issue-${issueNumber}: ${job.issue.title}" 2>&1`,
            { cwd: workDir },
          ).catch((err) => ({ stdout: '', stderr: err.message }));

          if (stderr.includes('CONFLICT') || stdout.includes('CONFLICT')) {
            this.logger.warn(`Conflict merging issue #${issueNumber}`);

            // Try to identify conflict files
            const { stdout: conflictList } = await execAsync(
              `git diff --name-only --diff-filter=U 2>&1`,
              { cwd: workDir },
            );
            conflictFiles.push(...conflictList.trim().split('\n').filter(Boolean));

            // Abort and skip this issue
            await execAsync('git merge --abort 2>&1', { cwd: workDir }).catch(() => {});
            failedIssues.push(issueNumber);
          } else {
            mergedIssues.push(issueNumber);

            // Link this issue branch to the consolidated branch
            await this.prisma.issueBranch.update({
              where: { id: issueBranch.id },
              data: { consolidatedBranchId: consolidatedBranch.id },
            });
          }
        } catch (err: any) {
          this.logger.error(`Failed to merge issue #${issueNumber}: ${err.message}`);
          failedIssues.push(issueNumber);
          await execAsync('git merge --abort 2>&1', { cwd: workDir }).catch(() => {});
        }
      }

      if (!mergedIssues.length) {
        await this.prisma.consolidatedBranch.update({
          where: { id: consolidatedBranch.id },
          data: {
            status: 'failed',
            conflictFiles,
            mergedIssues,
            failedIssues,
          },
        });
        await fs.rm(workDir, { recursive: true, force: true });
        return;
      }

      // Push consolidated branch
      await execAsync(`git push origin ${consolidatedBranchName} 2>&1`, {
        cwd: workDir,
        timeout: 60_000,
      });

      await this.prisma.consolidatedBranch.update({
        where: { id: consolidatedBranch.id },
        data: {
          status: 'ready',
          conflictFiles,
          mergedIssues,
          failedIssues,
        },
      });

      this.logger.log(
        `Consolidated branch ${consolidatedBranchName}: merged ${mergedIssues.length} issues, failed ${failedIssues.length}`,
      );
    } catch (err: any) {
      this.logger.error(`Consolidation failed for ${repository.fullName}: ${err.message}`);
      await this.prisma.consolidatedBranch.update({
        where: { id: consolidatedBranch.id },
        data: { status: 'failed' },
      });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async createPullRequest(consolidatedBranchId: string, userId: string) {
    const consolidated = await this.prisma.consolidatedBranch.findUnique({
      where: { id: consolidatedBranchId },
      include: {
        repository: true,
        batch: true,
        issueBranches: {
          include: {
            issue: { select: { issueNumber: true, title: true, githubAccount: true } },
          },
        },
      },
    });

    if (!consolidated) throw new NotFoundException('Consolidated branch not found');
    if (consolidated.status !== 'ready') {
      throw new Error(`Consolidated branch is not ready (status: ${consolidated.status})`);
    }

    // Check if PR already exists
    const existing = await this.prisma.pullRequest.findFirst({
      where: { consolidatedBranchId },
    });
    if (existing?.githubPrId) {
      this.logger.warn(`PR already exists for consolidated branch ${consolidatedBranchId}`);
      return existing;
    }

    const { repository, issueBranches } = consolidated;
    const mergedIssues = consolidated.mergedIssues as number[];
    const relevantBranches = issueBranches.filter((ib) =>
      mergedIssues.includes(ib.issue.issueNumber),
    );

    const githubAccount = relevantBranches[0]?.issue.githubAccount;
    if (!githubAccount) throw new Error('No GitHub account found for this repository');

    const rawToken = await this.githubService.getDecryptedToken(githubAccount.id);
    const octokit = new Octokit({ auth: rawToken });

    // Build PR body
    const issueList = relevantBranches
      .map((ib) => `- #${ib.issue.issueNumber}: ${ib.issue.title}`)
      .join('\n');

    const closingKeywords = mergedIssues.map((n) => `Closes #${n}`).join('\n');

    const prBody = `## AI Batch Resolution

This Pull Request was automatically generated by GitResolver AI.

### Resolved Issues

${issueList}

### Changes

This PR consolidates the following individual issue branches:
${relevantBranches.map((ib) => `- \`${ib.branchName}\``).join('\n')}

---

${closingKeywords}

> ⚠️ This PR was created by an AI agent. Please review all changes carefully before merging.`;

    const prTitle = `AI Batch Resolution: ${repository.name} Issues [${mergedIssues.map((n) => `#${n}`).join(', ')}]`;

    let prRecord = existing ?? (await this.prisma.pullRequest.create({
      data: {
        consolidatedBranchId,
        repositoryId: repository.id,
        title: prTitle,
        body: prBody,
        sourceBranch: consolidated.branchName,
        targetBranch: repository.defaultBranch,
        state: 'creating',
      },
    }));

    try {
      const { data: pr } = await octokit.pulls.create({
        owner: repository.owner,
        repo: repository.name,
        title: prTitle,
        body: prBody,
        head: consolidated.branchName,
        base: repository.defaultBranch,
        draft: false,
      });

      prRecord = await this.prisma.pullRequest.update({
        where: { id: prRecord.id },
        data: {
          githubPrId: String(pr.id),
          githubPrNumber: pr.number,
          htmlUrl: pr.html_url,
          state: 'open',
        },
      });

      await this.prisma.consolidatedBranch.update({
        where: { id: consolidatedBranchId },
        data: { status: 'pr_created' },
      });

      // Create closure records for each merged issue
      for (const ib of relevantBranches) {
        await this.prisma.issueClosureRecord.upsert({
          where: { issueId: ib.issueId },
          update: { status: 'pr_created' },
          create: {
            issueId: ib.issueId,
            pullRequestId: prRecord.id,
            status: 'pr_created',
          },
        });
      }

      this.logger.log(`Created PR #${pr.number} for ${repository.fullName}`);
    } catch (err: any) {
      await this.prisma.pullRequest.update({
        where: { id: prRecord.id },
        data: { state: 'failed' },
      });
      throw new Error(`Failed to create PR: ${err.message}`);
    }

    return prRecord;
  }

  async syncPullRequestStatus(prId: string): Promise<void> {
    const pr = await this.prisma.pullRequest.findUnique({
      where: { id: prId },
      include: {
        repository: true,
        consolidatedBranch: {
          include: {
            issueBranches: {
              include: { issue: { include: { githubAccount: true } } },
            },
          },
        },
      },
    });

    if (!pr || !pr.githubPrNumber) return;

    const githubAccount = pr.consolidatedBranch.issueBranches[0]?.issue.githubAccount;
    if (!githubAccount) return;

    const rawToken = await this.githubService.getDecryptedToken(githubAccount.id);
    const octokit = new Octokit({ auth: rawToken });

    try {
      const { data: ghPr } = await octokit.pulls.get({
        owner: pr.repository.owner,
        repo: pr.repository.name,
        pull_number: pr.githubPrNumber,
      });

      await this.prisma.pullRequest.update({
        where: { id: prId },
        data: {
          state: ghPr.state,
          mergedAt: ghPr.merged_at ? new Date(ghPr.merged_at) : null,
          closedAt: ghPr.closed_at ? new Date(ghPr.closed_at) : null,
        },
      });

      if (ghPr.merged) {
        // Sync issue closure status
        await this.syncIssureClosureOnMerge(pr, octokit);
      }
    } catch (err: any) {
      this.logger.error(`Failed to sync PR ${prId}: ${err.message}`);
    }
  }

  private async syncIssureClosureOnMerge(pr: any, octokit: Octokit): Promise<void> {
    const mergedIssues = pr.consolidatedBranch.mergedIssues as number[];

    for (const issueBranch of pr.consolidatedBranch.issueBranches) {
      if (!mergedIssues.includes(issueBranch.issue.issueNumber)) continue;

      try {
        const { data: issue } = await octokit.issues.get({
          owner: pr.repository.owner,
          repo: pr.repository.name,
          issue_number: issueBranch.issue.issueNumber,
        });

        if (issue.state === 'closed') {
          await this.prisma.issueClosureRecord.upsert({
            where: { issueId: issueBranch.issueId },
            update: {
              status: 'closed',
              closedAt: new Date(issue.closed_at ?? Date.now()),
              verifiedAt: new Date(),
            },
            create: {
              issueId: issueBranch.issueId,
              pullRequestId: pr.id,
              status: 'closed',
              closedAt: new Date(issue.closed_at ?? Date.now()),
              verifiedAt: new Date(),
            },
          });

          await this.prisma.assignedIssue.update({
            where: { id: issueBranch.issueId },
            data: { aiStatus: 'closed', state: 'closed' },
          });
        }
      } catch (err: any) {
        this.logger.error(`Failed to sync issue closure: ${err.message}`);
      }
    }
  }

  async getPullRequests(userId: string) {
    return this.prisma.pullRequest.findMany({
      where: {
        repository: { githubAccount: { userId } },
      },
      include: {
        repository: { select: { name: true, fullName: true, owner: true } },
        consolidatedBranch: {
          select: { mergedIssues: true, failedIssues: true, branchName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
