import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import { DB_NAME, DB_VERSION, SETTINGS_STORE, SESSIONS_STORE } from '../shared/constants';

const baselineTag = 'baseline';
const activeVersionTagKey = 'activeVersionTag';
const activeVersionTagsKey = 'activeVersionTags';
const versionTagsKey = 'versionTags';
const allowedOriginsKey = 'allowedOrigins';
const allowedScopesKey = 'allowedScopes';

export interface AllowedScope {
  origin: string;
  urlPatterns: string[];
}

interface LoadMetrics {
  domContentLoaded: number;
  loadEventEnd: number;
  totalLoadTime: number;
}

interface WebVitals {
  fcp: number;
  lcp: number;
  cls: number;
  tbt: number;
}

interface MemoryMetrics {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface ResourceMetric {
  name: string;
  initiatorType: string;
  transferSize: number;
  duration: number;
  decodedBodySize: number;
}

export interface ApiMetric {
  requestId: string;
  url: string;
  method: string;
  status: number;
  duration: number;
  payloadSize: number;
  startTime: number;
  failed: boolean;
  cached: boolean;
}

export interface SessionMetrics {
  id: string;
  timestamp: number;
  versionTag: string;
  url: string;
  origin?: string;
  route: string;
  navigationType: 'hard' | 'spa';
  loadMetrics: LoadMetrics;
  webVitals: WebVitals;
  memoryMetrics: MemoryMetrics | null;
  resourceMetrics: ResourceMetric[];
  apiMetrics: ApiMetric[];
}

export interface StorageEstimate {
  usage: number;
  quota: number;
  percentUsed: number;
}

interface SettingsRecord {
  key: string;
  value: unknown;
}

interface PerfMonitorDbSchema extends DBSchema {
  sessions: {
    key: string;
    value: SessionMetrics;
    indexes: {
      timestamp: number;
      versionTag: string;
      url: string;
      route: string;
      versionTag_timestamp: [string, number];
      origin: string;
      origin_timestamp: [string, number];
    };
  };
  settings: {
    key: string;
    value: SettingsRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<PerfMonitorDbSchema>> | null = null;

function isDevLoggingEnabled(): boolean {
  try {
    return import.meta.env.DEV;
  } catch {
    return false;
  }
}

function logDev(message: string, error?: unknown): void {
  if (!isDevLoggingEnabled()) {
    return;
  }

  if (error) {
    console.log(`[PerfMonitor][background][storage] ${message}`, error);
    return;
  }

  console.log(`[PerfMonitor][background][storage] ${message}`);
}

function getOriginFromUrl(urlValue: unknown): string {
  if (typeof urlValue !== 'string') {
    return '';
  }
  try {
    const u = new URL(urlValue);
    return u.origin;
  } catch {
    return '';
  }
}

function getDb(): Promise<IDBPDatabase<PerfMonitorDbSchema>> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = openDB<PerfMonitorDbSchema>(DB_NAME, DB_VERSION, {
    upgrade(db: IDBPDatabase<PerfMonitorDbSchema>, _oldVersion: number, _newVersion: number | null, transaction) {
      const sessions = db.objectStoreNames.contains(SESSIONS_STORE)
        ? transaction.objectStore(SESSIONS_STORE)
        : db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });

      if (!sessions.indexNames.contains('timestamp')) {
        sessions.createIndex('timestamp', 'timestamp');
      }
      if (!sessions.indexNames.contains('versionTag')) {
        sessions.createIndex('versionTag', 'versionTag');
      }
      if (!sessions.indexNames.contains('url')) {
        sessions.createIndex('url', 'url');
      }
      if (!sessions.indexNames.contains('route')) {
        sessions.createIndex('route', 'route');
      }
      if (!sessions.indexNames.contains('versionTag_timestamp')) {
        sessions.createIndex('versionTag_timestamp', ['versionTag', 'timestamp']);
      }
      if (!sessions.indexNames.contains('origin')) {
        sessions.createIndex('origin', 'origin');
      }
      if (!sessions.indexNames.contains('origin_timestamp')) {
        sessions.createIndex('origin_timestamp', ['origin', 'timestamp']);
      }

      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
    }
  });

  return dbPromise;
}

export async function initDB(): Promise<void> {
  try {
    await getDb();
    logDev('DB opened');
  } catch (error: unknown) {
    logDev('DB open failed', error);
    throw error;
  }
}

function normalizeTag(tag: unknown): string {
  if (typeof tag !== 'string') {
    return baselineTag;
  }
  const trimmed = tag.trim();
  return trimmed.length > 0 ? trimmed : baselineTag;
}

function normalizeUrlPattern(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function getPathnameFromUrl(urlValue: unknown): string {
  if (typeof urlValue !== 'string') {
    return '';
  }
  try {
    return new URL(urlValue).pathname;
  } catch {
    return '';
  }
}

function matchesUrlPatterns(urlValue: unknown, urlPatterns: string[]): boolean {
  if (!Array.isArray(urlPatterns) || urlPatterns.length === 0) {
    return true;
  }
  const pathname = getPathnameFromUrl(urlValue);
  if (!pathname) {
    return false;
  }
  const set = new Set<string>(urlPatterns.map((p) => normalizeUrlPattern(p)).filter((p) => p.length > 0));
  return set.has(pathname);
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return '';
  }
}

function readActiveVersionTags(recordValue: unknown): Record<string, string> {
  if (!recordValue || typeof recordValue !== 'object') {
    return {};
  }
  const obj = recordValue as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const origin = normalizeOrigin(key);
    if (!origin) {
      continue;
    }
    const tag = normalizeTag(value);
    result[origin] = tag;
  }
  return result;
}

function readVersionTags(recordValue: unknown): Record<string, string[]> {
  if (!recordValue || typeof recordValue !== 'object') {
    return {};
  }
  const obj = recordValue as Record<string, unknown>;
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(obj)) {
    const origin = normalizeOrigin(key);
    if (!origin) {
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    const tags = (value as unknown[])
      .map((v) => normalizeTag(v))
      .filter((v) => v.length > 0);
    result[origin] = Array.from(new Set<string>(tags));
  }
  return result;
}

async function addVersionTagForOrigin(db: IDBPDatabase<PerfMonitorDbSchema>, origin: string, tag: string): Promise<void> {
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedTag = normalizeTag(tag);
  if (!normalizedOrigin || !normalizedTag) {
    return;
  }

  const existing = await db.get(SETTINGS_STORE, versionTagsKey);
  const map = readVersionTags(existing?.value);
  const current = Array.isArray(map[normalizedOrigin]) ? map[normalizedOrigin] : ([] as string[]);
  const next = Array.from(new Set<string>([...current, normalizedTag, baselineTag])).sort();
  map[normalizedOrigin] = next;
  await db.put(SETTINGS_STORE, { key: versionTagsKey, value: map } as SettingsRecord);
}

function readAllowedScopes(recordValue: unknown): AllowedScope[] {
  if (!Array.isArray(recordValue)) {
    return [];
  }
  const scopes: AllowedScope[] = [];
  for (const item of recordValue) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const origin = normalizeOrigin(obj.origin);
    if (!origin) {
      continue;
    }
    const patternsRaw = Array.isArray(obj.urlPatterns) ? obj.urlPatterns : [];
    const urlPatterns = patternsRaw.map((p) => normalizeUrlPattern(p)).filter((p) => p.length > 0);
    scopes.push({ origin, urlPatterns });
  }
  const byOrigin = new Map<string, AllowedScope>();
  for (const scope of scopes) {
    byOrigin.set(scope.origin, scope);
  }
  return Array.from(byOrigin.values()).sort((a, b) => a.origin.localeCompare(b.origin));
}

export async function getAllowedScopes(): Promise<AllowedScope[]> {
  try {
    const db = await getDb();
    const record = await db.get(SETTINGS_STORE, allowedScopesKey);
    const scopes = readAllowedScopes(record?.value);
    if (scopes.length > 0) {
      return scopes;
    }

    const legacy = await getAllowedOrigins();
    if (legacy.length === 0) {
      return [];
    }
    const migrated = legacy.map((origin) => ({ origin, urlPatterns: [] as string[] }));
    await db.put(SETTINGS_STORE, { key: allowedScopesKey, value: migrated } as SettingsRecord);
    return migrated;
  } catch {
    return [];
  }
}

export async function setAllowedScopes(scopes: AllowedScope[]): Promise<void> {
  try {
    const db = await getDb();
    const record: SettingsRecord = { key: allowedScopesKey, value: scopes };
    await db.put(SETTINGS_STORE, record);
  } catch {
    // ignore
  }
}

export async function getScopeForOrigin(origin: string): Promise<AllowedScope | null> {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return null;
  }
  const scopes = await getAllowedScopes();
  return scopes.find((s) => s.origin === normalizedOrigin) ?? null;
}

export async function setActiveTag(tag: string, origin?: string): Promise<void> {
  try {
    const db = await getDb();
    const normalizedTag = normalizeTag(tag);
    if (typeof origin === 'string' && origin.length > 0) {
      const normalizedOrigin = normalizeOrigin(origin);
      const existing = await db.get(SETTINGS_STORE, activeVersionTagsKey);
      const map = readActiveVersionTags(existing?.value);
      if (normalizedOrigin) {
        map[normalizedOrigin] = normalizedTag;
        await addVersionTagForOrigin(db, normalizedOrigin, normalizedTag);
      }
      await db.put(SETTINGS_STORE, { key: activeVersionTagsKey, value: map } as SettingsRecord);
      return;
    }
    const record: SettingsRecord = { key: activeVersionTagKey, value: normalizedTag };
    await db.put(SETTINGS_STORE, record);
  } catch {
    logDev('setActiveTag failed');
  }
}

export async function getActiveTag(origin?: string): Promise<string> {
  try {
    const db = await getDb();
    if (typeof origin === 'string' && origin.length > 0) {
      const normalizedOrigin = normalizeOrigin(origin);
      if (normalizedOrigin) {
        const mapRecord = await db.get(SETTINGS_STORE, activeVersionTagsKey);
        const map = readActiveVersionTags(mapRecord?.value);
        const existing = map[normalizedOrigin];
        if (existing) {
          return normalizeTag(existing);
        }
      }

      return baselineTag;
    }

    const record = await db.get(SETTINGS_STORE, activeVersionTagKey);
    return normalizeTag(record?.value);
  } catch {
    return baselineTag;
  }
}

export async function saveSession(session: SessionMetrics): Promise<void> {
  try {
    const db = await getDb();
    const origin = getOriginFromUrl(session.url);
    const activeTag = await getActiveTag(origin);
    const apiMetrics = Array.isArray(session.apiMetrics) ? session.apiMetrics : ([] as ApiMetric[]);
    await db.put(SESSIONS_STORE, { ...session, origin, versionTag: activeTag, apiMetrics });
  } catch {
    logDev('saveSession failed');
  }
}

function dedupeApiMetrics(metrics: ApiMetric[]): ApiMetric[] {
  const byId = new Map<string, ApiMetric>();
  for (const metric of metrics) {
    if (!metric || typeof metric.requestId !== 'string') {
      continue;
    }
    if (!byId.has(metric.requestId)) {
      byId.set(metric.requestId, metric);
    }
  }
  return Array.from(byId.values());
}

export async function appendApiBatch(sessionId: string, apiMetrics: ApiMetric[]): Promise<void> {
  try {
    const db = await getDb();
    const existing = await db.get(SESSIONS_STORE, sessionId);
    if (!existing) {
      return;
    }

    const merged = dedupeApiMetrics([...(existing.apiMetrics ?? []), ...apiMetrics]);
    const updated: SessionMetrics = { ...existing, apiMetrics: merged };
    await db.put(SESSIONS_STORE, updated);
  } catch {
    logDev('appendApiBatch failed');
  }
}

export async function getLatestSession(): Promise<SessionMetrics | null> {
  try {
    const db = await getDb();
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const index = tx.store.index('timestamp');
    const cursor = await index.openCursor(null, 'prev');
    await tx.done;
    return cursor?.value ?? null;
  } catch {
    return null;
  }
}

export async function getLatestSessionByOriginAndTag(origin: string, tag: string, urlPatterns?: string[]): Promise<SessionMetrics | null> {
  const normalizedTag = normalizeTag(tag);
  try {
    const db = await getDb();
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const index = tx.store.index('origin_timestamp');
    const lower: [string, number] = [origin, 0];
    const upper: [string, number] = [origin, Number.MAX_SAFE_INTEGER];
    let cursor = await index.openCursor(IDBKeyRange.bound(lower, upper), 'prev');
    while (cursor) {
      const record = cursor.value as SessionMetrics;
      const recordTag = normalizeTag(record.versionTag);
      if (recordTag === normalizedTag && matchesUrlPatterns(record.url, Array.isArray(urlPatterns) ? urlPatterns : [])) {
        await tx.done;
        return record;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch {
    // continue to fallback
  }

  try {
    const db = await getDb();
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const index = tx.store.index('timestamp');
    let cur = await index.openCursor(null, 'prev');
    while (cur) {
      const value = cur.value as SessionMetrics;
      const valueOrigin = getOriginFromUrl(value.url);
      const valueTag = normalizeTag(value.versionTag);
      if (valueOrigin === origin && valueTag === normalizedTag && matchesUrlPatterns(value.url, Array.isArray(urlPatterns) ? urlPatterns : [])) {
        await tx.done;
        return value;
      }
      cur = await cur.continue();
    }
    await tx.done;
    return null;
  } catch {
    return null;
  }
}

export async function getLatestSessionByOrigin(origin: string, urlPatterns?: string[]): Promise<SessionMetrics | null> {
  try {
    const db = await getDb();
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const index = tx.store.index('origin_timestamp');
    const lower: [string, number] = [origin, 0];
    const upper: [string, number] = [origin, Number.MAX_SAFE_INTEGER];
    let cursor = await index.openCursor(IDBKeyRange.bound(lower, upper), 'prev');
    while (cursor) {
      if (matchesUrlPatterns(cursor.value.url, Array.isArray(urlPatterns) ? urlPatterns : [])) {
        await tx.done;
        return cursor.value;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch {
    // continue to fallback
  }
  // Fallback for older records without 'origin' index: scan by timestamp and filter by URL origin
  try {
    const db = await getDb();
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const index = tx.store.index('timestamp');
    let cur = await index.openCursor(null, 'prev');
    while (cur) {
      const value = cur.value as SessionMetrics;
      if (getOriginFromUrl(value.url) === origin && matchesUrlPatterns(value.url, Array.isArray(urlPatterns) ? urlPatterns : [])) {
        await tx.done;
        return value;
      }
      cur = await cur.continue();
    }
    await tx.done;
    return null;
  } catch {
    return null;
  }
}

export async function getSessionsByTag(tag: string, origin?: string, urlPatterns?: string[]): Promise<SessionMetrics[]> {
  try {
    const db = await getDb();
    const normalizedTag = normalizeTag(tag);
    const sessions = await db.getAllFromIndex(SESSIONS_STORE, 'versionTag', normalizedTag);

    const filtered = typeof origin === 'string' && origin.length > 0
      ? sessions.filter((s) => getOriginFromUrl(s.url) === origin && matchesUrlPatterns(s.url, Array.isArray(urlPatterns) ? urlPatterns : []))
      : sessions;

    return filtered
      .map((session) => ({ ...session, versionTag: normalizeTag(session.versionTag) }))
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export async function getAllTags(origin?: string): Promise<string[]> {
  try {
    const db = await getDb();
    const tags = new Set<string>();

    const normalizedOrigin = typeof origin === 'string' && origin.length > 0 ? normalizeOrigin(origin) : '';
    if (normalizedOrigin) {
      const stored = await db.get(SETTINGS_STORE, versionTagsKey);
      const map = readVersionTags(stored?.value);
      const fromSettings = map[normalizedOrigin] ?? ([] as string[]);
      for (const tag of fromSettings) {
        tags.add(normalizeTag(tag));
      }

      const activeMapRecord = await db.get(SETTINGS_STORE, activeVersionTagsKey);
      const activeMap = readActiveVersionTags(activeMapRecord?.value);
      const active = activeMap[normalizedOrigin];
      if (active) {
        tags.add(normalizeTag(active));
      }
    }

    const scope = typeof origin === 'string' && origin.length > 0 ? await getScopeForOrigin(origin) : null;
    const patterns = scope?.urlPatterns ?? ([] as string[]);

    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      if (typeof origin === 'string' && origin.length > 0) {
        if (getOriginFromUrl(cursor.value.url) === origin && matchesUrlPatterns(cursor.value.url, patterns)) {
          tags.add(normalizeTag(cursor.value.versionTag));
        }
      } else {
        tags.add(normalizeTag(cursor.value.versionTag));
      }
      cursor = await cursor.continue();
    }

    await tx.done;

    tags.add(baselineTag);
    return Array.from(tags.values()).sort();
  } catch {
    return [baselineTag];
  }
}

export async function getAllowedOrigins(): Promise<string[]> {
  try {
    const db = await getDb();
    const record = await db.get(SETTINGS_STORE, allowedOriginsKey);
    const raw = (record?.value as unknown) as unknown[] | undefined;
    const fromSettings = Array.isArray(raw) ? raw.map((v) => (typeof v === 'string' ? v : '')) : [];
    const cleaned = fromSettings.filter((v) => v.length > 0);
    if (cleaned.length > 0) {
      return Array.from(new Set<string>(cleaned)).sort();
    }

    const origins = new Set<string>();
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const origin = getOriginFromUrl(cursor.value.url);
      if (origin.length > 0) {
        origins.add(origin);
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return Array.from(origins.values()).sort();
  } catch {
    return [];
  }
}

export async function addAllowedOrigin(origin: string): Promise<void> {
  try {
    const db = await getDb();
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) {
      return;
    }

    const scopes = await getAllowedScopes();
    if (!scopes.some((s) => s.origin === normalizedOrigin)) {
      const nextScopes: AllowedScope[] = [...scopes, { origin: normalizedOrigin, urlPatterns: [] as string[] }].sort((a, b) => a.origin.localeCompare(b.origin));
      await setAllowedScopes(nextScopes);
    }

    const existing = await db.get(SETTINGS_STORE, allowedOriginsKey);
    const list = Array.isArray(existing?.value) ? (existing?.value as unknown[]).filter((v) => typeof v === 'string') : [];
    const set = new Set<string>(list as string[]);
    if (origin) {
      set.add(normalizedOrigin);
    }
    const record: SettingsRecord = { key: allowedOriginsKey, value: Array.from(set.values()).sort() };
    await db.put(SETTINGS_STORE, record);
  } catch {
    // ignore
  }
}

export async function deleteSessionsByOrigin(origin: string): Promise<void> {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return;
  }
  try {
    const db = await getDb();
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const index = tx.store.index('origin');
    const keys = await index.getAllKeys(normalizedOrigin);
    for (const key of keys) {
      await tx.store.delete(key);
    }
    await tx.done;
  } catch {
    // ignore
  }
}

export async function deleteDomain(origin: string): Promise<void> {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return;
  }

  await deleteSessionsByOrigin(normalizedOrigin);

  try {
    const db = await getDb();
    const scopes = await getAllowedScopes();
    const nextScopes = scopes.filter((s) => s.origin !== normalizedOrigin);
    await setAllowedScopes(nextScopes);

    const legacy = await db.get(SETTINGS_STORE, allowedOriginsKey);
    const list = Array.isArray(legacy?.value) ? (legacy?.value as unknown[]).filter((v) => typeof v === 'string') : [];
    const nextLegacy = (list as string[]).filter((v) => normalizeOrigin(v) !== normalizedOrigin);
    await db.put(SETTINGS_STORE, { key: allowedOriginsKey, value: nextLegacy } as SettingsRecord);

    const mapRecord = await db.get(SETTINGS_STORE, activeVersionTagsKey);
    const map = readActiveVersionTags(mapRecord?.value);
    if (map[normalizedOrigin]) {
      delete map[normalizedOrigin];
      await db.put(SETTINGS_STORE, { key: activeVersionTagsKey, value: map } as SettingsRecord);
    }
  } catch {
    // ignore
  }
}

export async function deleteVersion(origin: string, tag: string, deleteSessions: boolean): Promise<void> {
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedTag = normalizeTag(tag);
  if (!normalizedOrigin || normalizedTag === baselineTag) {
    return;
  }
  try {
    const db = await getDb();
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const index = tx.store.index('versionTag');
    const byTag = await index.getAll(normalizedTag);
    for (const session of byTag) {
      if (getOriginFromUrl(session.url) !== normalizedOrigin) {
        continue;
      }
      if (deleteSessions) {
        await tx.store.delete(session.id);
      } else {
        const updated: SessionMetrics = { ...session, versionTag: baselineTag };
        await tx.store.put(updated);
      }
    }
    await tx.done;

    const existing = await db.get(SETTINGS_STORE, versionTagsKey);
    const map = readVersionTags(existing?.value);
    const current = Array.isArray(map[normalizedOrigin]) ? map[normalizedOrigin] : ([] as string[]);
    const next = current
      .map((t) => normalizeTag(t))
      .filter((t) => t.length > 0 && t !== normalizedTag);
    map[normalizedOrigin] = Array.from(new Set<string>([...next, baselineTag])).sort();
    await db.put(SETTINGS_STORE, { key: versionTagsKey, value: map } as SettingsRecord);

    const activeMapRecord = await db.get(SETTINGS_STORE, activeVersionTagsKey);
    const activeMap = readActiveVersionTags(activeMapRecord?.value);
    if (activeMap[normalizedOrigin] === normalizedTag) {
      activeMap[normalizedOrigin] = baselineTag;
      await db.put(SETTINGS_STORE, { key: activeVersionTagsKey, value: activeMap } as SettingsRecord);
    }
  } catch {
    // ignore
  }
}

export async function deleteOldSessions(retentionDays: number): Promise<void> {
  try {
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionDays * dayMs;

    const db = await getDb();
    const tx = db.transaction(SESSIONS_STORE, 'readwrite');
    const index = tx.store.index('timestamp');

    let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff, true));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }

    await tx.done;
  } catch {
    // ignore
  }
}

export async function getStorageEstimate(): Promise<StorageEstimate> {
  try {
    const estimate = await navigator.storage.estimate();
    const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
    const quota = typeof estimate.quota === 'number' ? estimate.quota : 0;
    const percentUsed = quota > 0 ? (usage / quota) * 100 : 0;
    return { usage, quota, percentUsed };
  } catch {
    return { usage: 0, quota: 0, percentUsed: 0 };
  }
}
