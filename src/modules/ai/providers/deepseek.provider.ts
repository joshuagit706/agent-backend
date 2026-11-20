import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  IAIProvider,
  AICompletionOptions,
  AIResponse,
} from '../interfaces/ai-provider.interface.js';

@Injectable()
export class DeepSeekProvider implements IAIProvider {
  readonly name = 'deepseek';
  readonly displayName = 'DeepSeek';
  private readonly logger = new Logger(DeepSeekProvider.name);
  private client: OpenAI | null = null;

  constructor(private readonly configService: ConfigService) {
    const apiKey = configService.get<string>('ai.deepseekApiKey');
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com',
      });
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  isAvailableWithKey(apiKey?: string): boolean {
    return !!(apiKey || this.client);
  }

  async complete(options: AICompletionOptions, apiKeyOverride?: string): Promise<AIResponse> {
    const client = apiKeyOverride
      ? new OpenAI({ apiKey: apiKeyOverride, baseURL: 'https://api.deepseek.com' })
      : this.client;
    if (!client) {
      throw new Error('DeepSeek API key not configured');
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of options.messages) {
      if (msg.role === 'tool') {
        messages.push({
          role: 'tool',
          content: msg.content ?? '',
          tool_call_id: msg.tool_call_id ?? '',
        });
      } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: tc.function,
          })),
        });
      } else {
        messages.push({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content ?? '',
        });
      }
    }

    const tools: OpenAI.Chat.ChatCompletionTool[] | undefined = options.tools?.map((t) => ({
      type: 'function' as const,
      function: t.function,
    }));

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const response = await client.chat.completions.create({
          model: options.model,
          messages,
          tools: tools?.length ? tools : undefined,
          tool_choice: tools?.length ? 'auto' : undefined,
          max_tokens: options.maxTokens ?? 8192,
          temperature: options.temperature ?? 0.1,
        });

        const choice = response.choices[0];
        const toolCalls = choice.message.tool_calls?.map((tc: any) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));

        return {
          content: choice.message.content,
          toolCalls,
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          model: response.model,
          finishReason: choice.finish_reason ?? 'stop',
        };
      } catch (err: any) {
        attempts++;
        const isRateLimit = err.status === 429 || err.message?.includes('rate limit');
        const isRetryable = isRateLimit || err.status === 503 || err.status === 502;

        if (!isRetryable || attempts >= maxAttempts) {
          this.logger.error(`DeepSeek API error after ${attempts} attempts: ${err.message}`);
          throw err;
        }

        const delay = isRateLimit ? 30000 : 5000 * attempts;
        this.logger.warn(`DeepSeek API error, retrying in ${delay}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error('DeepSeek API: max retries exceeded');
  }
}
