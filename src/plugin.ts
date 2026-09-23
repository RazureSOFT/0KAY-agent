/**
 * 0kay Agent Plugin
 *
 * Registers with Core via gRPC (protobuf), exposes AgentService for task
 * execution, and sends periodic heartbeats. All AI calls go through mocr.
 */

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { Agent } from './agent/agent.js'
import { TaskManager } from './task/task.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROTO_DIR = process.env.PROTO_DIR || path.resolve(__dirname, '../../proto')
const CORE_ADDRESS = process.env.CORE_ADDRESS || 'localhost:50051'
const AGENT_PORT = process.env.AGENT_GRPC_PORT || '50054'
const AGENT_ADDRESS = process.env.AGENT_ADDRESS || `localhost:${AGENT_PORT}`
const MOCR_ADDRESS = process.env.MOCR_ADDRESS || 'localhost:50052'

// Proto-loader options: camelCase field names, enums as strings
const loaderOptions: protoLoader.Options = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
}

let pluginId: string | null = null
let shuttingDown = false

/**
 * Load protobuf definitions from the shared proto/ directory.
 */
function loadProtos(): any {
  const files = [
    path.join(PROTO_DIR, 'core/v1/core.proto'),
    path.join(PROTO_DIR, 'agent/v1/agent.proto'),
    path.join(PROTO_DIR, 'plugin/v1/plugin.proto'),
    path.join(PROTO_DIR, 'mocr/v1/mocr.proto'),
  ]

  const packageDefinition = protoLoader.loadSync(files, loaderOptions)
  return grpc.loadPackageDefinition(packageDefinition) as any
}

/** Build host info for heartbeat (hostname/os/arch/cpu/mem/workdir). */
function buildHostInfo(): any {
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model || '',
    cpuCores: os.cpus().length || 0,
    memoryTotalBytes: os.totalmem(),
    memoryAvailableBytes: os.freemem(),
    workdir: process.cwd(),
  }
}

/**
 * Create a gRPC client for Core's PluginService.
 */
function createCoreClient(proto: any): any {
  const corePkg = proto.core?.v1
  if (!corePkg) {
    throw new Error('core.v1 package not found in proto definition')
  }
  return new corePkg.PluginService(
    CORE_ADDRESS,
    grpc.credentials.createInsecure()
  )
}

/**
 * Register this agent plugin with Core.
 */
async function registerWithCore(proto: any): Promise<string | null> {
  const client = createCoreClient(proto)

  const request = {
    pluginInfo: {
      name: 'agent',
      version: '0.1.0',
      description: '0kay Agent - Task execution engine',
      author: '0kay',
      pluginType: 'PLUGIN_TYPE_SERVICE',
    },
    capabilities: ['agent'],
    address: AGENT_ADDRESS,
    settingsSections: [
      {
        id: 'agent',
        label: 'Agent',
        icon: 'chip',
        order: 70,
        description: 'Agent 运行时设置（模型固定、循环上限、工具开关）',
        fields: [
          {
            key: 'model_id',
            type: 'text',
            label: '固定模型',
            defaultValue: '',
            help: '留空 = 每次迭代由 mocr ChooseModels 自动选型',
          },
          {
            key: 'temperature',
            type: 'number',
            label: '温度',
            defaultValue: '0.7',
            help: 'Agent LLM 采样温度（0–2）',
          },
          {
            key: 'max_iterations',
            type: 'number',
            label: '最大迭代次数',
            defaultValue: '10',
            help: '单个任务的最大 Agent 循环次数',
          },
          {
            key: 'max_concurrent_tasks',
            type: 'number',
            label: '最大并发任务',
            defaultValue: '5',
            help: '同时运行的任务上限',
          },
          {
            key: 'default_agent_type',
            type: 'select',
            label: '默认 Agent 类型',
            defaultValue: 'general',
            options: ['general', 'code', 'research'],
            help: 'ExecuteTask 未指定类型时使用',
          },
          {
            key: 'enable_shell_tool',
            type: 'bool',
            label: 'Shell 工具',
            defaultValue: 'true',
            help: '允许 Agent 执行 shell 命令',
          },
          {
            key: 'enable_filesystem_tool',
            type: 'bool',
            label: '文件系统工具',
            defaultValue: 'true',
            help: '允许 Agent 读写文件',
          },
          {
            key: 'enable_skills',
            type: 'bool',
            label: '技能系统',
            defaultValue: 'true',
            help: '加载并注入 Agent 技能（与 L.I.F.E 技能分离）',
          },
          {
            key: 'skills_dir',
            type: 'text',
            label: '技能目录',
            defaultValue: '',
            help: '留空 = 使用内置 + agent/skills/*.md；可指向自定义目录',
          },
        ],
      },
    ],
  }

  return new Promise((resolve) => {
    const deadline = new Date(Date.now() + 5000)
    client.waitForReady(deadline, (err: Error | null) => {
      if (err) {
        console.error('[Agent] Core not ready:', err.message)
        resolve(null)
        return
      }

      client.Register(request, (err: grpc.ServiceError | null, resp: any) => {
        if (err) {
          console.error('[Agent] Register failed:', err.message)
          resolve(null)
        } else {
          console.log(`[Agent] Registered with Core: plugin_id=${resp.pluginId}`)
          resolve(resp.pluginId)
        }
      })
    })
  })
}

/**
 * Send a heartbeat to Core.
 */
function sendHeartbeat(proto: any): void {
  if (!pluginId || shuttingDown) return

  const client = createCoreClient(proto)
  const activeTasks = taskManager.getActiveTasks().length

  const request = {
    pluginId,
    status: 'PLUGIN_STATUS_HEALTHY',
    activeTasks,
    host: buildHostInfo(),
  }

  client.Heartbeat(request, (err: grpc.ServiceError | null, resp: any) => {
    if (err) {
      console.warn('[Agent] Heartbeat failed:', err.message)
      // Try to re-register if we lost connection
      if (err.code === grpc.status.UNAVAILABLE || err.code === grpc.status.NOT_FOUND) {
        console.log('[Agent] Attempting to re-register...')
        pluginId = null
        registerWithCore(proto).then((id) => {
          if (id) pluginId = id
        })
      }
    } else if (resp?.shutdownSignal) {
      console.log('[Agent] Received shutdown signal from Core')
      shutdown()
    }
  })
}

// Shared agent + task manager
const agent = new Agent({ mocrAddress: MOCR_ADDRESS })
const taskManager = agent.getTaskManager()

const CORE_HTTP = process.env.CORE_HTTP_ADDR || 'http://127.0.0.1:8080'
let settingsPollTimer: NodeJS.Timeout | null = null

/**
 * Poll Core for saved Agent settings and apply them to the runtime.
 */
async function pollAgentSettings(): Promise<void> {
  try {
    const res = await fetch(`${CORE_HTTP}/api/settings/agent`)
    if (!res.ok) return
    const body = await res.json()
    const values = body?.values || {}
    agent.applySettings({
      model_id: typeof values.model_id === 'string' ? values.model_id : '',
      temperature: Number(values.temperature ?? 0.7),
      max_iterations: Number(values.max_iterations ?? 10),
      max_concurrent_tasks: Number(values.max_concurrent_tasks ?? 5),
      default_agent_type:
        typeof values.default_agent_type === 'string' ? values.default_agent_type : 'general',
      enable_shell_tool: values.enable_shell_tool !== false,
      enable_filesystem_tool: values.enable_filesystem_tool !== false,
      enable_skills: values.enable_skills !== false,
      skills_dir: typeof values.skills_dir === 'string' ? values.skills_dir : '',
    })
    taskManager.setMaxConcurrentTasks(Number(values.max_concurrent_tasks ?? 5))
  } catch {
    // Core HTTP not reachable — keep current settings
  }
}

/**
 * Start the AgentService gRPC server.
 */
function startAgentService(proto: any): Promise<number> {
  const agentPkg = proto.agent?.v1
  if (!agentPkg) {
    return Promise.reject(new Error('agent.v1 package not found'))
  }

  const server = new grpc.Server()

  server.addService(agentPkg.AgentService.service, {
    ExecuteTask: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      const { taskId, prompt, agentType, metadata } = call.request
      console.log(`[Agent] ExecuteTask ${taskId}: ${prompt.substring(0, 80)}...`)

      try {
        const result = await agent.executeTask(taskId, prompt, agentType)
        callback(null, {
          taskId,
          state: 'TASK_STATE_DONE',
          result,
          metadata: metadata || {},
        })
      } catch (error: any) {
        console.error(`[Agent] Task ${taskId} failed:`, error.message)
        callback(null, {
          taskId,
          state: 'TASK_STATE_FAILED',
          error: error.message,
          metadata: metadata || {},
        })
      }
    },

    CancelTask: (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      const { taskId } = call.request
      console.log(`[Agent] CancelTask ${taskId}`)
      const success = taskManager.cancelTask(taskId)
      callback(null, {
        success,
        message: success ? 'Task cancelled' : 'Task not found or not cancellable',
      })
    },

    GetTaskStatus: (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      const { taskId } = call.request
      const task = taskManager.getTask(taskId)
      if (!task) {
        callback(null, { taskId, state: 'TASK_STATE_UNSPECIFIED' })
        return
      }
      const stateMap: Record<string, string> = {
        PENDING: 'TASK_STATE_PENDING',
        RUNNING: 'TASK_STATE_RUNNING',
        DONE: 'TASK_STATE_DONE',
        FAILED: 'TASK_STATE_FAILED',
        CANCELLED: 'TASK_STATE_CANCELLED',
      }
      callback(null, {
        taskId,
        state: stateMap[task.state] || 'TASK_STATE_UNSPECIFIED',
        result: task.result || '',
        error: task.error || '',
      })
    },

    RunDirect: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      const { tool, args, sessionId } = call.request
      console.log(`[Agent] RunDirect tool=${tool} session=${sessionId || '-'}`)
      try {
        const res = await agent.runDirect(tool || '', args || '')
        callback(null, {
          success: res.success,
          result: res.result,
          error: res.error,
        })
      } catch (error: any) {
        callback(null, {
          success: false,
          result: '',
          error: error?.message || 'RunDirect failed',
        })
      }
    },
  })

  return new Promise((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${AGENT_PORT}`,
      grpc.ServerCredentials.createInsecure(),
      (err, boundPort) => {
        if (err) {
          reject(err)
        } else {
          console.log(`[Agent] AgentService listening on :${boundPort}`)
          resolve(boundPort)
        }
      }
    )
  })
}

/**
 * Graceful shutdown.
 */
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  if (settingsPollTimer) clearInterval(settingsPollTimer)
  console.log('[Agent] Shutting down...')
  process.exit(0)
}

/**
 * Main entry: start server, register with Core, start heartbeat loop.
 */
export async function startPlugin(): Promise<void> {
  console.log('[Agent] Loading protos from', PROTO_DIR)
  const proto = loadProtos()

  // 1. Start AgentService server
  await startAgentService(proto)

  // 2. Register with Core (retry a few times if Core isn't up yet)
  for (let attempt = 1; attempt <= 10; attempt++) {
    const id = await registerWithCore(proto)
    if (id) {
      pluginId = id
      break
    }
    console.log(`[Agent] Register attempt ${attempt}/10 failed, retrying in 2s...`)
    await new Promise((r) => setTimeout(r, 2000))
  }

  if (!pluginId) {
    console.error('[Agent] Failed to register with Core after 10 attempts')
  }

  // 3. Heartbeat every 10s (Core timeout is 30s)
  setInterval(() => sendHeartbeat(proto), 10_000)

  // First heartbeat soon after registration
  setTimeout(() => sendHeartbeat(proto), 1000)

  // 3b. Pull Agent settings section (model pin, limits, tool toggles)
  await pollAgentSettings()
  settingsPollTimer = setInterval(pollAgentSettings, 15_000)

  // 4. Handle shutdown signals
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log('[Agent] Plugin started')
}
