// Tool output is the other half of the token bill.
//
// A build log, a test run, a grep across a repository: all of it comes back
// verbatim, and a 30,000-character command result is ~9,000 tokens for one call.
// Most of that is colour codes, progress-bar carriage returns, blank lines, and
// the middle of a list nobody reads.
//
// So: strip what is decoration, keep the head and the tail (failures and summaries
// live at the end), and say exactly what was dropped so the model can ask for
// more instead of guessing.

export interface CompactOptions {
  /** Characters kept before the middle is dropped. */
  maxChars?: number
  /** A single line longer than this is cut, with the length noted. */
  maxLineLength?: number
  /** Hard line cap, applied before the character cap. */
  maxLines?: number
  /** Share of maxChars given to the tail. Build errors and test summaries live there. */
  tailShare?: number
}

export interface CompactResult {
  text: string
  /** Lines removed by the line/char cap. */
  droppedLines: number
  /** Characters removed overall, including ANSI and CR handling. */
  savedChars: number
  /** True when anything was cut, so callers can say so. */
  changed: boolean
}

const DEFAULTS = {
  maxChars: 24_000,
  maxLineLength: 2_000,
  maxLines: 400,
  tailShare: 0.4,
}

// CSI (colours, cursor), OSC (window title, hyperlinks), and the two-character
// escapes that only move the cursor.
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-_])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/**
 * A progress bar writes `\r` hundreds of times on one line. Only the last frame
 * is the output; the rest is noise that costs tokens.
 *
 * CRLF is not that: it is a line ending, and treating it as a progress return
 * empties every line Windows produces. Normalise first, then collapse.
 */
function collapseCarriageReturns(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.includes('\r')) return normalized
  return normalized
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n')
}

function collapseBlankRuns(text: string): string {
  // Two blank lines separate blocks; a third and beyond is padding.
  return text.replace(/\n{3,}/g, '\n\n')
}

function truncateLines(lines: string[], maxLineLength: number): { lines: string[]; changed: boolean } {
  let changed = false
  const out = lines.map((line) => {
    if (line.length <= maxLineLength) return line
    changed = true
    const kept = line.slice(0, maxLineLength)
    return `${kept}… (+${line.length - maxLineLength} chars)`
  })
  return { lines: out, changed }
}

/** Keep the head and the tail, drop the middle, and say how much went. */
export function compactOutput(value: string, options: CompactOptions = {}): CompactResult {
  const settings = { ...DEFAULTS, ...options }
  const original = value || ''
  let text = stripAnsi(original)
  text = collapseCarriageReturns(text)
  text = collapseBlankRuns(text)
  if (!text.trim()) return { text: '', droppedLines: 0, savedChars: original.length, changed: original.length > 0 }

  let lines = text.split('\n')
  const lineTruncation = truncateLines(lines, settings.maxLineLength)
  lines = lineTruncation.lines

  let droppedLines = 0
  if (lines.length > settings.maxLines) {
    const tail = Math.floor(settings.maxLines * settings.tailShare)
    const head = settings.maxLines - tail
    droppedLines = lines.length - settings.maxLines
    lines = [
      ...lines.slice(0, head),
      `[… ${droppedLines} lines omitted …]`,
      ...lines.slice(lines.length - tail),
    ]
  }

  text = lines.join('\n')

  if (text.length > settings.maxChars) {
    const tailChars = Math.floor(settings.maxChars * settings.tailShare)
    const headChars = settings.maxChars - tailChars
    const droppedChars = text.length - settings.maxChars
    text = `${text.slice(0, headChars)}\n[… ${droppedChars} chars omitted …]\n${text.slice(text.length - tailChars)}`
    droppedLines = Math.max(droppedLines, 1)
  }

  return {
    text,
    droppedLines,
    savedChars: original.length - text.length,
    changed: text !== original,
  }
}

/**
 * The one-line summary that goes next to a compacted result, so the model knows
 * whether it is looking at everything.
 */
export function compactionNote(result: CompactResult): string | null {
  if (!result.changed) return null
  const parts: string[] = []
  if (result.droppedLines > 0) parts.push(`${result.droppedLines} lines`)
  parts.push(`${result.savedChars} chars`)
  return `output compacted: dropped ${parts.join(', ')} (ansi/blank lines/middle). Re-run with a narrower command if you need the full text.`
}
