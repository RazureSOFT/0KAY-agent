import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Tool, type ToolContext, type ToolResult } from './types.js';
import { failure, success } from './helpers.js';

interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  child: ChildProcess;
  status: 'running' | 'exited';
  code: number | null;
  output: string;
}

const jobs = new Map<string, BackgroundJob>();
const MAX_OUTPUT = 200_000;

function append(job: BackgroundJob, chunk: Buffer | string): void {
  job.output += chunk.toString();
  if (job.output.length > MAX_OUTPUT) job.output = job.output.slice(-MAX_OUTPUT);
}

export class BackgroundTaskTool extends Tool {
  get name(): string {
    return 'background_task';
  }

  get description(): string {
    return 'Run and manage background commands (dev servers, watchers, long builds). ' +
      'Actions: start (command, cwd?) -> job id; list; output (id) -> tail; kill (id). ' +
      'Use this instead of a blocking shell call when a command never returns.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'list', 'output', 'kill'], description: 'What to do' },
        command: { type: 'string', description: 'Shell command (required for start)' },
        cwd: { type: 'string', description: 'Working directory (start; defaults to the task cwd)' },
        id: { type: 'string', description: 'Job id (output/kill)' },
        tail: { type: 'number', description: 'Lines of output to return (default 80)' },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const action = String(args.action || '');
    switch (action) {
      case 'start':
        return this.start(args, context);
      case 'list':
        return success({
          jobs: [...jobs.values()].map((job) => ({
            id: job.id,
            command: job.command,
            status: job.status,
            code: job.code,
            started_at: new Date(job.startedAt).toISOString(),
          })),
        });
      case 'output':
        return this.output(args);
      case 'kill':
        return this.kill(args);
      default:
        return failure('action must be one of: start, list, output, kill');
    }
  }

  private start(args: Record<string, any>, context: ToolContext): ToolResult {
    const command = String(args.command || '').trim();
    if (!command) return failure('command is required for start');
    const cwd = String(args.cwd || context.cwd || process.cwd());
    const id = `bg_${randomUUID().slice(0, 8)}`;
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const job: BackgroundJob = {
      id, command, cwd, startedAt: Date.now(), child,
      status: 'running', code: null, output: '',
    };
    child.stdout?.on('data', (chunk) => append(job, chunk));
    child.stderr?.on('data', (chunk) => append(job, chunk));
    child.on('error', (error) => append(job, `\n[spawn error] ${error.message}\n`));
    child.on('exit', (code) => {
      job.status = 'exited';
      job.code = code ?? null;
      append(job, `\n[exited with code ${code ?? 'null'}]\n`);
    });
    jobs.set(id, job);
    return success({ id, pid: child.pid, command, cwd, status: 'running' });
  }

  private output(args: Record<string, any>): ToolResult {
    const id = String(args.id || '');
    const job = jobs.get(id);
    if (!job) return failure(`unknown job: ${id}`);
    const tail = Math.max(1, Math.min(1000, Number(args.tail) || 80));
    const lines = job.output.split(/\r?\n/);
    return success({
      id: job.id,
      status: job.status,
      code: job.code,
      text: lines.slice(-tail).join('\n'),
    });
  }

  private kill(args: Record<string, any>): ToolResult {
    const id = String(args.id || '');
    const job = jobs.get(id);
    if (!job) return failure(`unknown job: ${id}`);
    if (job.status === 'exited') return success({ id, status: 'exited', code: job.code });
    try {
      if (process.platform === 'win32' && job.child.pid) {
        spawn('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        job.child.kill('SIGTERM');
      }
      job.status = 'exited';
      return success({ id, status: 'killed' });
    } catch (error: any) {
      return failure(`kill failed: ${error?.message || String(error)}`);
    }
  }
}
