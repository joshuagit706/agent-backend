import { Module } from '@nestjs/common';
import { ExecutionGateway } from './execution.gateway.js';

@Module({
  providers: [ExecutionGateway],
  exports: [ExecutionGateway],
})
export class WebSocketModule {}
