import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import {
  appConfig,
  jwtConfig,
  databaseConfig,
  redisConfig,
  cryptoConfig,
  aiConfig,
} from './config/index.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { GitHubModule } from './modules/github/github.module.js';
import { AIModule } from './modules/ai/ai.module.js';
import { ExecutionModule } from './modules/execution/execution.module.js';
import { AgentsModule } from './modules/agents/agents.module.js';
import { QueueModule } from './modules/queue/queue.module.js';
import { GitModule } from './modules/git/git.module.js';
import { WebSocketModule } from './modules/websocket/websocket.module.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, jwtConfig, databaseConfig, redisConfig, cryptoConfig, aiConfig],
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60000, limit: 100 },   // 100 req/min globally
      { name: 'auth',    ttl: 60000, limit: 10  },   // 10 req/min on auth endpoints
    ]),
    PrismaModule,
    AuthModule,
    GitHubModule,
    AIModule,
    ExecutionModule,
    AgentsModule,
    QueueModule,
    GitModule,
    WebSocketModule,
    UsersModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
