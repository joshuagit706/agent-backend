import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AIService } from './ai.service.js';
import { AIController } from './ai.controller.js';
import { DeepSeekProvider } from './providers/deepseek.provider.js';

@Module({
  imports: [ConfigModule],
  controllers: [AIController],
  providers: [AIService, DeepSeekProvider],
  exports: [AIService],
})
export class AIModule {}
