export interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AIResponse {
  content: string | null;
  toolCalls?: AIToolCall[];
  inputTokens: number;
  outputTokens: number;
  model: string;
  finishReason: string;
}

export interface AICompletionOptions {
  model: string;
  messages: AIMessage[];
  tools?: AITool[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface IAIProvider {
  readonly name: string;
  readonly displayName: string;
  complete(options: AICompletionOptions): Promise<AIResponse>;
  isAvailable(): boolean;
}
