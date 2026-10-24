export type DeliveryStatus = 'GREEN' | 'YELLOW' | 'RED';

export interface ToolTraceEntry {
  name: string;
  fingerprint: string;
  success: boolean;
  evidence: string | null;
  at: number;
}

export interface DeliveryReport {
  status: DeliveryStatus;
  reasons: string[];
  warnings: string[];
  evidence: string[];
  mutations: number;
  repeats: number;
}

const MUTATING_TOOLS = new Set([
  'write', 'edit', 'apply_patch', 'patch', 'document', 'slides', 'office',
]);

const VERIFY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'test', re: /\b(pytest|vitest|jest|mocha|go\s+test|cargo\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|dotnet\s+test|gradle\s+test)\b/i },
  { label: 'build', re: /\b(go\s+build|cargo\s+build|npm\s+run\s+build|yarn\s+build|pnpm\s+build|make\b|tsup|vite\s+build|dotnet\s+build|gradle\s+build|mvn\s+package)\b/i },
  { label: 'lint', re: /\b(eslint|gofmt|golangci-lint|ruff|flake8|clippy|pylint|shellcheck|prettier\s+--check)\b/i },
  { label: 'typecheck', re: /\b(vue-tsc|tsc\s+--noemit|tsc\s+-p|mypy|pyright|go\s+vet)\b/i },
];

const DEFAULT_REPEAT_THRESHOLD = 3;
const MAX_TRACE = 400;

function normalizeArgs(raw: string | Record<string, any>): Record<string, any> {
  let obj: any = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw || '{}');
    } catch {
      obj = {};
    }
  }
  if (!obj || typeof obj !== 'object') return {};
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'content' || key === 'newString' || key === 'oldString') {
      clean[key] = typeof value === 'string' ? `<${value.length} chars>` : value;
    } else if (typeof value === 'string' && value.length > 300) {
      clean[key] = value.slice(0, 300);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function fingerprint(name: string, args: Record<string, any>): string {
  let serialized = '';
  try {
    serialized = JSON.stringify(args);
  } catch {
    serialized = String(args);
  }
  return `${name}:${serialized}`;
}

function evidenceLabel(name: string, args: Record<string, any>): string | null {
  const parts = [args.command, args.cmd, args.script, args.args, name]
    .filter((value) => typeof value === 'string');
  const hay = parts.join(' ').toLowerCase();
  for (const pattern of VERIFY_PATTERNS) {
    if (pattern.re.test(hay)) return pattern.label;
  }
  return null;
}

export class DeliverySupervisor {
  private trace: ToolTraceEntry[] = [];
  private readonly repeatThreshold: number;

  constructor(options: { repeatThreshold?: number } = {}) {
    this.repeatThreshold = Math.max(2, options.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD);
  }

  recordToolCall(name: string, rawArgs: string | Record<string, any>, success: boolean): void {
    const args = normalizeArgs(rawArgs);
    this.trace.push({
      name,
      fingerprint: fingerprint(name, args),
      success,
      evidence: evidenceLabel(name, args),
      at: Date.now(),
    });
    if (this.trace.length > MAX_TRACE) this.trace.splice(0, this.trace.length - MAX_TRACE);
  }

  get toolCallCount(): number {
    return this.trace.length;
  }

  private repeatCount(): { fingerprint: string; count: number } {
    const counts = new Map<string, number>();
    let top = { fingerprint: '', count: 0 };
    for (const entry of this.trace) {
      const next = (counts.get(entry.fingerprint) ?? 0) + 1;
      counts.set(entry.fingerprint, next);
      if (next > top.count) top = { fingerprint: entry.fingerprint, count: next };
    }
    return top;
  }

  private mutationCount(): number {
    return this.trace.filter((entry) => MUTATING_TOOLS.has(entry.name)).length;
  }

  private evidenceKinds(): string[] {
    const set = new Set<string>();
    for (const entry of this.trace) if (entry.evidence) set.add(entry.evidence);
    return [...set];
  }

  report(): DeliveryReport {
    const repeats = this.repeatCount();
    const mutations = this.mutationCount();
    const evidence = this.evidenceKinds();
    const reasons: string[] = [];
    const warnings: string[] = [];
    let status: DeliveryStatus = 'GREEN';

    if (repeats.count >= this.repeatThreshold) {
      status = 'RED';
      reasons.push(`Suspect loop: the same tool call repeated ${repeats.count} times (${repeats.fingerprint.slice(0, 60)})`);
    }
    if (mutations > 0 && evidence.length === 0) {
      if (status !== 'RED') status = 'YELLOW';
      reasons.push(`${mutations} file change(s) but no verification evidence (test / build / typecheck)`);
    }
    if (mutations === 0 && evidence.length === 0) {
      warnings.push('No file changes and no verification commands — this is an answer-only delivery');
    }
    if (status === 'GREEN') {
      reasons.push(evidence.length ? `Delivery has verification evidence: ${evidence.join(', ')}` : 'No mutation risk — delivery accepted');
    }

    return { status, reasons, warnings, evidence, mutations, repeats: repeats.count };
  }

  evaluateDelivery(_finalText: string): DeliveryReport {
    return this.report();
  }

  reset(): void {
    this.trace = [];
  }
}

export function supervisionDirective(): string {
  return [
    'Delivery rules (runtime gate):',
    '- A "done" claim must carry verifiable evidence: real test / build / typecheck / command output, or an explicit file diff.',
    '- Do not repeat the same failing action without new evidence; change strategy, or hand the blocker to the user with the question tool.',
    '- Judge by the final goal, not local signals (e.g. "the file already exists"); infer the user\'s real intent first, then act.',
  ].join('\n');
}
