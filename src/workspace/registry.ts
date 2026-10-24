import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export type WorkspaceId = string;

export interface WorkspaceRecord {
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionHeader {
  id: string;
  cwd?: string;
  createdAt?: string;
}

export interface SessionSource {
  list(): Promise<SessionHeader[]>;
  get(id: string): Promise<SessionHeader | undefined>;
}

interface PendingMutation {
  operation: 'create' | 'delete';
  workspaceId: WorkspaceId;
}

interface RegistryState {
  initialized: boolean;
  workspaceIds: WorkspaceId[];
  archivedSessionIds: string[];
  pendingMutation?: PendingMutation;
}

interface RegistryFile {
  version: 2;
  state: RegistryState;
  workspaces: Record<WorkspaceId, WorkspaceRecord>;
}

export class WorkspaceOrderInvalidError extends Error {
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`);
    this.name = 'WorkspaceOrderInvalidError';
  }
}

export class WorkspaceMoveInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMoveInvalidError';
  }
}

export class WorkspaceUnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`cannot archive session '${sessionId}': no such session`);
    this.name = 'WorkspaceUnknownSessionError';
  }
}

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export async function realpathNormalize(rawPath: string): Promise<string> {
  return fs.realpath(path.resolve(String(rawPath)));
}

export class Workspace {
  private record: WorkspaceRecord;

  constructor(
    private readonly registry: WorkspaceRegistry,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record;
  }

  get path(): string { return this.record.path; }
  get title(): string { return this.record.title; }
  get createdAt(): string { return this.record.createdAt; }
  get updatedAt(): string { return this.record.updatedAt; }

  get sessionIds(): readonly string[] {
    return this.record.sessionIds.filter((id) => this.registry.sessionPath(id) === this.record.path);
  }

  async setTitle(title: string): Promise<void> {
    this.record = await this.registry.updateRecord(this.id, (record) => ({ ...record, title: String(title).trim() || record.title }));
  }

  async attachSession(sessionId: string, cwd?: string): Promise<void> {
    const resolved = cwd ?? (await this.registry.readSessionCwd(sessionId));
    if (resolved == null) {
      throw new Error(`cannot attach session '${sessionId}' to workspace '${this.path}': no cwd to validate against`);
    }
    let canonical: string;
    try {
      canonical = await realpathNormalize(resolved);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new Error(`cannot attach session '${sessionId}' to workspace '${this.path}': its cwd '${resolved}' does not resolve to a directory`, { cause: error });
    }
    if (canonical !== this.path) {
      throw new Error(`cannot attach session '${sessionId}' to workspace '${this.path}': its cwd resolves to '${canonical}'`);
    }
    this.registry.rememberSessionPath(sessionId, canonical);
    this.record = await this.registry.updateRecord(this.id, (record) =>
      record.sessionIds.includes(sessionId) ? record : { ...record, sessionIds: [sessionId, ...record.sessionIds] });
  }

  async detachSession(sessionId: string): Promise<void> {
    this.record = await this.registry.updateRecord(this.id, (record) =>
      record.sessionIds.includes(sessionId) ? { ...record, sessionIds: record.sessionIds.filter((id) => id !== sessionId) } : record);
  }

  async insertSessionBefore(sessionId: string, beforeSessionId?: string): Promise<void> {
    this.record = await this.registry.updateRecord(this.id, (record) => {
      if (!record.sessionIds.includes(sessionId)) throw new WorkspaceMoveInvalidError(`cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`);
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) throw new WorkspaceMoveInvalidError(`cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': the anchor is not accounted`);
      if (beforeSessionId === sessionId) return record;
      const without = record.sessionIds.filter((id) => id !== sessionId);
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId);
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)];
      return sameIds(sessionIds, record.sessionIds) ? record : { ...record, sessionIds };
    });
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await fs.stat(this.path)).isDirectory() ? 'ok' : 'missing-dir';
    } catch {
      return 'missing-dir';
    }
  }
}

export class WorkspaceRegistry {
  private file: string;
  private sessions: SessionSource | null;
  private state: RegistryState = { initialized: false, workspaceIds: [], archivedSessionIds: [] };
  private workspaces = new Map<WorkspaceId, WorkspaceRecord>();
  private entities = new Map<WorkspaceId, Workspace>();
  private readonly sessionPaths = new Map<string, string>();
  private operationTail: Promise<unknown> = Promise.resolve();
  private started = false;

  constructor(options: { file?: string; sessions?: SessionSource } = {}) {
    this.file = options.file || path.join(process.env.AGENT_DATA_DIR || './data/agent', 'workspaces.json');
    this.sessions = options.sessions || null;
  }

  async init(): Promise<void> {
    if (this.started) return;
    const raw = await fs.readFile(this.file, 'utf8').catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed && parsed.state && parsed.workspaces) {
        this.state = { ...parsed.state, archivedSessionIds: parsed.state.archivedSessionIds || [] };
        this.workspaces = new Map(Object.entries(parsed.workspaces));
      }
    }
    await this.recoverPendingMutation();
    this.validate();
    await this.rebuildSessionIndex();
    if (!this.state.initialized) await this.bootstrap();
    this.rebuildEntities();
    this.started = true;
  }

  async create(rawPath: string, title?: string): Promise<Workspace> {
    await this.init();
    const canonical = await realpathNormalize(rawPath);
    if (!(await fs.stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`);
    }
    return this.enqueue(async () => {
      for (const entity of this.entities.values()) if (entity.path === canonical) return entity;
      const id = randomUUID();
      const now = new Date().toISOString();
      const record: WorkspaceRecord = {
        path: canonical,
        title: String(title ?? '').trim() || path.basename(canonical),
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      };
      const previous = this.state;
      this.workspaces.set(id, record);
      this.state = { ...previous, pendingMutation: { operation: 'create', workspaceId: id } };
      await this.persist();
      this.state = { initialized: true, workspaceIds: [id, ...previous.workspaceIds], archivedSessionIds: previous.archivedSessionIds };
      await this.persist();
      const entity = new Workspace(this, id, record);
      this.entities.set(id, entity);
      return entity;
    });
  }

  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id);
  }

  list(): Workspace[] {
    return this.state.workspaceIds.map((id) => {
      const entity = this.entities.get(id);
      if (entity === undefined) throw new Error(`workspace registry order references missing workspace '${id}'`);
      return entity;
    });
  }

  async resolveByPath(rawPath: string): Promise<Workspace | undefined> {
    await this.init();
    const canonical = await realpathNormalize(rawPath);
    for (const entity of this.entities.values()) if (entity.path === canonical) return entity;
    return undefined;
  }

  async resolve(selector: string): Promise<Workspace | undefined> {
    await this.init();
    const value = String(selector ?? '').trim();
    if (!value) return undefined;
    const byId = this.entities.get(value);
    if (byId) return byId;
    const wanted = value.toLowerCase();
    for (const entity of this.list()) if (entity.title.toLowerCase() === wanted) return entity;
    return undefined;
  }

  async delete(id: WorkspaceId): Promise<boolean> {
    await this.init();
    return this.enqueue(async () => {
      if (!this.entities.has(id)) return false;
      const previous = this.state;
      const next: RegistryState = {
        initialized: true,
        workspaceIds: previous.workspaceIds.filter((candidate) => candidate !== id),
        archivedSessionIds: previous.archivedSessionIds,
      };
      this.state = { ...next, pendingMutation: { operation: 'delete', workspaceId: id } };
      await this.persist();
      this.workspaces.delete(id);
      this.entities.delete(id);
      this.state = next;
      await this.persist();
      return true;
    });
  }

  async insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<WorkspaceId[]> {
    await this.init();
    return this.enqueue(async () => {
      const { workspaceIds } = this.state;
      if (!workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id);
      if (beforeId !== undefined && !workspaceIds.includes(beforeId)) throw new WorkspaceOrderInvalidError(beforeId);
      if (beforeId === id) return workspaceIds;
      const without = workspaceIds.filter((candidate) => candidate !== id);
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId);
      const next = [...without.slice(0, at), id, ...without.slice(at)];
      if (sameIds(next, workspaceIds)) return workspaceIds;
      this.state = { ...this.state, workspaceIds: next };
      await this.persist();
      return next;
    });
  }

  get archivedSessionIds(): readonly string[] {
    return this.state.archivedSessionIds;
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.init();
    return this.enqueue(async () => {
      if (this.state.archivedSessionIds.includes(sessionId)) return;
      if (!(await this.sessionKnown(sessionId))) throw new WorkspaceUnknownSessionError(sessionId);
      this.state = { ...this.state, archivedSessionIds: [...this.state.archivedSessionIds, sessionId] };
      await this.persist();
    });
  }

  async moveSession(sessionId: string, toId: WorkspaceId): Promise<void> {
    await this.init();
    return this.enqueue(async () => {
      if (!this.workspaces.has(toId)) throw new Error(`unknown workspace '${toId}'`);
      let changed = false;
      for (const [id, record] of this.workspaces) {
        if (id !== toId && record.sessionIds.includes(sessionId)) {
          this.workspaces.set(id, { ...record, sessionIds: record.sessionIds.filter((candidate) => candidate !== sessionId), updatedAt: new Date().toISOString() });
          changed = true;
        }
      }
      const target = this.workspaces.get(toId)!;
      if (!target.sessionIds.includes(sessionId)) {
        this.workspaces.set(toId, { ...target, sessionIds: [sessionId, ...target.sessionIds], updatedAt: new Date().toISOString() });
        changed = true;
      }
      if (!changed) return;
      this.rememberSessionPath(sessionId, target.path);
      await this.persist();
      this.rebuildEntities();
    });
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    await this.init();
    return this.enqueue(async () => {
      if (!this.state.archivedSessionIds.includes(sessionId)) return;
      this.state = { ...this.state, archivedSessionIds: this.state.archivedSessionIds.filter((id) => id !== sessionId) };
      await this.persist();
    });
  }

  sessionPath(id: string): string | undefined {
    return this.sessionPaths.get(id);
  }

  rememberSessionPath(id: string, canonical: string): void {
    this.sessionPaths.set(id, canonical);
  }

  async readSessionCwd(id: string): Promise<string | undefined> {
    if (!this.sessions) return undefined;
    const header = await this.sessions.get(id);
    return header?.cwd;
  }

  async updateRecord(id: WorkspaceId, fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<WorkspaceRecord> {
    return this.enqueue(async () => {
      const current = this.workspaces.get(id);
      if (!current) throw new Error(`unknown workspace '${id}'`);
      const proposed = fn({ ...current, sessionIds: [...current.sessionIds] });
      if (proposed === current) return current;
      const sessionIds = proposed.sessionIds.filter((sessionId) => this.sessionPaths.get(sessionId) === proposed.path);
      const unchanged = proposed.title === current.title && proposed.path === current.path && sameIds(sessionIds, current.sessionIds);
      if (unchanged) return current;
      const record: WorkspaceRecord = { ...proposed, sessionIds, updatedAt: new Date().toISOString() };
      this.workspaces.set(id, record);
      const entity = this.entities.get(id);
      if (entity) this.entities.set(id, new Workspace(this, id, record));
      await this.persist();
      return record;
    });
  }

  private async sessionKnown(id: string): Promise<boolean> {
    if (this.sessionPaths.has(id)) return true;
    if (!this.sessions) return false;
    if (await this.sessions.get(id)) return true;
    await this.rebuildSessionIndex();
    return this.sessionPaths.has(id);
  }

  private async rebuildSessionIndex(): Promise<void> {
    if (!this.sessions) return;
    this.sessionPaths.clear();
    for (const header of await this.sessions.list()) {
      if (header.cwd === undefined) continue;
      try {
        const canonical = await realpathNormalize(header.cwd);
        if ((await fs.stat(canonical)).isDirectory()) this.sessionPaths.set(header.id, canonical);
      } catch { }
    }
  }

  private async bootstrap(): Promise<void> {
    const headers = this.sessions ? await this.sessions.list() : [];
    const groups = new Map<string, SessionHeader[]>();
    for (const header of headers) {
      const canonical = this.sessionPaths.get(header.id);
      if (canonical === undefined) continue;
      const group = groups.get(canonical);
      if (group) group.push(header); else groups.set(canonical, [header]);
    }
    for (const [canonical, group] of groups) {
      if ([...this.entities.values()].some((entity) => entity.path === canonical)) continue;
      const id = randomUUID();
      const newest = group.map((header) => header.createdAt || '').sort().reverse()[0] || new Date().toISOString();
      this.workspaces.set(id, {
        path: canonical,
        title: path.basename(canonical),
        sessionIds: group.map((header) => header.id),
        createdAt: newest,
        updatedAt: newest,
      });
      this.state = { ...this.state, workspaceIds: [id, ...this.state.workspaceIds] };
    }
    this.state = { ...this.state, initialized: true };
    await this.persist();
  }

  private async recoverPendingMutation(): Promise<void> {
    const pending = this.state.pendingMutation;
    if (!pending) return;
    this.workspaces.delete(pending.workspaceId);
    this.state = {
      initialized: this.state.initialized,
      workspaceIds: this.state.workspaceIds.filter((id) => id !== pending.workspaceId),
      archivedSessionIds: this.state.archivedSessionIds,
    };
    await this.persist();
  }

  private validate(): void {
    const order = new Set<WorkspaceId>();
    for (const id of this.state.workspaceIds) {
      if (order.has(id)) throw new Error(`workspace registry is inconsistent: order repeats workspace '${id}'`);
      if (!this.workspaces.has(id)) throw new Error(`workspace registry is inconsistent: order references missing workspace '${id}'`);
      order.add(id);
    }
    if (this.state.initialized && order.size !== this.workspaces.size) {
      const orphan = [...this.workspaces.keys()].find((id) => !order.has(id));
      throw new Error(`workspace registry is inconsistent: workspace '${orphan}' is absent from order`);
    }
    const paths = new Map<string, WorkspaceId>();
    const accounted = new Map<string, WorkspaceId>();
    for (const [id, record] of this.workspaces) {
      if (paths.has(record.path)) throw new Error(`workspace registry is inconsistent: path '${record.path}' is claimed by both '${paths.get(record.path)}' and '${id}'`);
      paths.set(record.path, id);
      for (const sessionId of record.sessionIds) {
        if (accounted.has(sessionId)) throw new Error(`workspace registry is inconsistent: session '${sessionId}' is accounted by both '${accounted.get(sessionId)}' and '${id}'`);
        accounted.set(sessionId, id);
      }
    }
  }

  private rebuildEntities(): void {
    this.entities.clear();
    for (const id of this.state.workspaceIds) {
      const record = this.workspaces.get(id);
      if (record) this.entities.set(id, new Workspace(this, id, record));
    }
  }

  private async persist(): Promise<void> {
    const payload: RegistryFile = {
      version: 2,
      state: this.state,
      workspaces: Object.fromEntries(this.workspaces),
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
