import { Injectable, NotFoundException } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service.js';
import { encrypt, decrypt } from '../../common/crypto.util.js';
import { ConfigService } from '@nestjs/config';

export class UpdateSettingsDto {
  @IsOptional() @IsInt() @Min(1) @Max(10)
  concurrencyLimit?: number;

  @IsOptional() @IsString()
  branchPrefix?: string;

  @IsOptional() @IsBoolean()
  requirePlanApproval?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(5)
  retryLimit?: number;

  @IsOptional() @IsString()
  defaultAiProvider?: string;

  @IsOptional() @IsString()
  defaultAiModel?: string;

  @IsOptional() @IsBoolean()
  emailNotifications?: boolean;

  @IsOptional() @IsString()
  theme?: string;
}

const SUPPORTED_PROVIDERS = ['deepseek', 'openai', 'anthropic'] as const;
type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private get encKey(): string {
    return this.configService.get<string>('crypto.encryptionKey') ?? '';
  }

  private async getApiKeyBlob(userId: string): Promise<Record<string, string>> {
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    if (!settings?.encryptedApiKeys) return {};
    try { return JSON.parse(settings.encryptedApiKeys); } catch { return {}; }
  }

  async getApiKeyStatus(userId: string): Promise<Record<ProviderName, boolean>> {
    const blob = await this.getApiKeyBlob(userId);
    return {
      deepseek: !!blob.deepseek,
      openai: !!blob.openai,
      anthropic: !!blob.anthropic,
    };
  }

  async setApiKey(userId: string, provider: string, apiKey: string): Promise<void> {
    if (!SUPPORTED_PROVIDERS.includes(provider as ProviderName)) {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    const blob = await this.getApiKeyBlob(userId);
    blob[provider] = encrypt(apiKey, this.encKey);
    await this.prisma.userSettings.update({
      where: { userId },
      data: { encryptedApiKeys: JSON.stringify(blob) },
    });
  }

  async removeApiKey(userId: string, provider: string): Promise<void> {
    const blob = await this.getApiKeyBlob(userId);
    delete blob[provider];
    await this.prisma.userSettings.update({
      where: { userId },
      data: { encryptedApiKeys: JSON.stringify(blob) },
    });
  }

  async getDecryptedApiKey(userId: string, provider: string): Promise<string | null> {
    const blob = await this.getApiKeyBlob(userId);
    if (!blob[provider]) return null;
    try { return decrypt(blob[provider], this.encKey); } catch { return null; }
  }

  async getSettings(userId: string) {
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    if (!settings) throw new NotFoundException('Settings not found');
    return settings;
  }

  async updateSettings(userId: string, dto: UpdateSettingsDto) {
    return this.prisma.userSettings.update({
      where: { userId },
      data: dto,
    });
  }

  async getStats(userId: string) {
    const [accounts, repoCount, issueCount, jobs, prs, closedCount, tokenData] = await Promise.all([
      this.prisma.gitHubAccount.count({ where: { userId, isActive: true } }),
      this.prisma.gitHubRepository.count({ where: { githubAccount: { userId } } }),
      this.prisma.assignedIssue.count({ where: { githubAccount: { userId } } }),
      this.prisma.executionJob.findMany({
        where: { batch: { userId } },
        select: { status: true },
      }),
      this.prisma.pullRequest.findMany({
        where: { repository: { githubAccount: { userId } } },
        select: { state: true },
      }),
      this.prisma.issueClosureRecord.count({
        where: { issue: { githubAccount: { userId } }, status: 'closed' },
      }),
      this.prisma.tokenUsage.aggregate({
        where: { userId },
        _sum: { estimatedCost: true, totalTokens: true },
      }),
    ]);

    const aiCompleted = jobs.filter((j) =>
      ['completed', 'pr_created', 'closed', 'awaiting_consolidation', 'awaiting_merge'].includes(j.status),
    ).length;
    const processing = jobs.filter((j) =>
      ['pending', 'analysing', 'awaiting_approval', 'implementing', 'testing', 'reviewing'].includes(j.status),
    ).length;
    const failed = jobs.filter((j) => j.status === 'failed').length;
    const prsCreated = prs.filter((p) => p.state !== 'pending' && p.state !== 'creating').length;
    const prsMerged = prs.filter((p) => p.state === 'merged').length;

    return {
      accounts,
      repos: repoCount,
      issues: issueCount,
      aiCompleted,
      processing,
      failed,
      prsCreated,
      prsMerged,
      issuesClosed: closedCount,
      totalTokens: tokenData._sum.totalTokens ?? 0,
      totalCost: tokenData._sum.estimatedCost ?? 0,
    };
  }

  async getUsageSummary(userId: string) {
    const usages = await this.prisma.tokenUsage.findMany({
      where: { userId },
      include: { model: { include: { provider: true } } },
    });

    const totalInput = usages.reduce((s, u) => s + u.inputTokens, 0);
    const totalOutput = usages.reduce((s, u) => s + u.outputTokens, 0);
    const totalCost = usages.reduce((s, u) => s + u.estimatedCost, 0);

    const byModel: Record<string, any> = {};
    for (const u of usages) {
      const key = u.model.modelId;
      if (!byModel[key]) byModel[key] = { model: u.model.displayName, provider: u.model.provider.displayName, inputTokens: 0, outputTokens: 0, cost: 0 };
      byModel[key].inputTokens += u.inputTokens;
      byModel[key].outputTokens += u.outputTokens;
      byModel[key].cost += u.estimatedCost;
    }

    return { totalInput, totalOutput, totalCost, byModel: Object.values(byModel) };
  }
}
