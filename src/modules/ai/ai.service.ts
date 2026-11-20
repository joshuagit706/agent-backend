import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DeepSeekProvider } from './providers/deepseek.provider.js';
import { IAIProvider, AICompletionOptions, AIResponse } from './interfaces/ai-provider.interface.js';
import { decrypt } from '../../common/crypto.util.js';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);
  private readonly providers: Map<string, IAIProvider> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deepSeek: DeepSeekProvider,
    private readonly configService: ConfigService,
  ) {
    this.providers.set('deepseek', deepSeek);
  }

  getProvider(name: string): IAIProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new NotFoundException(`AI provider '${name}' not found`);
    return provider;
  }

  getAvailableProviders(): Array<{ name: string; displayName: string; available: boolean }> {
    return Array.from(this.providers.values()).map((p) => ({
      name: p.name,
      displayName: p.displayName,
      available: p.isAvailable(),
    }));
  }

  private async getUserApiKey(userId: string, provider: string): Promise<string | null> {
    try {
      const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
      if (!settings?.encryptedApiKeys) return null;
      const blob = JSON.parse(settings.encryptedApiKeys);
      if (!blob[provider]) return null;
      const encKey = this.configService.get<string>('crypto.encryptionKey') ?? '';
      return decrypt(blob[provider], encKey);
    } catch { return null; }
  }

  async complete(
    providerName: string,
    options: AICompletionOptions,
    context?: { userId: string; executionJobId?: string },
  ): Promise<AIResponse> {
    const provider = this.getProvider(providerName);

    // Look up the user's own API key; fall back to the env-var key
    let userApiKey: string | undefined;
    if (context?.userId) {
      userApiKey = (await this.getUserApiKey(context.userId, providerName)) ?? undefined;
    }

    if (!userApiKey && !provider.isAvailable()) {
      throw new Error(`AI provider '${providerName}' is not configured. Add an API key in Settings.`);
    }

    const response = await (provider as DeepSeekProvider).complete(options, userApiKey);

    // Track token usage if context provided
    if (context) {
      await this.trackUsage(providerName, options.model, response, context);
    }

    return response;
  }

  private async trackUsage(
    providerName: string,
    modelId: string,
    response: AIResponse,
    context: { userId: string; executionJobId?: string },
  ): Promise<void> {
    try {
      const model = await this.prisma.aIModel.findFirst({
        where: { modelId, provider: { name: providerName } },
      });
      if (!model) return;

      const cost =
        (response.inputTokens / 1000) * model.inputCostPer1k +
        (response.outputTokens / 1000) * model.outputCostPer1k;

      await this.prisma.tokenUsage.create({
        data: {
          userId: context.userId,
          modelId: model.id,
          executionJobId: context.executionJobId ?? null,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          totalTokens: response.inputTokens + response.outputTokens,
          estimatedCost: cost,
          operation: 'completion',
        },
      });
    } catch (err: any) {
      this.logger.error(`Failed to track token usage: ${err.message}`);
    }
  }
}
