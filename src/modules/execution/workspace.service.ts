import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly workspaceRoot: string;

  constructor() {
    this.workspaceRoot = process.env.EXECUTION_WORKSPACE ?? '/tmp/executions';
  }

  async createWorkspace(jobId: string): Promise<string> {
    const dir = path.join(this.workspaceRoot, jobId);
    await fs.mkdir(dir, { recursive: true });
    this.logger.debug(`Created workspace: ${dir}`);
    return dir;
  }

  async cleanupWorkspace(jobId: string): Promise<void> {
    const dir = path.join(this.workspaceRoot, jobId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      this.logger.debug(`Cleaned up workspace: ${dir}`);
    } catch (err: any) {
      this.logger.warn(`Workspace cleanup failed for ${jobId}: ${err.message}`);
    }
  }

  async listActiveWorkspaces(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async getWorkspaceSize(jobId: string): Promise<number> {
    const dir = path.join(this.workspaceRoot, jobId);
    try {
      const { stdout } = await execAsync(`du -sb "${dir}" 2>/dev/null | cut -f1`);
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  async cleanupStaleWorkspaces(maxAgeHours = 24): Promise<number> {
    let cleaned = 0;
    const workspaces = await this.listActiveWorkspaces();
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

    for (const name of workspaces) {
      const dir = path.join(this.workspaceRoot, name);
      try {
        const stat = await fs.stat(dir);
        if (stat.ctimeMs < cutoff) {
          await fs.rm(dir, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        // skip
      }
    }
    this.logger.log(`Cleaned up ${cleaned} stale workspaces`);
    return cleaned;
  }
}
