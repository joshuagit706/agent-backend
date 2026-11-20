import { Logger } from '@nestjs/common';
import { AIService } from '../ai/ai.service.js';
import { ToolExecutorService, ToolExecutionContext } from './tool-executor.service.js';
import { AGENT_TOOLS, READ_ONLY_TOOLS } from './agent-tools.definition.js';
import {
  AIMessage,
  AITool,
  AIToolCall,
} from '../ai/interfaces/ai-provider.interface.js';

export interface AgentRunOptions {
  systemPrompt: string;
  userMessage: string;
  workingDirectory: string;
  jobId: string;
  userId: string;
  model?: string;
  providerName?: string;
  readOnly?: boolean;
  maxIterations?: number;
  onLog?: (level: string, message: string, metadata?: object) => Promise<void>;
  onToolCall?: (name: string, args: Record<string, any>) => Promise<void>;
}

export interface AgentResult {
  finalResponse: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  success: boolean;
  error?: string;
}

export class BaseAgent {
  protected readonly logger = new Logger(BaseAgent.name);

  constructor(
    protected readonly aiService: AIService,
    protected readonly toolExecutor: ToolExecutorService,
  ) {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const {
      systemPrompt,
      userMessage,
      workingDirectory,
      jobId,
      userId,
      model = 'deepseek-chat',
      providerName = 'deepseek',
      readOnly = false,
      maxIterations = 50,
      onLog,
      onToolCall,
    } = options;

    const log = async (level: string, message: string, metadata?: object) => {
      if (onLog) await onLog(level, message, metadata);
      else this.logger.debug(`[${jobId}] ${message}`);
    };

    const tools: AITool[] = readOnly ? READ_ONLY_TOOLS : AGENT_TOOLS;
    const messages: AIMessage[] = [{ role: 'user', content: userMessage }];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    let finalResponse = '';

    const toolCtx: ToolExecutionContext = {
      workingDirectory,
      jobId,
      onLog: (m) => log('info', m),
    };

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        await log('debug', `Agent iteration ${iteration + 1}/${maxIterations}`);

        const response = await this.aiService.complete(
          providerName,
          { model, messages, tools, systemPrompt, temperature: 0.1 },
          { userId, executionJobId: jobId },
        );

        totalInputTokens += response.inputTokens;
        totalOutputTokens += response.outputTokens;

        // If the model returned content, add it to conversation
        if (response.content) {
          messages.push({ role: 'assistant', content: response.content });
          finalResponse = response.content;
        }

        // If no tool calls, the agent is done
        if (!response.toolCalls?.length || response.finishReason === 'stop') {
          await log('info', 'Agent completed reasoning');
          break;
        }

        // Add the assistant message with tool calls, replacing the content-only
        // message pushed above (if any) so the history stays coherent.
        const assistantMsg: AIMessage = {
          role: 'assistant',
          content: response.content ?? null,
          tool_calls: response.toolCalls,
        };
        if (messages[messages.length - 1]?.role === 'assistant') {
          messages[messages.length - 1] = assistantMsg;
        } else {
          messages.push(assistantMsg);
        }

        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          await this.executeToolCall(toolCall, toolCtx, messages, log, onToolCall);
          toolCallCount++;
        }

        // Safety: if the last message is from the assistant with no pending tool results, stop
        if (iteration === maxIterations - 1) {
          await log('warn', `Reached max iterations (${maxIterations})`);
        }
      }

      return { finalResponse, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, toolCallCount, success: true };
    } catch (err: any) {
      await log('error', `Agent error: ${err.message}`);
      return { finalResponse, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, toolCallCount, success: false, error: err.message };
    }
  }

  private async executeToolCall(
    toolCall: AIToolCall,
    ctx: ToolExecutionContext,
    messages: AIMessage[],
    log: (level: string, message: string, metadata?: object) => Promise<void>,
    onToolCall?: (name: string, args: Record<string, any>) => Promise<void>,
  ): Promise<void> {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      args = {};
    }

    await log('info', `Tool call: ${toolCall.function.name}`, { args: this.sanitizeArgs(args) });
    if (onToolCall) await onToolCall(toolCall.function.name, this.sanitizeArgs(args));

    const result = await this.toolExecutor.execute(toolCall.function.name, args, ctx);

    const toolResultContent = result.success
      ? result.output
      : `ERROR: ${result.error}\n${result.output}`;

    messages.push({
      role: 'tool',
      content: toolResultContent,
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
    });

    if (!result.success) {
      await log('warn', `Tool ${toolCall.function.name} failed: ${result.error}`);
    }
  }

  private sanitizeArgs(args: Record<string, any>): Record<string, any> {
    const safe = { ...args };
    // Don't log full file content
    if ('content' in safe && typeof safe.content === 'string' && safe.content.length > 200) {
      safe.content = `[${safe.content.length} chars]`;
    }
    return safe;
  }
}
