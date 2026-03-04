type ExtensionMode = 'dev' | 'silent';

const baselineTag = 'baseline';

interface ApiMetric {
  requestId: string;
}

interface ResourceMetric {
  name: string;
}

interface MemoryMetrics {
  usedJSHeapSize: number;
}

interface LoadMetrics {
  domContentLoaded: number;
  totalLoadTime: number;
}

interface WebVitals {
  fcp: number;
  lcp: number;
  cls: number;
  tbt: number;
}

interface SessionMetrics {
  url: string;
  versionTag?: string;
  webVitals?: WebVitals;
  loadMetrics?: LoadMetrics;
  apiMetrics?: ApiMetric[];
  resourceMetrics?: ResourceMetric[];
  memoryMetrics?: MemoryMetrics | null;
}

interface StorageEstimate {
  usage: number;
  quota: number;
  percentUsed: number;
}

interface AllowedScope {
  origin: string;
  urlPatterns: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getExtensionMode(): ExtensionMode {
  try {
    return import.meta.env.DEV ? 'dev' : 'silent';
  } catch {
    return 'silent';
  }
}

const extensionMode = getExtensionMode();

let activeTag: string = baselineTag;
let availableTags: string[] = [baselineTag];
let selectedOrigin: string = '';

function logDev(message: string, data?: unknown): void {
  if (extensionMode !== 'dev') {
    return;
  }

  if (data !== undefined) {
    console.log(`[PerfMonitor][popup] ${message}`, data);
    return;
  }

  console.log(`[PerfMonitor][popup] ${message}`);
}

function formatDuration(value: number | undefined): string {
  if (!Number.isFinite(value)) {
    return '—';
  }

  const ms = value as number;
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  const seconds = ms / 1000;
  return `${seconds.toFixed(2)} s`;
}

function formatCls(value: number | undefined): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return (value as number).toFixed(3);
}

function bytesToMb(bytes: number | undefined): string {
  if (!Number.isFinite(bytes)) {
    return '—';
  }

  const mb = (bytes as number) / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeTag(tag: unknown): string {
  if (typeof tag !== 'string') {
    return baselineTag;
  }
  const trimmed = tag.trim();
  return trimmed.length > 0 ? trimmed : baselineTag;
}

interface ModalElements {
  root: HTMLElement;
  title: HTMLElement;
  message: HTMLElement;
  input: HTMLInputElement;
  cancel: HTMLButtonElement;
  confirm: HTMLButtonElement;
  backdrop: HTMLElement;
}

function getModalElements(): ModalElements | null {
  const root = document.getElementById('modal') as HTMLElement | null;
  const title = document.getElementById('modal-title') as HTMLElement | null;
  const message = document.getElementById('modal-message') as HTMLElement | null;
  const input = document.getElementById('modal-input') as HTMLInputElement | null;
  const cancel = document.getElementById('modal-cancel') as HTMLButtonElement | null;
  const confirm = document.getElementById('modal-confirm') as HTMLButtonElement | null;
  const backdrop = root?.querySelector('.modal-backdrop') as HTMLElement | null;

  if (!root || !title || !message || !input || !cancel || !confirm || !backdrop) {
    return null;
  }

  return { root, title, message, input, cancel, confirm, backdrop };
}

function closeModal(modal: ModalElements): void {
  modal.root.classList.remove('active');
  modal.root.setAttribute('aria-hidden', 'true');
}

async function showPrompt(params: { title: string; message: string; defaultValue?: string; confirmText?: string; cancelText?: string }): Promise<string | null> {
  const modal = getModalElements();
  if (!modal) {
    return null;
  }

  modal.title.textContent = params.title;
  modal.message.textContent = params.message;
  modal.confirm.textContent = params.confirmText ?? 'Confirm';
  modal.cancel.textContent = params.cancelText ?? 'Cancel';
  modal.input.value = params.defaultValue ?? '';

  modal.root.classList.add('active');
  modal.root.setAttribute('aria-hidden', 'false');

  setTimeout(() => {
    modal.input.focus();
    modal.input.select();
  }, 0);

  return new Promise<string | null>((resolve) => {
    let settled = false;

    const finish = (confirmed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      closeModal(modal);
      resolve(confirmed ? modal.input.value : null);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        finish(false);
      }
      if (event.key === 'Enter') {
        finish(true);
      }
    };

    const cleanup = (): void => {
      modal.cancel.removeEventListener('click', onCancel);
      modal.confirm.removeEventListener('click', onConfirm);
      modal.backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeyDown);
    };

    const onCancel = (): void => {
      finish(false);
    };

    const onConfirm = (): void => {
      finish(true);
    };

    modal.cancel.addEventListener('click', onCancel);
    modal.confirm.addEventListener('click', onConfirm);
    modal.backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeyDown);
  });
}

function setLatestSessionLoading(): void {
  const container = document.getElementById('latest-session');
  if (!container) {
    return;
  }
  container.className = 'empty';
  container.textContent = 'Loading...';
}

function setStorageUsageLoading(): void {
  const container = document.getElementById('storage-usage');
  if (!container) {
    return;
  }
  container.className = 'empty';
  container.textContent = 'Loading...';
}

function renderLatestSession(session: SessionMetrics | null): void {
  const container = document.getElementById('latest-session');
  if (!container) {
    return;
  }

  container.innerHTML = '';

  if (!session) {
    container.className = 'empty';
    container.textContent = 'No performance sessions recorded yet.';
    return;
  }

  container.className = '';

  const grid = document.createElement('div');
  grid.className = 'kv-grid';

  const url = typeof session.url === 'string' ? session.url : '';
  const webVitals = session.webVitals;
  const loadMetrics = session.loadMetrics;
  const apiCount = Array.isArray(session.apiMetrics) ? session.apiMetrics.length : 0;
  const resourceCount = Array.isArray(session.resourceMetrics) ? session.resourceMetrics.length : 0;
  const memoryUsedBytes = session.memoryMetrics?.usedJSHeapSize;

  const tagValue = normalizeTag(activeTag);

  const rows: Array<[string, string]> = [
    ['Tag', tagValue],
    ['URL', truncate(url, 64)],
    ['FCP', formatDuration(webVitals?.fcp)],
    ['LCP', formatDuration(webVitals?.lcp)],
    ['CLS', formatCls(webVitals?.cls)],
    ['TBT', formatDuration(webVitals?.tbt)],
    ['Total Load Time', formatDuration(loadMetrics?.totalLoadTime)],
    ['DOMContentLoaded', formatDuration(loadMetrics?.domContentLoaded)],
    ['API Count', String(apiCount)],
    ['Resource Count', String(resourceCount)],
    ['Memory Used', bytesToMb(memoryUsedBytes)]
  ];

  for (const [k, v] of rows) {
    const keyEl = document.createElement('div');
    keyEl.className = 'k';
    keyEl.textContent = k;

    const valueEl = document.createElement('div');
    valueEl.className = 'v';
    valueEl.textContent = v;

    grid.append(keyEl, valueEl);
  }

  container.append(grid);
}

function progressColor(percentUsed: number): string {
  if (percentUsed < 50) {
    return 'var(--green)';
  }
  if (percentUsed <= 80) {
    return 'var(--orange)';
  }
  return 'var(--red)';
}

function renderStorageUsage(estimate: StorageEstimate | null): void {
  const container = document.getElementById('storage-usage');
  if (!container) {
    return;
  }

  container.innerHTML = '';

  if (!estimate) {
    container.className = 'empty';
    container.textContent = 'Unable to load data.';
    return;
  }

  container.className = '';

  const grid = document.createElement('div');
  grid.className = 'kv-grid';

  const used = bytesToMb(estimate.usage);
  const quota = bytesToMb(estimate.quota);
  const percentUsed = Number.isFinite(estimate.percentUsed) ? estimate.percentUsed : 0;

  const rows: Array<[string, string]> = [
    ['Used', used],
    ['Quota', quota],
    ['Percent Used', `${percentUsed.toFixed(2)}%`]
  ];

  for (const [k, v] of rows) {
    const keyEl = document.createElement('div');
    keyEl.className = 'k';
    keyEl.textContent = k;

    const valueEl = document.createElement('div');
    valueEl.className = 'v';
    valueEl.textContent = v;

    grid.append(keyEl, valueEl);
  }

  const progress = document.createElement('div');
  progress.className = 'progress';

  const fill = document.createElement('div');
  fill.className = 'progress-fill';

  const clamped = Math.min(100, Math.max(0, percentUsed));
  fill.style.width = `${clamped}%`;
  fill.style.background = progressColor(clamped);

  progress.append(fill);

  container.append(grid, progress);
}

async function fetchLatestSessionByOrigin(origin: string, tag: string): Promise<SessionMetrics | null> {
  const normalizedTag = normalizeTag(tag);
  const response = await chrome.runtime.sendMessage({ action: 'GET_LATEST_SESSION_BY_ORIGIN', payload: { origin, tag: normalizedTag } });
  logDev('GET_LATEST_SESSION_BY_ORIGIN response', response);

  if (!isRecord(response) || response.ok !== true) {
    return null;
  }

  const session = response.session;
  if (session === null) {
    return null;
  }

  return (session as unknown as SessionMetrics) ?? null;
}


async function fetchStorageUsage(): Promise<StorageEstimate | null> {
  const response = await chrome.runtime.sendMessage({ action: 'GET_STORAGE_USAGE' });
  logDev('GET_STORAGE_USAGE response', response);

  if (!isRecord(response) || response.ok !== true) {
    return null;
  }

  const estimate = response.estimate;
  return (estimate as unknown as StorageEstimate) ?? null;
}

async function fetchAllTags(origin: string): Promise<string[]> {
  const response = await chrome.runtime.sendMessage({ action: 'GET_ALL_TAGS', payload: { origin } });
  logDev('GET_ALL_TAGS response', response);

  if (!isRecord(response) || response.ok !== true) {
    return [baselineTag];
  }

  const tags = response.tags;
  if (!Array.isArray(tags)) {
    return [baselineTag];
  }

  const normalized = tags.map((tag) => normalizeTag(tag)).filter((tag) => tag.length > 0);
  const unique = Array.from(new Set<string>(normalized));
  if (!unique.includes(baselineTag)) {
    unique.push(baselineTag);
  }
  return unique.sort();
}

async function fetchActiveTag(origin: string): Promise<string> {
  const response = await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_TAG', payload: { origin } });
  logDev('GET_ACTIVE_TAG response', response);

  if (!isRecord(response) || response.ok !== true) {
    return baselineTag;
  }

  return normalizeTag(response.tag);
}

async function updateActiveTag(tag: string, origin: string): Promise<boolean> {
  const normalized = normalizeTag(tag);
  const response = await chrome.runtime.sendMessage({ action: 'SET_ACTIVE_TAG', payload: { tag: normalized, origin } });
  logDev('SET_ACTIVE_TAG response', response);
  return isRecord(response) && response.ok === true;
}

function renderTagDropdown(): void {
  const select = document.getElementById('active-tag') as HTMLSelectElement | null;
  if (!select) {
    return;
  }

  select.innerHTML = '';

  for (const tag of availableTags) {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    select.append(option);
  }

  select.value = activeTag;
}


async function loadTagState(): Promise<void> {
  try {
    const [tags, current] = await Promise.all([fetchAllTags(selectedOrigin), fetchActiveTag(selectedOrigin)]);
    availableTags = tags;
    activeTag = current;
    if (!availableTags.includes(activeTag)) {
      availableTags = Array.from(new Set<string>([...availableTags, activeTag])).sort();
    }
    renderTagDropdown();
  } catch {
    availableTags = [baselineTag];
    activeTag = baselineTag;
    renderTagDropdown();
  }
}

async function refresh(): Promise<void> {
  setLatestSessionLoading();
  setStorageUsageLoading();

  const refreshButton = document.getElementById('refresh') as HTMLButtonElement | null;
  if (refreshButton) {
    refreshButton.disabled = true;
  }

  try {
    const [session, estimate] = await Promise.all([fetchLatestSessionByOrigin(selectedOrigin, activeTag), fetchStorageUsage()]);
    renderLatestSession(session);
    renderStorageUsage(estimate);
  } catch {
    renderLatestSession(null);
    renderStorageUsage(null);
  } finally {
    if (refreshButton) {
      refreshButton.disabled = false;
    }
  }
}

async function refreshAll(): Promise<void> {
  await loadTagState();
  await refresh();
}

function setupButtons(): void {
  const refreshButton = document.getElementById('refresh');
  refreshButton?.addEventListener('click', () => {
    void refreshAll();
  });

  const tagSelect = document.getElementById('active-tag') as HTMLSelectElement | null;
  tagSelect?.addEventListener('change', () => {
    const next = tagSelect.value;
    void (async (): Promise<void> => {
      if (!selectedOrigin) {
        return;
      }
      const updated = await updateActiveTag(next, selectedOrigin);
      if (!updated) {
        await loadTagState();
        await refresh();
        return;
      }

      activeTag = normalizeTag(next);
      await loadTagState();
      await refresh();
    })();
  });

  const newTagButton = document.getElementById('new-tag') as HTMLButtonElement | null;
  newTagButton?.addEventListener('click', () => {
    void (async (): Promise<void> => {
      if (!selectedOrigin) {
        return;
      }
      const entered = await showPrompt({
        title: 'Add Version',
        message: 'Enter a new tag name',
        confirmText: 'Add'
      });
      if (entered === null) {
        return;
      }
      const tag = normalizeTag(entered);
      if (!entered || tag.length === 0) {
        return;
      }

      const existing = availableTags.map((t) => t.toLowerCase());
      if (existing.includes(tag.toLowerCase())) {
        return;
      }

      const updated = await updateActiveTag(tag, selectedOrigin);
      if (!updated) {
        return;
      }

      await loadTagState();
      await refresh();
    })();
  });

  const analyticsButton = document.getElementById('open-analytics');
  analyticsButton?.addEventListener('click', () => {
    chrome.tabs
      .create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') })
      .catch(() => {
        // ignore
      });
  });
}

async function getActiveTabOrigin(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : undefined;
    const url = tab?.url;
    if (!url) return null;
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

async function fetchAllowedScopes(): Promise<AllowedScope[]> {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'GET_ALLOWED_SCOPES' });
    const scopes = isRecord(resp) && Array.isArray((resp as Record<string, unknown>).scopes)
      ? ((resp as Record<string, unknown>).scopes as unknown[])
      : ([] as unknown[]);

    const result: AllowedScope[] = [];
    for (const scope of scopes) {
      if (!isRecord(scope)) {
        continue;
      }
      const origin = typeof scope.origin === 'string' ? scope.origin : '';
      const urlPatterns = Array.isArray(scope.urlPatterns) ? scope.urlPatterns.filter((p) => typeof p === 'string') as string[] : ([] as string[]);
      if (!origin) {
        continue;
      }
      result.push({ origin, urlPatterns });
    }

    return result;
  } catch {
    return [];
  }
}

async function hasOriginPermission(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

function isInjectableUrl(urlValue: unknown): urlValue is string {
  if (typeof urlValue !== 'string') {
    return false;
  }
  if (urlValue.startsWith('chrome://')) {
    return false;
  }
  if (urlValue.startsWith('edge://')) {
    return false;
  }
  if (urlValue.startsWith('chrome-extension://')) {
    return false;
  }
  if (urlValue.startsWith('about:')) {
    return false;
  }
  return true;
}

async function injectIntoActiveTab(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : undefined;
    const tabId = tab?.id;
    const tabUrl = tab?.url;
    if (typeof tabId !== 'number' || !isInjectableUrl(tabUrl)) {
      return;
    }
    await chrome.runtime.sendMessage({ action: 'INJECT_CONTENT_SCRIPT', payload: { tabId, url: tabUrl } });
  } catch {
    // ignore
  }
}

function showMonitoringState(allowed: boolean): void {
  const notAllowed = document.getElementById('not-allowed');
  const summary = document.getElementById('summary');
  if (notAllowed && summary) {
    notAllowed.style.display = allowed ? 'none' : 'block';
    summary.style.display = allowed ? 'block' : 'none';
  }

  const tagSelect = document.getElementById('active-tag') as HTMLSelectElement | null;
  const newTagButton = document.getElementById('new-tag') as HTMLButtonElement | null;
  if (tagSelect) {
    tagSelect.disabled = !allowed;
  }
  if (newTagButton) {
    newTagButton.disabled = !allowed;
  }
}

async function initPopup(): Promise<void> {
  setupButtons();

  const origin = await getActiveTabOrigin();
  const scopes = await fetchAllowedScopes();
  const allowedByScope = origin !== null && scopes.some((s) => s.origin === origin);
  const allowed = origin !== null && allowedByScope && (await hasOriginPermission(origin));

  if (!origin || !allowed) {
    selectedOrigin = origin ?? '';
    showMonitoringState(false);
    const btn = document.getElementById('enable-monitoring') as HTMLButtonElement | null;
    btn?.addEventListener('click', () => {
      if (!selectedOrigin) return;
      void (async (): Promise<void> => {
        const granted = await chrome.permissions.request({ origins: [`${selectedOrigin}/*`] });
        if (!granted) {
          return;
        }
        const resp = await chrome.runtime.sendMessage({ action: 'ADD_ALLOWED_ORIGIN', payload: { origin: selectedOrigin } });
        if (isRecord(resp) && resp.ok === true) {
          await injectIntoActiveTab();
          showMonitoringState(true);
          await refreshAll();
        }
      })();
    });
    return;
  }

  selectedOrigin = origin;
  showMonitoringState(true);
  await refreshAll();
}

document.addEventListener('DOMContentLoaded', () => {
  void initPopup();
});

export {};
