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

  async executeTask(id: string, executor: (task: Task) => Promise<string>): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }

    const activeCount = this.getActiveTasks().length;
    if (activeCount >= this.config.maxConcurrentTasks) {
      throw new Error('Max concurrent tasks reached');
    }

    task.state = 'RUNNING';
    task.updatedAt = new Date();

    try {
      const result = await executor(task);
      task.state = 'DONE';
      task.result = result;
    } catch (error: any) {
      task.state = 'FAILED';
      task.error = error.message;
    }

    task.updatedAt = new Date();

    if (this.onComplete) {
      this.onComplete(task);
    }
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      return false;
    }

    if (task.state === 'PENDING' || task.state === 'RUNNING') {
      task.state = 'CANCELLED';
      task.updatedAt = new Date();
      return true;
    }

    return false;
  }

  removeTask(id: string): boolean {
    return this.tasks.delete(id);
  }
}
