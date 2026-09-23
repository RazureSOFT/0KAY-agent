/**
 * Tool system for Agent
 */

export interface ToolResult {
  success: boolean;
  data: any;
  error?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export abstract class Tool {
  abstract get name(): string;
  abstract get description(): string;
  abstract execute(args: Record<string, any>): Promise<ToolResult>;
}

/**
 * File system tool for reading/writing files
 */
export class FileSystemTool extends Tool {
  get name(): string {
    return 'filesystem';
  }

  get description(): string {
    return 'Read and write files on the filesystem';
  }

  async execute(args: { action: string; path: string; content?: string }): Promise<ToolResult> {
    const fs = await import('fs/promises');

    try {
      switch (args.action) {
        case 'read':
          const content = await fs.readFile(args.path, 'utf-8');
          return { success: true, data: { content } };
        case 'write':
          await fs.writeFile(args.path, args.content || '');
          return { success: true, data: { path: args.path } };
        case 'list':
          const files = await fs.readdir(args.path);
          return { success: true, data: { files } };
        default:
          return { success: false, data: null, error: `Unknown action: ${args.action}` };
      }
    } catch (error: any) {
      return { success: false, data: null, error: error.message };
    }
  }
}

/**
 * Shell command tool
 */
export class ShellTool extends Tool {
  get name(): string {
    return 'shell';
  }

  get description(): string {
    return 'Execute shell commands';
  }

  async execute(args: { command: string; cwd?: string }): Promise<ToolResult> {
    const { execSync } = await import('child_process');

    try {
      const output = execSync(args.command, {
        cwd: args.cwd || process.cwd(),
        encoding: 'utf-8',
        timeout: 30000,
      });
      return { success: true, data: { output } };
    } catch (error: any) {
      return { success: false, data: null, error: error.message };
    }
  }
}

/**
 * Tool registry
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  async call(name: string, args: Record<string, any>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, data: null, error: `Tool '${name}' not found` };
    }
    return tool.execute(args);
  }

  listTools(): ToolSchema[] {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      parameters: {},
    }));
  }
}

/**
 * Create default tool registry
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new FileSystemTool());
  registry.register(new ShellTool());
  return registry;
}
