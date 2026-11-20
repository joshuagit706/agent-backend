import { registerAs } from '@nestjs/config';

export default registerAs('ai', () => ({
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
}));
