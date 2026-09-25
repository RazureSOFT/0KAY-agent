/**
 * Agent skill system — task procedures (separate from L.I.F.E skills).
 *
 * Skills are named prompt packages loaded from:
 *   - builtins (code / research / general)
 *   - AGENT_SKILLS_DIR/*.md
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface AgentSkill {
  name: string
  description: string
  content: string
  tags: string[]
  source: string
}

function parseMdSkill(stem: string, text: string): AgentSkill {
  let name = stem
  let description = ''
  let content = text.trim()
  const lines = text.split(/\r?\n/)
  const isMeta = (line: string) => /^tags:\s*/i.test(line.trim())
  if (lines[0]?.startsWith('# ')) {
    name = lines[0].slice(2).trim() || stem
    const para: string[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) {
        if (para.length) break
        continue
      }
      if (line.startsWith('#')) break
      if (isMeta(line)) continue
      para.push(line.trim())
    }
    description = para.join(' ').trim()
    if (description) {
      let bodyStart = lines.length
      let seenPara = false
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) {
          if (seenPara) {
            bodyStart = i
            break
          }
          continue
        }
        if (lines[i].startsWith('#')) {
          bodyStart = i
          break
        }
        if (isMeta(lines[i]) && !seenPara) continue
        seenPara = true
      }
      content = lines.slice(bodyStart).join('\n').trim() || text.trim()
    }
  }
  if (!description) description = `Agent skill: ${name}`
  const tagsMatch = text.match(/^tags:\s*(.+)$/mi)
  const tags = tagsMatch
    ? tagsMatch[1].split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
    : []
  return { name, description, content, tags, source: 'file' }
}

const BUILTIN: AgentSkill[] = [
  {
    name: 'code',
    description: 'Step-by-step software implementation procedure.',
    content: [
      '1. Restate acceptance criteria.',
      '2. Locate relevant files before editing.',
      '3. Make the smallest correct change.',
      '4. Verify with build/tests when available.',
      '5. Summarize the diff and residual risks.',
    ].join('\n'),
    tags: ['code', 'implementation'],
    source: 'builtin',
  },
  {
    name: 'research',
    description: 'Structured research: gather, rank, cite.',
    content: [
      '1. Break the question into sub-queries.',
      '2. Collect facts with sources when possible.',
      '3. Rank by confidence.',
      '4. Deliver a short briefing with open questions.',
    ].join('\n'),
    tags: ['research'],
    source: 'builtin',
  },
  {
    name: 'general',
    description: 'Default multi-step task procedure.',
    content: [
      '1. Clarify the goal and constraints.',
      '2. Plan 3–7 concrete steps.',
      '3. Execute with tools as needed.',
      '4. Finish with a concise result block.',
    ].join('\n'),
    tags: ['general'],
    source: 'builtin',
  },
]

export class SkillRegistry {
  private skills = new Map<string, AgentSkill>()
  private loadedDirs: string[] = []

  constructor() {
    for (const s of BUILTIN) this.skills.set(s.name, s)
    const envDir = process.env.AGENT_SKILLS_DIR || ''
    if (envDir) {
      this.loadDir(envDir)
    } else {
      // Package default: agent/skills/*.md (works from dist/skills → ../../skills)
      this.loadDir(path.resolve(__dirname, '../../skills'))
      this.loadDir(path.resolve(__dirname, '../../../skills'))
    }
  }

  loadDir(dir: string): number {
    if (!dir) return 0
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0
      if (!this.loadedDirs.includes(dir)) this.loadedDirs.push(dir)
      let n = 0
      for (const file of fs.readdirSync(dir).sort()) {
        if (!file.toLowerCase().endsWith('.md')) continue
        try {
          const text = fs.readFileSync(path.join(dir, file), 'utf-8')
          const skill = parseMdSkill(file.replace(/\.md$/i, ''), text)
          this.skills.set(skill.name, skill)
          n++
        } catch {
          /* skip unreadable */
        }
      }
      return n
    } catch {
      return 0
    }
  }

  register(skill: AgentSkill): void {
    this.skills.set(skill.name, skill)
  }

  /** Directory used for saving/deleting skill files (first loaded dir or env). */
  writableDir(): string {
    const envDir = process.env.AGENT_SKILLS_DIR || ''
    if (envDir) return envDir
    return path.resolve(__dirname, '../../skills')
  }

  /**
   * Save or overwrite a skill markdown file and reload it into the registry.
   * `name` becomes both the filename stem and the skill name (slash target).
   */
  save(name: string, content: string, dirOverride?: string): AgentSkill {
    const clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!clean || clean.length > 64) throw new Error('invalid skill name')
    const text = String(content || '').trim()
    if (!text) throw new Error('skill content is required')
    const dir = dirOverride || this.writableDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${clean}.md`), text, 'utf-8')
    const skill = parseMdSkill(clean, text)
    skill.name = clean
    this.skills.set(clean, skill)
    return skill
  }

  /** Delete a file-backed skill. Builtins cannot be removed. */
  remove(name: string, dirOverride?: string): boolean {
    const clean = String(name || '').trim().toLowerCase()
    const skill = this.skills.get(clean)
    if (!skill) return false
    if (skill.source === 'builtin') throw new Error('builtin skills cannot be deleted')
    this.skills.delete(clean)
    const dirs = [dirOverride || this.writableDir(), ...this.loadedDirs]
    for (const dir of dirs) {
      if (!dir) continue
      try { fs.unlinkSync(path.join(dir, `${clean}.md`)) } catch { /* ignore missing */ }
    }
    // Same name as a builtin → restore the builtin definition.
    const builtin = BUILTIN.find((b) => b.name === clean)
    if (builtin) this.skills.set(builtin.name, builtin)
    return true
  }

  get(name: string): AgentSkill | undefined {
    return this.skills.get(name)
  }

  list(): AgentSkill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  match(text: string): AgentSkill | undefined {
    const lowered = (text || '').toLowerCase()
    let best: AgentSkill | undefined
    let bestScore = 0
    for (const s of this.list()) {
      let score = 0
      if (s.name && lowered.includes(s.name)) score += 3
      for (const tag of s.tags) if (tag && lowered.includes(tag)) score += 2
      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }
    return bestScore >= 2 ? best : undefined
  }

  /** Skill guidance block for the system prompt / task kickoff. */
  contextBlock(text = '', forceName?: string): string {
    const all = this.list()
    if (!all.length) return 'No agent skills loaded.'
    const lines = ['Available agent skills (follow when relevant):']
    for (const s of all) lines.push(`- ${s.name}: ${s.description}`)
    const forced = forceName ? this.get(forceName) : undefined
    const match = forced || this.match(text)
    if (match) {
      lines.push('')
      lines.push(`### Skill: ${match.name}`)
      lines.push(match.content.trim())
      if (forced) lines.push(`Apply this skill to the user's request above.`)
    }
    return lines.join('\n')
  }

  getContent(name: string): string {
    const s = this.get(name)
    if (!s) return `Skill '${name}' not found.`
    return `### Skill: ${s.name}\n${s.description}\n\n${s.content.trim()}`
  }
}

let defaultRegistry: SkillRegistry | null = null

export function getSkillRegistry(): SkillRegistry {
  if (!defaultRegistry) defaultRegistry = new SkillRegistry()
  return defaultRegistry
}
