/**
 * A worked example of the module half of an agent plugin.
 *
 * Two things worth copying from this file:
 *
 * 1. The hook returns a refusal instead of throwing. A plugin that throws is
 *    logged and ignored, because a broken plugin must not be able to stop a
 *    task; a refusal is a decision, and the model sees it as the tool's result.
 * 2. The tool it adds is declared like any other tool, so it inherits approval,
 *    the sandbox, and the tool groups. Nothing here bypasses those.
 */

const SECRET_NAMES = /(^|[/\\])(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|credentials(\.json)?)$/i

export default function register(api) {
  api.log(`loaded from ${api.dir}`)

  api.addTool({
    name: 'secret_scan',
    description: 'List files under a directory whose names look like credentials. Read-only.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory to scan.' } },
      required: ['path'],
    },
    async execute(args, context) {
      const fs = await import('fs/promises')
      const path = await import('path')
      const root = path.resolve(context.cwd, String(args.path || '.'))
      const found = []
      const walk = async (dir, depth) => {
        if (depth > 4) return
        let entries = []
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            await walk(full, depth + 1)
          } else if (SECRET_NAMES.test(entry.name)) {
            found.push(path.relative(root, full))
          }
        }
      }
      await walk(root, 0)
      return { success: true, data: { root, matches: found } }
    },
  })

  return {
    /**
     * Refuse a write to a path that names a credential.
     *
     * The point is not that the agent cannot write it — it can, with the right
     * instruction — but that it has to say so out loud first instead of
     * quietly committing an API key because a file happened to be on the way.
     */
    beforeToolCall({ tool, args }) {
      if (tool !== 'write' && tool !== 'edit') return
      const target = String(args?.filePath || args?.path || '')
      if (!target) return
      if (!SECRET_NAMES.test(target)) return
      return {
        block:
          `Refused by plugin guard-secrets: "${target}" looks like a credential file. ` +
          'Ask the user to confirm before writing secrets to disk, or store the value outside the repository.',
      }
    },
  }
}
