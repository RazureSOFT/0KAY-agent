/**
 * Asset enrichment and report assembly.
 *
 * The rule that matters: a finding without evidence is an observation, not a
 * conclusion. The report keeps those in separate sections instead of letting
 * an unverified line read like a confirmed result.
 */
import type { EvidenceRecord, TrafficExchange } from './records.js';

export interface Observation {
  kind: 'dns' | 'http' | 'tls' | 'port' | 'header' | 'text';
  value: string;
  name?: string;
}

export interface EnrichedAsset {
  key: string;
  host: string;
  port: number | null;
  scheme: string | null;
  ip: string | null;
  server: string | null;
  poweredBy: string | null;
  title: string | null;
  technologies: string[];
  openPorts: number[];
  /** Fields we could not establish. Reported rather than guessed. */
  unknown: string[];
}

/** Only what an observation actually establishes is filled in. */
export function enrichAsset(key: string, observations: Observation[] = []): EnrichedAsset {
  let host = '';
  let port: number | null = null;
  let scheme: string | null = null;
  try {
    const url = new URL(key.includes('://') ? key : `http://${key}`);
    host = url.hostname.toLowerCase();
    port = url.port ? Number(url.port) : null;
    scheme = url.protocol.replace(':', '');
  } catch {
    host = key.toLowerCase().split(':')[0];
    const raw = key.split(':')[1];
    if (raw && /^\d+$/.test(raw)) port = Number(raw);
  }

  const result: EnrichedAsset = {
    key,
    host,
    port,
    scheme,
    ip: null,
    server: null,
    poweredBy: null,
    title: null,
    technologies: [],
    openPorts: [],
    unknown: [],
  };

  for (const obs of observations) {
    const name = (obs.name || '').toLowerCase();
    const value = String(obs.value || '');
    switch (obs.kind) {
      case 'dns':
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':')) result.ip = value;
        break;
      case 'port':
        if (/^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535) {
          if (!result.openPorts.includes(Number(value))) result.openPorts.push(Number(value));
        }
        break;
      case 'header':
        if (name === 'server') result.server = value;
        else if (name === 'x-powered-by') result.poweredBy = value;
        break;
      case 'http':
        if (name === 'title') result.title = value;
        break;
      case 'tls':
        if (value && !result.technologies.includes(`tls:${value}`)) result.technologies.push(`tls:${value}`);
        break;
      case 'text':
        if (value && !result.technologies.includes(value)) result.technologies.push(value);
        break;
    }
  }
  for (const field of ['ip', 'server', 'poweredBy', 'title'] as const) {
    if (result[field] === null) result.unknown.push(field);
  }
  return result;
}

export interface ReportFinding {
  id: string;
  title: string;
  severity?: string;
  asset?: string;
  detail?: string;
}

export interface ReportInput {
  title: string;
  scope?: string[];
  findings?: ReportFinding[];
  evidence?: EvidenceRecord[];
  exchanges?: TrafficExchange[];
  verified?: (finding: ReportFinding, evidence: EvidenceRecord[]) => boolean;
}

export interface Report {
  title: string;
  generatedAt: string;
  scope: string[];
  summary: {
    findings: number;
    confirmed: number;
    unverified: number;
    evidenceRecords: number;
    exchanges: number;
  };
  confirmed: Array<{ finding: ReportFinding; evidenceIds: string[] }>;
  unverified: Array<{ finding: ReportFinding; reason: string }>;
  markdown: string;
}

/**
 * By default a finding is confirmed only when at least one evidence record
 * names it. Callers may supply a stricter predicate (for example, requiring a
 * reproducible exchange), but cannot supply "always true" through the data.
 */
export function buildReport(input: ReportInput, now: () => number = Date.now): Report {
  const findings = input.findings || [];
  const evidence = input.evidence || [];
  const exchanges = input.exchanges || [];
  const isVerified = input.verified || ((finding, rows) => rows.some((row) => row.findingId === finding.id));

  const confirmed: Report['confirmed'] = [];
  const unverified: Report['unverified'] = [];
  for (const finding of findings) {
    const rows = evidence.filter((row) => row.findingId === finding.id);
    if (isVerified(finding, rows) && rows.length) {
      confirmed.push({ finding, evidenceIds: rows.map((row) => row.id) });
    } else {
      unverified.push({
        finding,
        reason: rows.length ? 'evidence exists but the verification rule did not accept it' : 'no evidence snapshot is attached',
      });
    }
  }

  const lines: string[] = [
    `# ${input.title}`,
    '',
    `Generated: ${new Date(now()).toISOString()}`,
    '',
    '## Scope',
    '',
    ...(input.scope?.length ? input.scope.map((item) => `- ${item}`) : ['- not declared (coverage has no denominator)']),
    '',
    '## Summary',
    '',
    `- Findings: ${findings.length} (${confirmed.length} confirmed, ${unverified.length} unverified)`,
    `- Evidence records: ${evidence.length}`,
    `- Recorded exchanges: ${exchanges.length}`,
    '',
    '## Confirmed findings',
    '',
  ];
  if (!confirmed.length) lines.push('None. A finding needs an attached evidence snapshot to appear here.', '');
  for (const { finding, evidenceIds } of confirmed) {
    lines.push(`### ${finding.title}`, '', `- id: ${finding.id}`);
    if (finding.severity) lines.push(`- severity: ${finding.severity}`);
    if (finding.asset) lines.push(`- asset: ${finding.asset}`);
    if (finding.detail) lines.push('', finding.detail);
    lines.push(`- evidence: ${evidenceIds.join(', ')}`, '');
  }
  lines.push('## Unverified observations', '');
  if (!unverified.length) lines.push('None.', '');
  for (const { finding, reason } of unverified) {
    lines.push(`- ${finding.title} (${finding.id}): ${reason}`);
  }
  lines.push('', '## Traffic', '');
  if (!exchanges.length) lines.push('No exchanges were recorded.', '');
  for (const row of exchanges.slice(-20)) {
    lines.push(`- ${row.method} ${row.url} → ${row.status} (${row.id})`);
  }

  return {
    title: input.title,
    generatedAt: new Date(now()).toISOString(),
    scope: input.scope || [],
    summary: {
      findings: findings.length,
      confirmed: confirmed.length,
      unverified: unverified.length,
      evidenceRecords: evidence.length,
      exchanges: exchanges.length,
    },
    confirmed,
    unverified,
    markdown: lines.join('\n'),
  };
}
