import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/execution',
})
export class ExecutionGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ExecutionGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe-job')
  handleSubscribeJob(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    client.join(`job:${data.jobId}`);
    this.logger.debug(`Client ${client.id} subscribed to job ${data.jobId}`);
    return { event: 'subscribed', data: { jobId: data.jobId } };
  }

  @SubscribeMessage('unsubscribe-job')
  handleUnsubscribeJob(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    client.leave(`job:${data.jobId}`);
  }

  emitLog(jobId: string, log: { level: string; message: string; timestamp: Date; agentType?: string }) {
    this.server.to(`job:${jobId}`).emit('log', log);
  }

  emitStatusChange(jobId: string, status: string, activity?: string) {
    this.server.to(`job:${jobId}`).emit('status', { jobId, status, activity });
  }
}
