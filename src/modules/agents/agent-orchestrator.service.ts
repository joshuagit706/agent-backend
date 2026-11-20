import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { AIService } from '../ai/ai.service.js';
import { ToolExecutorService } from './tool-executor.service.js';
import { ExecutionService } from '../execution/execution.service.js';
import { GitHubService } from '../github/github.service.js';
import { BaseAgent } from './base-agent.js';
import {
  RESEARCH_AGENT_PROMPT,
  PLANNING_AGENT_PROMPT,
  CODING_AGENT_PROMPT,
  TESTING_AGENT_PROMPT,
  REVIEW_AGENT_PROMPT,
} from './agent-prompts.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Minimal env for git subprocesses — no secrets inherited
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL']) {
    if (process.env[k]) safe[k] = process.env[k];
  }
  return { ...safe, GIT_TERMINAL_PROMPT: '0', ...extra };
}

export interface OrchestrationContext {
  jobId: string;
  batchId: string;
  userId: string;
  issueId: string;
  branchPrefix: string;
  model?: string;
  providerName?: string;
  requirePlanApproval?: boolean;
  maxRetries?: number;
}

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);
  private readonly workspaceRoot: string;

  constructor(
    private readonly aiService: AIService,
    private readonly toolExecutor: ToolExecutorService,
    @Inject(forwardRef(() => ExecutionService))
    private readonly executionService: ExecutionService,
    private readonly githubService: GitHubService,
    private readonly prisma: PrismaService,
  ) {
    this.workspaceRoot = process.env.EXECUTION_WORKSPACE ?? '/tmp/executions';
  }

  async runJob(ctx: OrchestrationContext): Promise<void> {
    const { jobId, userId, issueId, branchPrefix } = ctx;

    const log = async (level: string, message: string, agentType?: string, metadata?: object) => {
      await this.executionService.appendLog(jobId, level, message, metadata, agentType);
      this.logger.log(`[${jobId}] [${agentType ?? 'orchestrator'}] ${message}`);
    };

    let workDir: string | null = null;

    try {
      // 1. Load issue and repo info
      const job = await this.prisma.executionJob.findUnique({
        where: { id: jobId },
        include: {
          issue: {
            include: {
              repository: true,
              githubAccount: true,
            },
          },
        },
      });

      if (!job) throw new Error(`Job ${jobId} not found`);
      const { issue } = job;
      const { repository, githubAccount } = issue;

      await log('info', `Starting execution for issue #${issue.issueNumber}: ${issue.title}`);

      // 2. Set up working directory — wipe any leftovers from a previous attempt.
      // Use execFile rm -rf because fs.rm struggles with deeply nested Rust target/ dirs.
      workDir = path.join(this.workspaceRoot, jobId);
      await execFileAsync('rm', ['-rf', workDir]).catch(() => null);
      await fs.mkdir(workDir, { recursive: true });

      await this.executionService.updateJobStatus(jobId, 'analysing', {
        currentAgent: 'research',
        currentActivity: 'Cloning repository',
        workingDirectory: workDir,
        startedAt: new Date(),
      });

      // 3. Clone the repository
      const rawToken = await this.githubService.getDecryptedToken(githubAccount.id);
      const branchName = `${branchPrefix}/issue-${issue.issueNumber}`;

      // Write a temporary GIT_ASKPASS script so the token never appears in argv or logs
      const askPassPath = path.join(this.workspaceRoot, `.askpass-${jobId}.sh`);
      await fs.writeFile(
        askPassPath,
        `#!/bin/sh\ncase "$1" in *Username*) echo "x-access-token";; *Password*) echo "$_GIT_PAT";; esac\n`,
        { mode: 0o700 },
      );

      await log('info', `Cloning ${repository.fullName}`);
      try {
        await execFileAsync('git', ['clone', '--depth=50', repository.cloneUrl, workDir], {
          timeout: 120_000,
          env: gitEnv({ GIT_ASKPASS: askPassPath, _GIT_PAT: rawToken }),
        });
      } finally {
        await fs.unlink(askPassPath).catch(() => {});
      }

      // Configure git identity
      await execFileAsync('git', ['config', 'user.email', 'ai@gitresolver.app'], { cwd: workDir, env: gitEnv() });
      await execFileAsync('git', ['config', 'user.name', 'GitResolver AI'], { cwd: workDir, env: gitEnv() });

      // Check if branch already exists remotely
      try {
        const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', branchName], {
          cwd: workDir, env: gitEnv({ _GIT_PAT: rawToken, GIT_ASKPASS: askPassPath }),
        });
        if (stdout.trim()) {
          await log('warn', `Branch ${branchName} already exists remotely, checking out`);
          await execFileAsync('git', ['checkout', '-b', branchName, `origin/${branchName}`], { cwd: workDir, env: gitEnv() });
        } else {
          await execFileAsync('git', ['checkout', '-b', branchName], { cwd: workDir, env: gitEnv() });
        }
      } catch {
        await execFileAsync('git', ['checkout', '-b', branchName], { cwd: workDir, env: gitEnv() });
      }

      // Create IssueBranch record
      await this.prisma.issueBranch.upsert({
        where: { issueId },
        update: { branchName, baseBranch: repository.defaultBranch, status: 'active' },
        create: {
          executionJobId: jobId,
          issueId,
          branchName,
          baseBranch: repository.defaultBranch,
          status: 'active',
        },
      });

      // 4. RESEARCH AGENT
      await log('info', 'Research agent starting', 'research');
      await this.executionService.updateJobStatus(jobId, 'analysing', {
        currentAgent: 'research',
        currentActivity: 'Analysing issue and repository',
      });

      const agent = new BaseAgent(this.aiService, this.toolExecutor);

      const issueContext = `
Issue #${issue.issueNumber}: ${issue.title}

Description:
${issue.body ?? '(no description)'}

Labels: ${JSON.stringify(issue.labels)}
Assignees: ${JSON.stringify(issue.assignees)}
Comments: ${JSON.stringify(issue.comments)}
Repository: ${repository.fullName}
Default branch: ${repository.defaultBranch}
Language: ${repository.language ?? 'unknown'}
`;

      const researchResult = await agent.run({
        systemPrompt: RESEARCH_AGENT_PROMPT,
        userMessage: `Analyse this issue and repository:\n\n${issueContext}`,
        workingDirectory: workDir,
        jobId,
        userId,
        model: ctx.model,
        providerName: ctx.providerName,
        readOnly: true,
        maxIterations: 25,
        onLog: async (level, message, metadata) => log(level, message, 'research', metadata),
      });

      if (!researchResult.success) {
        throw new Error(`Research agent failed: ${researchResult.error}`);
      }

      // Parse research result
      let analysis: any = {};
      try {
        const jsonMatch = researchResult.finalResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) analysis = JSON.parse(jsonMatch[0]);
      } catch {
        analysis = { understanding: researchResult.finalResponse };
      }

      // Check if the issue is suitable for automation
      if (['already_resolved', 'not_suitable', 'ambiguous', 'too_ambiguous'].includes(analysis.issueClassification)) {
        await log('warn', `Issue classified as: ${analysis.issueClassification}`);
        await this.executionService.updateJobStatus(jobId, 'failed', {
          errorMessage: `Issue classified as not suitable: ${analysis.issueClassification}. ${analysis.clarificationNeeded ?? ''}`,
          completedAt: new Date(),
        });
        await this.cleanup(workDir);
        return;
      }

      await this.prisma.executionJob.update({
        where: { id: jobId },
        data: { analysisResult: analysis },
      });

      // 5. PLANNING AGENT
      await log('info', 'Planning agent starting', 'planning');
      await this.executionService.updateJobStatus(jobId, 'analysing', {
        currentAgent: 'planning',
        currentActivity: 'Creating implementation plan',
      });

      const planResult = await agent.run({
        systemPrompt: PLANNING_AGENT_PROMPT,
        userMessage: `Create an implementation plan for this issue.\n\nIssue:\n${issueContext}\n\nResearch Analysis:\n${JSON.stringify(analysis, null, 2)}`,
        workingDirectory: workDir,
        jobId,
        userId,
        model: ctx.model,
        providerName: ctx.providerName,
        readOnly: true,
        maxIterations: 15,
        onLog: async (level, message, metadata) => log(level, message, 'planning', metadata),
      });

      let plan: any = {};
      try {
        const jsonMatch = planResult.finalResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) plan = JSON.parse(jsonMatch[0]);
      } catch {
        plan = { summary: planResult.finalResponse };
      }

      await this.prisma.executionJob.update({
        where: { id: jobId },
        data: { implementationPlan: plan },
      });

      if (ctx.requirePlanApproval) {
        await log('info', 'Awaiting plan approval', 'planning');
        await this.executionService.updateJobStatus(jobId, 'awaiting_approval', {
          currentActivity: 'Awaiting human approval of implementation plan',
        });
        // Job will be resumed when plan is approved via API
        return;
      }

      // 6. CODING AGENT
      await this.runCodingPhase(ctx, workDir, issueContext, analysis, plan, branchName, log);
    } catch (err: any) {
      await this.executionService.appendLog(jobId, 'error', `Fatal error: ${err.message}`);
      await this.executionService.updateJobStatus(jobId, 'failed', {
        errorMessage: err.message,
        completedAt: new Date(),
      });
      await this.prisma.issueBranch.updateMany({
        where: { executionJobId: jobId },
        data: { status: 'failed' },
      });
      if (workDir) await this.cleanup(workDir);
    }
  }

  async runCodingPhase(
    ctx: OrchestrationContext,
    workDir: string,
    issueContext: string,
    analysis: any,
    plan: any,
    branchName: string,
    log: (level: string, message: string, agentType?: string, metadata?: object) => Promise<void>,
  ): Promise<void> {
    const { jobId, userId, issueId } = ctx;
    const agent = new BaseAgent(this.aiService, this.toolExecutor);

    // 7. CODING AGENT
    await log('info', 'Coding agent starting', 'coding');
    await this.executionService.updateJobStatus(jobId, 'implementing', {
      currentAgent: 'coding',
      currentActivity: 'Implementing changes',
    });

    // Pre-load target file contents so the coding agent doesn't need to read them
    const targetFiles: string[] = (analysis as any).suggestedFilesToModify ?? [];
    const preloadedFiles: string[] = [];
    for (const filePath of targetFiles.slice(0, 6)) {
      try {
        const content = await fs.readFile(path.join(workDir, filePath), 'utf-8');
        const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n... [truncated]' : content;
        preloadedFiles.push(`=== ${filePath} ===\n${truncated}`);
      } catch { /* file may not exist yet */ }
    }

    const codingResult = await agent.run({
      systemPrompt: CODING_AGENT_PROMPT,
      userMessage: `Implement the following GitHub issue. The research and planning are DONE — your only job is to write code.\n\nIssue:\n${issueContext}\n\n=== IMPLEMENTATION PLAN (execute these steps in order) ===\n${JSON.stringify(plan, null, 2)}\n\n=== TARGET FILE CONTENTS (already loaded — do NOT read these files again, just write them) ===\n${preloadedFiles.join('\n\n')}\n\nStart writing with write_file immediately. Commit with git add -A && git commit when done.`,
      workingDirectory: workDir,
      jobId,
      userId,
      model: ctx.model,
      providerName: ctx.providerName,
      onLog: async (level, message, metadata) => log(level, message, 'coding', metadata),
      onToolCall: async (name, args) => {
        await this.executionService.updateJobStatus(jobId, 'implementing', {
          currentActivity: `${name}: ${args.path ?? args.command ?? ''}`,
        });
      },
    });

    if (!codingResult.success) {
      throw new Error(`Coding agent failed: ${codingResult.error}`);
    }

    // Check if any changes were committed
    let filesModified: string[] = [];
    try {
      const { stdout: files } = await execFileAsync('git', ['diff', 'HEAD~1', 'HEAD', '--name-only'], { cwd: workDir, env: gitEnv() });
      filesModified = files.trim().split('\n').filter(Boolean);
    } catch {}

    await this.prisma.issueBranch.updateMany({
      where: { executionJobId: jobId },
      data: { filesModified },
    });

    if (filesModified.length === 0) {
      await log('warn', 'Coding agent made no commits — skipping testing and failing job');
      await this.executionService.updateJobStatus(jobId, 'failed', {
        errorMessage: 'Coding agent did not commit any changes. The issue may be too complex or require clarification.',
        completedAt: new Date(),
      });
      await this.prisma.assignedIssue.update({
        where: { id: issueId },
        data: { aiStatus: 'pending' },
      });
      await this.cleanup(workDir);
      return;
    }

    // 8. TESTING AGENT
    await log('info', 'Testing agent starting', 'testing');
    await this.executionService.updateJobStatus(jobId, 'testing', {
      currentAgent: 'testing',
      currentActivity: 'Running tests',
    });

    const testingResult = await agent.run({
      systemPrompt: TESTING_AGENT_PROMPT,
      userMessage: `Run tests for the repository and verify the implementation is correct.\n\nIssue context:\n${issueContext}`,
      workingDirectory: workDir,
      jobId,
      userId,
      model: ctx.model,
      providerName: ctx.providerName,
      maxIterations: 8,
      onLog: async (level, message, metadata) => log(level, message, 'testing', metadata),
    });

    let testReport: any = {};
    try {
      const jsonMatch = testingResult.finalResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) testReport = JSON.parse(jsonMatch[0]);
    } catch {
      testReport = { testsPassed: false, issues: [testingResult.finalResponse] };
    }

    await this.prisma.testResult.create({
      data: {
        executionJobId: jobId,
        testRunner: 'auto-detected',
        passed: testReport.passed ?? 0,
        failed: testReport.failed ?? 0,
        skipped: testReport.skipped ?? 0,
        output: testingResult.finalResponse,
        phase: 'issue',
      },
    });

    // 9. REVIEW AGENT
    await log('info', 'Review agent starting', 'review');
    await this.executionService.updateJobStatus(jobId, 'reviewing', {
      currentAgent: 'review',
      currentActivity: 'Reviewing implementation',
    });

    const reviewResult = await agent.run({
      systemPrompt: REVIEW_AGENT_PROMPT,
      userMessage: `Review the implementation for issue #${issueContext}\n\nTest results:\n${JSON.stringify(testReport, null, 2)}`,
      workingDirectory: workDir,
      jobId,
      userId,
      model: ctx.model,
      providerName: ctx.providerName,
      readOnly: true,
      onLog: async (level, message, metadata) => log(level, message, 'review', metadata),
    });

    let reviewReport: any = {};
    try {
      const jsonMatch = reviewResult.finalResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) reviewReport = JSON.parse(jsonMatch[0]);
    } catch {
      reviewReport = { approved: true, summary: reviewResult.finalResponse };
    }

    // Check if the job passed all checks
    const hasSecurityIssues = (reviewReport.securityIssues ?? []).length > 0;
    const hasCriticalBugs = (reviewReport.bugs ?? []).some((b: any) => b.severity === 'critical');
    const passed = !hasSecurityIssues && !hasCriticalBugs && (reviewReport.approved !== false);

    if (!passed) {
      await log('warn', `Review failed: ${reviewReport.summary}`);
      await this.executionService.updateJobStatus(jobId, 'failed', {
        errorMessage: `Review failed: ${JSON.stringify(reviewReport)}`,
        completedAt: new Date(),
      });
      await this.prisma.issueBranch.updateMany({
        where: { executionJobId: jobId },
        data: { status: 'review_failed' },
      });
    } else {
      // Push the branch to remote
      try {
        await log('info', `Pushing branch ${branchName}`);
        await execFileAsync('git', ['push', 'origin', branchName], { cwd: workDir, timeout: 60_000, env: gitEnv() });

        const { stdout: commitSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workDir, env: gitEnv() });
        await this.prisma.issueBranch.updateMany({
          where: { executionJobId: jobId },
          data: { status: 'ready', commitSha: commitSha.trim() },
        });
      } catch (err: any) {
        await log('warn', `Could not push branch: ${err.message}`);
      }

      await this.executionService.updateJobStatus(jobId, 'completed', {
        currentActivity: 'Implementation complete',
        completedAt: new Date(),
      });
      await this.prisma.assignedIssue.update({
        where: { id: issueId },
        data: { aiStatus: 'completed' },
      });
      await log('info', 'Job completed successfully');
    }

    await this.cleanup(workDir);
  }

  private async cleanup(workDir: string): Promise<void> {
    try {
      await execFileAsync('rm', ['-rf', workDir]);
    } catch (err: any) {
      this.logger.warn(`Cleanup failed for ${workDir}: ${err.message}`);
    }
  }
}
