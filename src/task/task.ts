/**
 * Task manager for Agent - handles task lifecycle
 */

export type TaskState = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface Task {
  id: string;
  prompt: string;
  agentType: string;
  state: TaskState;
  result?: string;
  error?: string;
  metadata: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskManagerConfig {
  maxConcurrentTasks: number;
}

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private config: TaskManagerConfig;
  private onComplete?: (task: Task) => void;
  private controllers = new Map<string, AbortController>();
  private waiters: Array<() => void> = [];
  private running = 0;

  constructor(config: Partial<TaskManagerConfig> = {}) {
    this.config = {
      maxConcurrentTasks: config.maxConcurrentTasks || 5,
    };
  }

  setOnComplete(callback: (task: Task) => void): void {
    this.onComplete = callback;
  }

  setMaxConcurrentTasks(n: number): void {
    if (Number.isFinite(n) && n >= 1) {
      this.config.maxConcurrentTasks = Math.floor(n);
      this.wake();
    }
  }

  notifyComplete(task: Task): void {
    if (this.onComplete) {
      this.onComplete(task);
    }
  }

  createTask(
    id: string,
    prompt: string,
    agentType: string = 'default',
    metadata: Record<string, string> = {}
  ): Task {
    if (this.tasks.has(id)) throw new Error(`Task ${id} already exists`);
    const task: Task = {
      id,
      prompt,
      agentType,
      state: 'PENDING',
      metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.tasks.set(id, task);
    this.controllers.set(id, new AbortController());
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getActiveTasks(): Task[] {
    return this.getAllTasks().filter(t => t.state === 'PENDING' || t.state === 'RUNNING');
  }

  signal(id: string): AbortSignal {
    const controller = this.controllers.get(id);
    if (!controller) throw new Error(`Task ${id} not found`);
    return controller.signal;
  }

  private wake(): void {
    const waiting = this.waiters.splice(0);
    for (const resolve of waiting) resolve();
  }

  async executeTask(id: string, executor: (task: Task) => Promise<string>, nested = false): Promise<string> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }

    let acquired = false;
    try {
      while (!nested && this.running >= this.config.maxConcurrentTasks) {
        this.signal(id).throwIfAborted();
        await new Promise<void>(resolve => this.waiters.push(resolve));
      }
      this.signal(id).throwIfAborted();
      if (!nested) { this.running++; acquired = true; }
      task.state = 'RUNNING';
      task.updatedAt = new Date();
      const result = await executor(task);
      this.signal(id).throwIfAborted();
      task.state = 'DONE';
      task.result = result;
      return result;
    } catch (error: any) {
      task.state = this.signal(id).aborted ? 'CANCELLED' : 'FAILED';
      task.error = error.message;
      throw error;
    } finally {
      if (acquired) this.running--;
      task.updatedAt = new Date();
      this.wake();
      this.notifyComplete(task);
    }
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      return false;
    }

    if (task.state === 'PENDING' || task.state === 'RUNNING') {
      task.state = 'CANCELLED';
      this.controllers.get(id)?.abort(new Error('Task cancelled'));
      for (const child of this.tasks.values()) {
        if (child.id.startsWith(`${id}:sub:`)) this.cancelTask(child.id);
      }
      this.wake();
      task.updatedAt = new Date();
      return true;
    }

    return false;
  }

  removeTask(id: string): boolean {
    if (this.getActiveTasks().some(task => task.id === id)) return false;
    this.controllers.delete(id);
    return this.tasks.delete(id);
  }
}
