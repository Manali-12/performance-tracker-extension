import Chart from 'chart.js/auto';

type ExtensionMode = 'dev' | 'silent';

type ChartInstance = Chart;

const baselineTag = 'baseline';
const maxTrendPoints = 25;

const overviewChartYMin = 0;
const overviewChartYMax = 30000;

const regressionMinSessions = 5;
const regressionPercentileP95 = 0.95;
const regressionPercentileP75 = 0.75;

const regressionThresholdRegress = 10;
const regressionThresholdImprove = -5;
const regressionClsAbsoluteRegress = 0.02;

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
  timestamp?: number;
  url: string;
  versionTag?: string;
  webVitals?: WebVitals;
  loadMetrics?: LoadMetrics;
}

interface MetricAverages {
  loadTimeAvg: number;
  fcpAvg: number;
  lcpAvg: number;
  clsAvg: number;
  tbtAvg: number;
}

interface RegressionMetric {
  baseline: number;
  current: number;
  changePercent: number;
  status: 'improved' | 'neutral' | 'regressed';
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

async function fetchAllowedScopes(): Promise<AllowedScope[]> {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'GET_ALLOWED_SCOPES' });
    if (!isRecord(resp) || resp.ok !== true) {
      return [];
    }
    const scopesValue = (resp as Record<string, unknown>).scopes;
    if (!Array.isArray(scopesValue)) {
      return [];
    }
    return (scopesValue as unknown as AllowedScope[]).filter((s) => typeof s?.origin === 'string' && Array.isArray(s?.urlPatterns));
  } catch {
    return [];
  }
}

const extensionMode = getExtensionMode();

function logDev(message: string, data?: unknown): void {
  if (extensionMode !== 'dev') {
    return;
  }

  if (data !== undefined) {
    console.log(`[PerfMonitor][dashboard] ${message}`, data);
    return;
  }

  console.log(`[PerfMonitor][dashboard] ${message}`);
}

function getOriginFromUrl(urlValue: unknown): string | null {
  if (typeof urlValue !== 'string') {
    return null;
  }
  try {
    const u = new URL(urlValue);
    return u.origin;
  } catch {
    return null;
  }
}

function normalizeTag(tag: unknown): string {
  if (typeof tag !== 'string') {
    return baselineTag;
  }
  const trimmed = tag.trim();
  return trimmed.length > 0 ? trimmed : baselineTag;
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

async function saveAllowedScopes(scopes: AllowedScope[]): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'SET_ALLOWED_SCOPES', payload: { scopes } });
    return isRecord(res) && res.ok === true;
  } catch {
    return false;
  }
}

async function requestOriginPermission(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

async function removeOriginPermission(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number') {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  const clampedIndex = Math.min(sorted.length - 1, Math.max(0, index));
  return sorted[clampedIndex] ?? 0;
}

function percentChange(oldVal: number, newVal: number): number {
  if (oldVal === 0) {
    return 0;
  }
  return ((newVal - oldVal) / oldVal) * 100;
}

function classifyChange(change: number): 'improved' | 'neutral' | 'regressed' {
  if (change > regressionThresholdRegress) {
    return 'regressed';
  }
  if (change < regressionThresholdImprove) {
    return 'improved';
  }
  return 'neutral';
}

function classifyCls(change: number, baseline: number, current: number): 'improved' | 'neutral' | 'regressed' {
  const absoluteDelta = current - baseline;
  if (change > regressionThresholdRegress || absoluteDelta > regressionClsAbsoluteRegress) {
    return 'regressed';
  }
  if (change < regressionThresholdImprove) {
    return 'improved';
  }
  return 'neutral';
}

function formatSeconds(valueMs: number): string {
  const seconds = valueMs / 1000;
  return `${seconds.toFixed(2)} s`;
}

function formatCls(value: number): string {
  return value.toFixed(3);
}

function formatChange(change: number): string {
  return `${change.toFixed(1)}%`;
}

function statusEmoji(status: RegressionMetric['status']): string {
  if (status === 'improved') {
    return '🟢';
  }
  if (status === 'regressed') {
    return '🔴';
  }
  return '🟡';
}

function setRegressionBanner(state: 'good' | 'neutral' | 'bad'): void {
  const banner = document.getElementById('regression-banner');
  if (!banner) {
    return;
  }

  banner.className = 'banner';
  if (state === 'bad') {
    banner.classList.add('bad');
    banner.textContent = '⚠ Performance Regression Detected';
    return;
  }
  if (state === 'good') {
    banner.classList.add('good');
    banner.textContent = '✅ Performance Improved';
    return;
  }

  banner.classList.add('neutral');
  banner.textContent = 'No Significant Performance Change';
}

function renderRegressionTable(metrics: Record<string, RegressionMetric>): void {
  const table = document.getElementById('regression-table') as HTMLTableElement | null;
  if (!table) {
    return;
  }

  table.innerHTML = '';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const headers = ['Metric', 'Baseline', 'Current', 'Change', 'Status'];
  for (const header of headers) {
    const th = document.createElement('th');
    th.textContent = header;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');

  const metricOrder: Array<{ key: keyof typeof metrics; label: string; type: 'time' | 'cls' }> = [
    { key: 'load', label: 'Load Time (P95)', type: 'time' },
    { key: 'lcp', label: 'LCP (P95)', type: 'time' },
    { key: 'tbt', label: 'TBT (P95)', type: 'time' },
    { key: 'cls', label: 'CLS (P75)', type: 'cls' }
  ];

  for (const entry of metricOrder) {
    const metric = metrics[entry.key];
    if (!metric) {
      continue;
    }

    const row = document.createElement('tr');

    const metricCell = document.createElement('td');
    metricCell.textContent = entry.label;

    const baselineCell = document.createElement('td');
    baselineCell.className = 'num';
    baselineCell.textContent = entry.type === 'cls' ? formatCls(metric.baseline) : formatSeconds(metric.baseline);

    const currentCell = document.createElement('td');
    currentCell.className = 'num';
    currentCell.textContent = entry.type === 'cls' ? formatCls(metric.current) : formatSeconds(metric.current);

    const changeCell = document.createElement('td');
    changeCell.className = 'num';
    changeCell.textContent = formatChange(metric.changePercent);

    const statusCell = document.createElement('td');
    statusCell.textContent = `${statusEmoji(metric.status)} ${metric.status}`;

    row.append(metricCell, baselineCell, currentCell, changeCell, statusCell);
    tbody.append(row);
  }

  table.append(thead, tbody);
}

function formatTime(value: number | null): string {
  if (value === null) {
    return '-';
  }
  return formatSeconds(value);
}

function formatClsValue(value: number | null): string {
  if (value === null) {
    return '-';
  }
  return formatCls(value);
}

function getDisplayUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    const path = url.pathname + url.search;
    return path.length > 0 ? path : urlValue;
  } catch {
    return urlValue;
  }
}

function renderSessionsTable(sessions: SessionMetrics[]): void {
  const table = document.getElementById('sessions-table') as HTMLTableElement | null;
  if (!table) {
    return;
  }

  if (sessions.length === 0) {
    setSessionsEmpty('No sessions available for this tag.');
    return;
  }

  clearSessionsEmpty();
  table.innerHTML = '';

  const colgroup = document.createElement('colgroup');
  const colSpecs: Array<{ className: string; width: string }> = [
    { className: 'col-time', width: '10%' },
    { className: 'col-url', width: '35%' },
    { className: 'col-load', width: '11%' },
    { className: 'col-fcp', width: '11%' },
    { className: 'col-lcp', width: '11%' },
    { className: 'col-cls', width: '11%' },
    { className: 'col-tbt', width: '11%' }
  ];
  for (const spec of colSpecs) {
    const col = document.createElement('col');
    col.className = spec.className;
    col.style.width = spec.width;
    colgroup.append(col);
  }

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  const headers: Array<{ title: string; subtext?: string; className?: string }> = [
    { title: 'Time', className: 'col-time' },
    { title: 'URL', className: 'col-url' },
    { title: 'Load', subtext: 'Total Load Time', className: 'col-load th-num' },
    { title: 'FCP', subtext: 'First Contentful Paint', className: 'col-fcp th-num' },
    { title: 'LCP', subtext: 'Largest Contentful Paint', className: 'col-lcp th-num' },
    { title: 'CLS', subtext: 'Cumulative Layout Shift', className: 'col-cls th-num' },
    { title: 'TBT', subtext: 'Total Blocking Time', className: 'col-tbt th-num' }
  ];

  for (const header of headers) {
    const th = document.createElement('th');
    if (typeof header.className === 'string') {
      th.className = header.className;
    }

    const title = document.createElement('div');
    title.className = 'th-title';
    title.textContent = header.title;
    th.append(title);

    if (typeof header.subtext === 'string') {
      const sub = document.createElement('div');
      sub.className = 'th-subtext';
      sub.textContent = header.subtext;
      th.append(sub);
    }

    headRow.append(th);
  }

  thead.append(headRow);

  const tbody = document.createElement('tbody');

  const ordered = [...sessions]
    .filter((s) => typeof s.url === 'string' && s.url.length > 0)
    .sort((a, b) => (toFiniteNumber(b.timestamp) ?? 0) - (toFiniteNumber(a.timestamp) ?? 0));

  for (const session of ordered) {
    const row = document.createElement('tr');

    const timestamp = toFiniteNumber(session.timestamp);
    const timeCell = document.createElement('td');
    timeCell.textContent = timestamp === null ? '-' : formatTimeLabel(timestamp);

    const urlCell = document.createElement('td');
    urlCell.textContent = getDisplayUrl(session.url);

    const loadCell = document.createElement('td');
    loadCell.className = 'num';
    loadCell.textContent = formatTime(toFiniteNumber(session.loadMetrics?.totalLoadTime));

    const fcpCell = document.createElement('td');
    fcpCell.className = 'num';
    fcpCell.textContent = formatTime(toFiniteNumber(session.webVitals?.fcp));

    const lcpCell = document.createElement('td');
    lcpCell.className = 'num';
    lcpCell.textContent = formatTime(toFiniteNumber(session.webVitals?.lcp));

    const clsCell = document.createElement('td');
    clsCell.className = 'num';
    clsCell.textContent = formatClsValue(toFiniteNumber(session.webVitals?.cls));

    const tbtCell = document.createElement('td');
    tbtCell.className = 'num';
    tbtCell.textContent = formatTime(toFiniteNumber(session.webVitals?.tbt));

    row.append(timeCell, urlCell, loadCell, fcpCell, lcpCell, clsCell, tbtCell);
    tbody.append(row);
  }

  table.append(colgroup, thead, tbody);
}

async function sendBadgeStatus(status: 'good' | 'neutral' | 'bad'): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ action: 'UPDATE_BADGE_STATUS', payload: { status } });
  } catch {
    // ignore
  }
}

function computeAverages(sessions: SessionMetrics[]): MetricAverages {
  const loadTimes: number[] = [];
  const fcpValues: number[] = [];
  const lcpValues: number[] = [];
  const clsValues: number[] = [];
  const tbtValues: number[] = [];

  for (const session of sessions) {
    const loadTime = toFiniteNumber(session.loadMetrics?.totalLoadTime);
    if (loadTime !== null) {
      loadTimes.push(loadTime);
    }

    const fcp = toFiniteNumber(session.webVitals?.fcp);
    if (fcp !== null) {
      fcpValues.push(fcp);
    }

    const lcp = toFiniteNumber(session.webVitals?.lcp);
    if (lcp !== null) {
      lcpValues.push(lcp);
    }

    const cls = toFiniteNumber(session.webVitals?.cls);
    if (cls !== null) {
      clsValues.push(cls);
    }

    const tbt = toFiniteNumber(session.webVitals?.tbt);
    if (tbt !== null) {
      tbtValues.push(tbt);
    }
  }

  return {
    loadTimeAvg: average(loadTimes),
    fcpAvg: average(fcpValues),
    lcpAvg: average(lcpValues),
    clsAvg: average(clsValues),
    tbtAvg: average(tbtValues)
  };
}

async function fetchAllTags(): Promise<string[]> {
  const response = await chrome.runtime.sendMessage({ action: 'GET_ALL_TAGS', payload: { origin: selectedDomain, urlPatterns: selectedUrlPatterns } });
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

async function fetchActiveTag(): Promise<string> {
  const response = await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_TAG', payload: { origin: selectedDomain, urlPatterns: selectedUrlPatterns } });
  logDev('GET_ACTIVE_TAG response', response);

  if (!isRecord(response) || response.ok !== true) {
    return baselineTag;
  }

  return normalizeTag(response.tag);
}

async function updateActiveTag(tag: string): Promise<boolean> {
  const normalized = normalizeTag(tag);
  const response = await chrome.runtime.sendMessage({ action: 'SET_ACTIVE_TAG', payload: { tag: normalized, origin: selectedDomain, urlPatterns: selectedUrlPatterns } });
  logDev('SET_ACTIVE_TAG response', response);
  return isRecord(response) && response.ok === true;
}

async function fetchSessionsByTag(tag: string): Promise<SessionMetrics[]> {
  const normalizedTag = normalizeTag(tag);
  const response = await chrome.runtime.sendMessage({ action: 'GET_SESSIONS_BY_TAG', payload: { tag: normalizedTag, origin: selectedDomain, urlPatterns: selectedUrlPatterns } });
  logDev('GET_SESSIONS_BY_TAG response', response);

  if (!isRecord(response) || response.ok !== true) {
    return [];
  }

  const sessions = response.sessions;
  if (!Array.isArray(sessions)) {
    return [];
  }

  return sessions as unknown as SessionMetrics[];
}

let availableTags: string[] = [baselineTag];
let activeTag: string = baselineTag;
let compareTagA: string = baselineTag;
let compareTagB: string = baselineTag;
let selectedDomain: string = '';
let selectedUrlPatterns: string[] = [];

let allowedScopes: AllowedScope[] = [];

let overviewChart: ChartInstance | null = null;
let compareChart: ChartInstance | null = null;
let lcpTrendChart: ChartInstance | null = null;
let fcpTrendChart: ChartInstance | null = null;
let clsTrendChart: ChartInstance | null = null;

type DashboardTab = 'data' | 'graphs' | 'settings';

function destroyCharts(): void {
  overviewChart?.destroy();
  overviewChart = null;

  compareChart?.destroy();
  compareChart = null;

  lcpTrendChart?.destroy();
  lcpTrendChart = null;
  fcpTrendChart?.destroy();
  fcpTrendChart = null;
  clsTrendChart?.destroy();
  clsTrendChart = null;
}

function setActiveTab(tab: DashboardTab): void {
  const dataButton = document.getElementById('tab-btn-data') as HTMLButtonElement | null;
  const graphsButton = document.getElementById('tab-btn-graphs') as HTMLButtonElement | null;
  const settingsButton = document.getElementById('tab-btn-settings') as HTMLButtonElement | null;
  const dataPanel = document.getElementById('tab-panel-data');
  const graphsPanel = document.getElementById('tab-panel-graphs');
  const settingsPanel = document.getElementById('tab-panel-settings');

  const dataActive = tab === 'data';
  const graphsActive = tab === 'graphs';
  const settingsActive = tab === 'settings';

  dataButton?.classList.toggle('active', dataActive);
  graphsButton?.classList.toggle('active', graphsActive);
  settingsButton?.classList.toggle('active', settingsActive);
  dataButton?.setAttribute('aria-selected', dataActive ? 'true' : 'false');
  graphsButton?.setAttribute('aria-selected', graphsActive ? 'true' : 'false');
  settingsButton?.setAttribute('aria-selected', settingsActive ? 'true' : 'false');

  dataPanel?.classList.toggle('active', dataActive);
  graphsPanel?.classList.toggle('active', graphsActive);
  settingsPanel?.classList.toggle('active', settingsActive);
}

function renderDomainSettings(root: HTMLElement, scopes: AllowedScope[], onRefresh: () => void): void {
  root.innerHTML = '';

  if (scopes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No domains configured. Use Add Domain to start.';
    root.append(empty);
    return;
  }

  const list = document.createElement('div');
  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  list.style.gap = '12px';

  for (const scope of scopes) {
    const card = document.createElement('div');
    card.style.border = '1px solid rgba(255,255,255,0.14)';
    card.style.borderRadius = '10px';
    card.style.padding = '12px';
    card.style.background = 'rgba(15, 23, 42, 0.35)';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.gap = '8px';

    const originLabel = document.createElement('div');
    originLabel.textContent = scope.origin;
    originLabel.style.fontWeight = '600';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Remove Domain';

    header.append(originLabel, deleteBtn);
    card.append(header);

    const patternsTitle = document.createElement('div');
    patternsTitle.textContent = 'Exact URL path patterns (optional)';
    patternsTitle.style.marginTop = '8px';
    card.append(patternsTitle);

    const patternsList = document.createElement('ul');
    patternsList.style.margin = '8px 0 0 16px';

    const patterns = Array.isArray(scope.urlPatterns) ? scope.urlPatterns : ([] as string[]);
    if (patterns.length === 0) {
      const li = document.createElement('li');
      li.textContent = '(none)';
      patternsList.append(li);
    } else {
      for (const p of patterns) {
        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.gap = '8px';
        li.style.alignItems = 'center';

        const span = document.createElement('span');
        span.textContent = p;

        const removePatternBtn = document.createElement('button');
        removePatternBtn.type = 'button';
        removePatternBtn.textContent = 'Remove';

        removePatternBtn.addEventListener('click', () => {
          void (async (): Promise<void> => {
            const nextScopes = scopes.map((s) => {
              if (s.origin !== scope.origin) {
                return s;
              }
              return { ...s, urlPatterns: (s.urlPatterns ?? []).filter((x) => x !== p) };
            });
            const ok = await saveAllowedScopes(nextScopes);
            if (ok) {
              onRefresh();
            }
          })();
        });

        li.append(span, removePatternBtn);
        patternsList.append(li);
      }
    }

    card.append(patternsList);

    const addPatternRow = document.createElement('div');
    addPatternRow.style.display = 'flex';
    addPatternRow.style.gap = '8px';
    addPatternRow.style.marginTop = '8px';
    addPatternRow.style.flexWrap = 'wrap';

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.placeholder = '/checkout';
    patternInput.style.minWidth = '220px';

    const addPatternBtn = document.createElement('button');
    addPatternBtn.type = 'button';
    addPatternBtn.textContent = 'Add Pattern';

    addPatternRow.append(patternInput, addPatternBtn);
    card.append(addPatternRow);

    addPatternBtn.addEventListener('click', () => {
      const normalized = normalizeUrlPattern(patternInput.value);
      if (!normalized) {
        return;
      }
      void (async (): Promise<void> => {
        const nextScopes = scopes.map((s) => {
          if (s.origin !== scope.origin) {
            return s;
          }
          const set = new Set<string>((s.urlPatterns ?? []).map((x) => normalizeUrlPattern(x)).filter((x) => x.length > 0));
          set.add(normalized);
          return { ...s, urlPatterns: Array.from(set.values()).sort() };
        });
        const ok = await saveAllowedScopes(nextScopes);
        if (ok) {
          onRefresh();
        }
      })();
    });

    deleteBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        if (scopes.length <= 1) {
          return;
        }
        const confirmed = await showConfirm({
          title: 'Remove Domain',
          message: `Remove domain ${scope.origin}? This will also remove its permission.`,
          confirmText: 'Remove'
        });
        if (!confirmed) return;
        const nextScopes = scopes.filter((s) => s.origin !== scope.origin);
        const ok = await saveAllowedScopes(nextScopes);
        if (ok) {
          await removeOriginPermission(scope.origin);
          onRefresh();
        }
      })();
    });

    list.append(card);
  }

  root.append(list);
}

function formatTimeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

type ModalInputMode = 'none' | 'text';

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

function openModal<T>(params: {
  title: string;
  message: string;
  mode: ModalInputMode;
  defaultValue?: string;
  confirmText: string;
  cancelText: string;
  mapResult: (confirmed: boolean, value: string) => T;
}): Promise<T> {
  const modal = getModalElements();
  if (!modal) {
    return Promise.resolve(params.mapResult(false, ''));
  }

  modal.title.textContent = params.title;
  modal.message.textContent = params.message;
  modal.confirm.textContent = params.confirmText;
  modal.cancel.textContent = params.cancelText;
  modal.input.value = params.defaultValue ?? '';
  modal.input.style.display = params.mode === 'text' ? 'block' : 'none';

  modal.root.classList.add('active');
  modal.root.setAttribute('aria-hidden', 'false');

  if (params.mode === 'text') {
    setTimeout(() => {
      modal.input.focus();
      modal.input.select();
    }, 0);
  }

  return new Promise<T>((resolve) => {
    let settled = false;

    const finish = (confirmed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      closeModal(modal);
      resolve(params.mapResult(confirmed, modal.input.value));
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        finish(false);
      }
      if (event.key === 'Enter' && params.mode === 'text') {
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

async function showConfirm(params: { title: string; message: string; confirmText?: string; cancelText?: string }): Promise<boolean> {
  return openModal<boolean>({
    title: params.title,
    message: params.message,
    mode: 'none',
    confirmText: params.confirmText ?? 'Confirm',
    cancelText: params.cancelText ?? 'Cancel',
    mapResult: (confirmed) => confirmed
  });
}

async function showPrompt(params: { title: string; message: string; defaultValue?: string; confirmText?: string; cancelText?: string }): Promise<string | null> {
  return openModal<string | null>({
    title: params.title,
    message: params.message,
    mode: 'text',
    defaultValue: params.defaultValue,
    confirmText: params.confirmText ?? 'Confirm',
    cancelText: params.cancelText ?? 'Cancel',
    mapResult: (confirmed, value) => (confirmed ? value : null)
  });
}

function setEmpty(elId: string, message: string): void {
  const el = document.getElementById(elId);
  if (el) {
    el.textContent = message;
  }
}

function clearEmpty(elId: string): void {
  const el = document.getElementById(elId);
  if (el) {
    el.textContent = '';
  }
}

function setSessionsEmpty(message: string): void {
  setEmpty('sessions-empty', message);
  const table = document.getElementById('sessions-table') as HTMLTableElement | null;
  if (table) {
    table.innerHTML = '';
  }
}

function clearSessionsEmpty(): void {
  clearEmpty('sessions-empty');
}

function setRegressionEmpty(message: string): void {
  setEmpty('regression-empty', message);
  const table = document.getElementById('regression-table') as HTMLTableElement | null;
  if (table) {
    table.innerHTML = '';
  }
  clearComparisonTable();
}

function clearRegressionEmpty(): void {
  clearEmpty('regression-empty');
}

function renderTrendChart(params: {
  canvasId: string;
  emptyId: string;
  label: string;
  points: Array<{ ts: number; value: number }>;
  color: { border: string; fill: string };
  yMin?: number;
  yMax?: number;
}): ChartInstance | null {
  const canvas = document.getElementById(params.canvasId) as HTMLCanvasElement | null;
  if (!canvas) {
    return null;
  }

  const trimmed = params.points.length > maxTrendPoints ? params.points.slice(-maxTrendPoints) : params.points;
  if (trimmed.length < 2) {
    setEmpty(params.emptyId, 'Not enough sessions to display chart.');
    return null;
  }

  clearEmpty(params.emptyId);

  const labels = trimmed.map((point) => formatTimeLabel(point.ts));
  const data = trimmed.map((point) => point.value);

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: params.label,
          data,
          borderColor: params.color.border,
          backgroundColor: params.color.fill,
          tension: 0.25,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true }
      },
      scales: {
        y: {
          min: params.yMin,
          max: params.yMax,
          ticks: { color: 'rgba(255,255,255,0.72)' },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        x: {
          ticks: { color: 'rgba(255,255,255,0.72)' },
          grid: { color: 'rgba(255,255,255,0.06)' }
        }
      }
    }
  });

  return chart as ChartInstance;
}

type MetricStatus = 'green' | 'orange' | 'red';

function getMetricStatus(metric: 'lcp' | 'load' | 'cls' | 'tbt', value: number): MetricStatus {
  if (metric === 'lcp') {
    if (value <= 2500) return 'green';
    if (value <= 4000) return 'orange';
    return 'red';
  }
  if (metric === 'cls') {
    if (value <= 0.1) return 'green';
    if (value <= 0.25) return 'orange';
    return 'red';
  }
  if (metric === 'tbt') {
    if (value <= 200) return 'green';
    if (value <= 600) return 'orange';
    return 'red';
  }
  if (value <= 3000) return 'green';
  if (value <= 6000) return 'orange';
  return 'red';
}

function metricStatusToRgba(status: MetricStatus, alpha: number): string {
  const clampedAlpha = clamp(alpha, 0, 1);
  if (status === 'green') return `rgba(34, 197, 94, ${clampedAlpha})`;
  if (status === 'orange') return `rgba(249, 115, 22, ${clampedAlpha})`;
  return `rgba(239, 68, 68, ${clampedAlpha})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


function renderOverviewTrendChart(sessions: SessionMetrics[]): void {
  const canvas = document.getElementById('overviewCanvas') as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }

  const points = sessions
    .map((session) => {
      const ts = toFiniteNumber(session.timestamp);
      const loadTime = toFiniteNumber(session.loadMetrics?.totalLoadTime);
      if (ts === null || loadTime === null) {
        return null;
      }
      return { ts, loadTime };
    })
    .filter((value): value is { ts: number; loadTime: number } => value !== null)
    .sort((a, b) => a.ts - b.ts);

  const trimmed = points.length > maxTrendPoints ? points.slice(-maxTrendPoints) : points;
  if (trimmed.length < 2) {
    setEmpty('overview-empty', 'Not enough sessions to display chart.');
    overviewChart?.destroy();
    overviewChart = null;
    return;
  }

  clearEmpty('overview-empty');

  const labels = trimmed.map((point) => formatTimeLabel(point.ts));
  const data = trimmed.map((point) => point.loadTime);

  overviewChart?.destroy();
  overviewChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `Total Load Time (ms) - ${activeTag}`,
          data,
          borderColor: 'rgba(96, 165, 250, 0.95)',
          backgroundColor: 'rgba(96, 165, 250, 0.20)',
          tension: 0.25,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true }
      },
      scales: {
        y: {
          min: overviewChartYMin,
          max: overviewChartYMax,
          ticks: { color: 'rgba(255,255,255,0.72)' },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        x: {
          ticks: { color: 'rgba(255,255,255,0.72)' },
          grid: { color: 'rgba(255,255,255,0.06)' }
        }
      }
    }
  });
}

function renderLcpTrendChart(sessions: SessionMetrics[]): void {
  const points = sessions
    .map((session) => {
      const ts = toFiniteNumber(session.timestamp);
      const value = toFiniteNumber(session.webVitals?.lcp);
      if (ts === null || value === null) {
        return null;
      }
      return { ts, value };
    })
    .filter((value): value is { ts: number; value: number } => value !== null)
    .sort((a, b) => a.ts - b.ts);

  lcpTrendChart?.destroy();
  lcpTrendChart = renderTrendChart({
    canvasId: 'lcpTrendCanvas',
    emptyId: 'lcp-trend-empty',
    label: `LCP (ms) - ${activeTag}`,
    points,
    color: { border: 'rgba(244, 114, 182, 0.95)', fill: 'rgba(244, 114, 182, 0.20)' }
  });
}

function renderFcpTrendChart(sessions: SessionMetrics[]): void {
  const points = sessions
    .map((session) => {
      const ts = toFiniteNumber(session.timestamp);
      const value = toFiniteNumber(session.webVitals?.fcp);
      if (ts === null || value === null) {
        return null;
      }
      return { ts, value };
    })
    .filter((value): value is { ts: number; value: number } => value !== null)
    .sort((a, b) => a.ts - b.ts);

  fcpTrendChart?.destroy();
  fcpTrendChart = renderTrendChart({
    canvasId: 'fcpTrendCanvas',
    emptyId: 'fcp-trend-empty',
    label: `FCP (ms) - ${activeTag}`,
    points,
    color: { border: 'rgba(34, 197, 94, 0.95)', fill: 'rgba(34, 197, 94, 0.20)' }
  });
}

function renderClsTrendChart(sessions: SessionMetrics[]): void {
  const points = sessions
    .map((session) => {
      const ts = toFiniteNumber(session.timestamp);
      const value = toFiniteNumber(session.webVitals?.cls);
      if (ts === null || value === null) {
        return null;
      }
      return { ts, value };
    })
    .filter((value): value is { ts: number; value: number } => value !== null)
    .sort((a, b) => a.ts - b.ts);

  clsTrendChart?.destroy();
  clsTrendChart = renderTrendChart({
    canvasId: 'clsTrendCanvas',
    emptyId: 'cls-trend-empty',
    label: `CLS - ${activeTag}`,
    points,
    color: { border: 'rgba(250, 204, 21, 0.95)', fill: 'rgba(250, 204, 21, 0.20)' },
    yMin: 0
  });
}

function clearComparisonTable(): void {
  const table = document.getElementById('comparison-table') as HTMLTableElement | null;
  if (table) {
    table.innerHTML = '';
  }
}

function formatMetricValue(metric: 'load' | 'lcp' | 'tbt' | 'cls', value: number): string {
  if (metric === 'cls') {
    return value.toFixed(3);
  }
  const seconds = value / 1000;
  return `${seconds.toFixed(2)} s`;
}

function renderComparisonTable(metrics: Record<string, RegressionMetric>): void {
  const table = document.getElementById('comparison-table') as HTMLTableElement | null;
  if (!table) {
    return;
  }

  table.innerHTML = '';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const title of ['Metric', 'Baseline Value (P95/P75)', 'Current Value', 'Change %', 'Status']) {
    const th = document.createElement('th');
    th.textContent = title;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');

  const rows: Array<{ key: 'load' | 'lcp' | 'cls' | 'tbt'; label: string }> = [
    { key: 'load', label: 'Load (P95)' },
    { key: 'lcp', label: 'LCP (P95)' },
    { key: 'cls', label: 'CLS (P75)' },
    { key: 'tbt', label: 'TBT (P95)' }
  ];

  for (const row of rows) {
    const metric = metrics[row.key];
    const tr = document.createElement('tr');

    const tdMetric = document.createElement('td');
    tdMetric.textContent = row.label;

    const tdBase = document.createElement('td');
    tdBase.textContent = formatMetricValue(row.key, metric?.baseline ?? 0);

    const tdCur = document.createElement('td');
    tdCur.textContent = formatMetricValue(row.key, metric?.current ?? 0);

    const tdChange = document.createElement('td');
    tdChange.textContent = formatChange(metric?.changePercent ?? 0);

    const tdStatus = document.createElement('td');
    tdStatus.textContent = metric?.status ?? 'neutral';

    tr.append(tdMetric, tdBase, tdCur, tdChange, tdStatus);
    tbody.append(tr);
  }

  table.append(thead, tbody);
}

function renderComparisonChart(tagA: string, avgA: MetricAverages, tagB: string, avgB: MetricAverages): void {
  const canvas = document.getElementById('compareCanvas') as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }

  clearEmpty('compare-empty');

  const metricKeys: Array<'lcp' | 'cls' | 'tbt' | 'load'> = ['lcp', 'cls', 'tbt', 'load'];
  const labels = ['LCP', 'CLS', 'TBT', 'Load'];

  const valuesA = [avgA.lcpAvg, avgA.clsAvg, avgA.tbtAvg, avgA.loadTimeAvg];
  const valuesB = [avgB.lcpAvg, avgB.clsAvg, avgB.tbtAvg, avgB.loadTimeAvg];

  const colorsA = valuesA.map((value, index) => metricStatusToRgba(getMetricStatus(metricKeys[index], value), 0.35));
  const bordersA = valuesA.map((value, index) => metricStatusToRgba(getMetricStatus(metricKeys[index], value), 0.85));

  const colorsB = valuesB.map((value, index) => metricStatusToRgba(getMetricStatus(metricKeys[index], value), 0.35));
  const bordersB = valuesB.map((value, index) => metricStatusToRgba(getMetricStatus(metricKeys[index], value), 0.85));

  compareChart?.destroy();
  compareChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: tagA,
          data: valuesA,
          backgroundColor: colorsA,
          borderColor: bordersA,
          borderWidth: 1
        },
        {
          label: tagB,
          data: valuesB,
          backgroundColor: colorsB,
          borderColor: bordersB,
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true }
      },
      scales: {
        y: {
          ticks: { color: 'rgba(255,255,255,0.72)' },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        x: {
          ticks: { color: 'rgba(255,255,255,0.72)' },
          grid: { color: 'rgba(255,255,255,0.06)' }
        }
      }
    }
  });
}

function renderTagSelect(selectId: string, selected: string): void {
  const select = document.getElementById(selectId) as HTMLSelectElement | null;
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

  select.value = selected;
}

async function refreshDashboard(): Promise<void> {
  try {
    const sessions = await fetchSessionsByTag(activeTag);

    if (sessions.length === 0) {
      setSessionsEmpty(`No sessions available for tag '${activeTag}'.`);

      setEmpty('overview-empty', `No sessions available for tag '${activeTag}'.`);
      overviewChart?.destroy();
      overviewChart = null;

      setEmpty('lcp-trend-empty', `No sessions available for tag '${activeTag}'.`);
      lcpTrendChart?.destroy();
      lcpTrendChart = null;

      setEmpty('fcp-trend-empty', `No sessions available for tag '${activeTag}'.`);
      fcpTrendChart?.destroy();
      fcpTrendChart = null;

      setEmpty('cls-trend-empty', `No sessions available for tag '${activeTag}'.`);
      clsTrendChart?.destroy();
      clsTrendChart = null;
      return;
    }

    renderSessionsTable(sessions);
    renderOverviewTrendChart(sessions);
    renderLcpTrendChart(sessions);
    renderFcpTrendChart(sessions);
    renderClsTrendChart(sessions);
    const averages = computeAverages(sessions);
    void averages;
  } catch {
    setEmpty('overview-empty', 'Unable to load trend chart.');
    overviewChart?.destroy();
    overviewChart = null;
    setEmpty('lcp-trend-empty', 'Unable to load trend chart.');
    lcpTrendChart?.destroy();
    lcpTrendChart = null;
    setEmpty('fcp-trend-empty', 'Unable to load trend chart.');
    fcpTrendChart?.destroy();
    fcpTrendChart = null;
    setEmpty('cls-trend-empty', 'Unable to load trend chart.');
    clsTrendChart?.destroy();
    clsTrendChart = null;
    setSessionsEmpty('Unable to load sessions table.');
  }
}

async function runComparison(): Promise<void> {
  try {
    const [sessionsA, sessionsB] = await Promise.all([fetchSessionsByTag(compareTagA), fetchSessionsByTag(compareTagB)]);

    if (sessionsA.length === 0 || sessionsB.length === 0) {
      setEmpty('compare-empty', 'Not enough sessions to compare.');
      compareChart?.destroy();
      compareChart = null;
      clearComparisonTable();

      setRegressionBanner('neutral');
      setRegressionEmpty('Not enough data for regression analysis.');
      await sendBadgeStatus('neutral');
      return;
    }

    if (sessionsA.length < regressionMinSessions || sessionsB.length < regressionMinSessions) {
      setRegressionBanner('neutral');
      setRegressionEmpty('Not enough data for regression analysis.');
      clearComparisonTable();
      await sendBadgeStatus('neutral');
    } else {
      const loadTimesA = sessionsA
        .map((session) => toFiniteNumber(session.loadMetrics?.totalLoadTime))
        .filter((value): value is number => value !== null);
      const loadTimesB = sessionsB
        .map((session) => toFiniteNumber(session.loadMetrics?.totalLoadTime))
        .filter((value): value is number => value !== null);

      const lcpA = sessionsA
        .map((session) => toFiniteNumber(session.webVitals?.lcp))
        .filter((value): value is number => value !== null);
      const lcpB = sessionsB
        .map((session) => toFiniteNumber(session.webVitals?.lcp))
        .filter((value): value is number => value !== null);

      const tbtA = sessionsA
        .map((session) => toFiniteNumber(session.webVitals?.tbt))
        .filter((value): value is number => value !== null);
      const tbtB = sessionsB
        .map((session) => toFiniteNumber(session.webVitals?.tbt))
        .filter((value): value is number => value !== null);

      const clsA = sessionsA
        .map((session) => toFiniteNumber(session.webVitals?.cls))
        .filter((value): value is number => value !== null);
      const clsB = sessionsB
        .map((session) => toFiniteNumber(session.webVitals?.cls))
        .filter((value): value is number => value !== null);

      const loadP95A = percentile(loadTimesA, regressionPercentileP95);
      const loadP95B = percentile(loadTimesB, regressionPercentileP95);
      const lcpP95A = percentile(lcpA, regressionPercentileP95);
      const lcpP95B = percentile(lcpB, regressionPercentileP95);
      const tbtP95A = percentile(tbtA, regressionPercentileP95);
      const tbtP95B = percentile(tbtB, regressionPercentileP95);
      const clsP75A = percentile(clsA, regressionPercentileP75);
      const clsP75B = percentile(clsB, regressionPercentileP75);

      const loadChange = percentChange(loadP95A, loadP95B);
      const lcpChange = percentChange(lcpP95A, lcpP95B);
      const tbtChange = percentChange(tbtP95A, tbtP95B);
      const clsChange = percentChange(clsP75A, clsP75B);

      const regressionMetrics: Record<string, RegressionMetric> = {
        load: {
          baseline: loadP95A,
          current: loadP95B,
          changePercent: loadChange,
          status: classifyChange(loadChange)
        },
        lcp: {
          baseline: lcpP95A,
          current: lcpP95B,
          changePercent: lcpChange,
          status: classifyChange(lcpChange)
        },
        tbt: {
          baseline: tbtP95A,
          current: tbtP95B,
          changePercent: tbtChange,
          status: classifyChange(tbtChange)
        },
        cls: {
          baseline: clsP75A,
          current: clsP75B,
          changePercent: clsChange,
          status: classifyCls(clsChange, clsP75A, clsP75B)
        }
      };

      const statuses = Object.values(regressionMetrics).map((metric) => metric.status);
      const hasRegressed = statuses.includes('regressed');
      const hasImproved = statuses.includes('improved');

      clearRegressionEmpty();
      renderRegressionTable(regressionMetrics);
      renderComparisonTable(regressionMetrics);

      if (hasRegressed) {
        setRegressionBanner('bad');
        await sendBadgeStatus('bad');
      } else if (hasImproved) {
        setRegressionBanner('good');
        await sendBadgeStatus('good');
      } else {
        setRegressionBanner('neutral');
        await sendBadgeStatus('neutral');
      }
    }

    const avgA = computeAverages(sessionsA);
    const avgB = computeAverages(sessionsB);
    renderComparisonChart(compareTagA, avgA, compareTagB, avgB);
  } catch {
    setEmpty('compare-empty', 'Unable to load comparison chart.');
    compareChart?.destroy();
    compareChart = null;

    setRegressionBanner('neutral');
    setRegressionEmpty('Unable to load regression analysis.');
    await sendBadgeStatus('neutral');
  }
}

function setupHandlers(): void {
  const tabData = document.getElementById('tab-btn-data') as HTMLButtonElement | null;
  tabData?.addEventListener('click', () => {
    setActiveTab('data');
  });

  const tabGraphs = document.getElementById('tab-btn-graphs') as HTMLButtonElement | null;
  tabGraphs?.addEventListener('click', () => {
    setActiveTab('graphs');
  });

  const tabSettings = document.getElementById('tab-btn-settings') as HTMLButtonElement | null;
  tabSettings?.addEventListener('click', () => {
    setActiveTab('settings');
  });

  const activeTagSelect = document.getElementById('active-tag') as HTMLSelectElement | null;
  activeTagSelect?.addEventListener('change', () => {
    const next = normalizeTag(activeTagSelect.value);
    void (async (): Promise<void> => {
      const ok = await updateActiveTag(next);
      if (!ok) {
        return;
      }
      activeTag = next;
      compareTagB = activeTag;
      renderTagSelect('active-tag', activeTag);
      renderTagSelect('compare-tag-b', compareTagB);
      await refreshDashboard();
      await runComparison();
    })();
  });

  const addDomainButton = document.getElementById('add-domain') as HTMLButtonElement | null;
  addDomainButton?.addEventListener('click', () => {
    void (async (): Promise<void> => {
      const input = await showPrompt({
        title: 'Add Domain',
        message: 'Enter domain origin (example: https://example.com)',
        confirmText: 'Add'
      });
      if (input === null) {
        return;
      }
      const origin = normalizeOrigin(input);
      if (!origin) {
        return;
      }

      const scopes = await fetchAllowedScopes();
      if (scopes.some((s) => s.origin === origin)) {
        return;
      }

      const granted = await requestOriginPermission(origin);
      if (!granted) {
        return;
      }

      const nextScopes: AllowedScope[] = [...scopes, { origin, urlPatterns: [] as string[] }].sort((a, b) => a.origin.localeCompare(b.origin));
      const ok = await saveAllowedScopes(nextScopes);
      if (!ok) {
        return;
      }

      allowedScopes = await fetchAllowedScopes();
      selectedDomain = origin;
      selectedUrlPatterns = allowedScopes.find((s) => s.origin === selectedDomain)?.urlPatterns ?? ([] as string[]);

      const domainSelect = document.getElementById('domain-selector') as HTMLSelectElement | null;
      if (domainSelect) {
        domainSelect.innerHTML = '';
        for (const scope of allowedScopes) {
          const opt = document.createElement('option');
          opt.value = scope.origin;
          opt.textContent = scope.origin;
          domainSelect.append(opt);
        }
        domainSelect.value = selectedDomain;
      }

      availableTags = await fetchAllTags();
      activeTag = await fetchActiveTag();
      if (!availableTags.includes(activeTag)) {
        activeTag = baselineTag;
      }

      compareTagB = activeTag;
      const alternative = availableTags.find((tag) => tag !== compareTagB);
      compareTagA = alternative ?? baselineTag;
      if (compareTagA === compareTagB) {
        compareTagA = baselineTag;
      }

      renderTagSelect('active-tag', activeTag);
      renderTagSelect('compare-tag-a', compareTagA);
      renderTagSelect('compare-tag-b', compareTagB);
      await refreshDashboard();
      await runComparison();
    })();
  });

  const addVersionButton = document.getElementById('add-version') as HTMLButtonElement | null;
  addVersionButton?.addEventListener('click', () => {
    void (async (): Promise<void> => {
      const input = await showPrompt({
        title: 'Add Version',
        message: 'Enter a new version tag name',
        confirmText: 'Add'
      });
      if (input === null) {
        return;
      }

      const next = normalizeTag(input);
      if (!next || next === baselineTag) {
        return;
      }

      const ok = await updateActiveTag(next);
      if (!ok) {
        return;
      }

      availableTags = await fetchAllTags();
      activeTag = next;
      compareTagB = activeTag;
      const alternative = availableTags.find((tag) => tag !== compareTagB);
      compareTagA = alternative ?? baselineTag;
      if (compareTagA === compareTagB) {
        compareTagA = baselineTag;
      }

      renderTagSelect('active-tag', activeTag);
      renderTagSelect('compare-tag-a', compareTagA);
      renderTagSelect('compare-tag-b', compareTagB);
      await refreshDashboard();
      await runComparison();
    })();
  });

  const refreshButton = document.getElementById('refresh') as HTMLButtonElement | null;
  void refreshButton;

  const deleteButton = document.getElementById('delete-version') as HTMLButtonElement | null;
  deleteButton?.addEventListener('click', () => {
    if (activeTag === baselineTag) {
      return;
    }
    const origin = selectedDomain;

    void (async (): Promise<void> => {
      const confirmed = await showConfirm({
        title: 'Delete Version',
        message: `Delete version '${activeTag}' for this domain?`,
        confirmText: 'Delete'
      });
      if (!confirmed) {
        return;
      }

      const alsoDelete = await showConfirm({
        title: 'Delete Sessions',
        message: 'Delete sessions too? If you cancel, sessions are kept and reassigned to baseline.',
        confirmText: 'Delete Sessions',
        cancelText: 'Keep Sessions'
      });

      const res = await chrome.runtime.sendMessage({ action: 'DELETE_VERSION', payload: { origin, tag: activeTag, deleteSessions: alsoDelete } });
      if (!isRecord(res) || res.ok !== true) {
        return;
      }
      availableTags = await fetchAllTags();
      if (!availableTags.includes(activeTag)) {
        activeTag = baselineTag;
      }
      renderTagSelect('active-tag', activeTag);
      renderTagSelect('compare-tag-a', compareTagA);
      renderTagSelect('compare-tag-b', compareTagB);
      await refreshDashboard();
      await runComparison();
    })();
  });

  const deleteDomainButton = document.getElementById('delete-domain') as HTMLButtonElement | null;
  deleteDomainButton?.addEventListener('click', () => {
    void (async (): Promise<void> => {
      const scopes = await fetchAllowedScopes();
      if (scopes.length <= 1) {
        return;
      }

      const origin = selectedDomain;
      const confirmed = await showConfirm({
        title: 'Delete Domain',
        message: `Delete domain ${origin} and all its data?`,
        confirmText: 'Delete'
      });
      if (!confirmed) {
        return;
      }

      const res = await chrome.runtime.sendMessage({ action: 'DELETE_DOMAIN', payload: { origin } });
      if (!isRecord(res) || res.ok !== true) {
        return;
      }

      allowedScopes = await fetchAllowedScopes();
      const allowed = allowedScopes.map((s) => s.origin);
      const nextOrigin = allowedScopes.find((s) => s.origin !== origin)?.origin ?? allowedScopes[0]?.origin ?? '';
      if (!nextOrigin) {
        return;
      }

      selectedDomain = nextOrigin;
      selectedUrlPatterns = allowedScopes.find((s) => s.origin === selectedDomain)?.urlPatterns ?? ([] as string[]);

      const domainSelect = document.getElementById('domain-selector') as HTMLSelectElement | null;
      const domainDisplay = document.getElementById('current-domain-display');
      if (domainSelect) {
        domainSelect.innerHTML = '';
        for (const d of allowed) {
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = d;
          domainSelect.append(opt);
        }
        domainSelect.value = selectedDomain;
      }
      if (domainDisplay) {
        domainDisplay.textContent = selectedDomain;
      }

      availableTags = await fetchAllTags();
      activeTag = await fetchActiveTag();
      if (!availableTags.includes(activeTag)) {
        activeTag = baselineTag;
      }

      compareTagB = activeTag;
      const alternative = availableTags.find((tag) => tag !== compareTagB);
      compareTagA = alternative ?? baselineTag;
      if (compareTagA === compareTagB) {
        compareTagA = baselineTag;
      }

      renderTagSelect('active-tag', activeTag);
      renderTagSelect('compare-tag-a', compareTagA);
      renderTagSelect('compare-tag-b', compareTagB);
      await refreshDashboard();
      await runComparison();
    })();
  });

  const compareA = document.getElementById('compare-tag-a') as HTMLSelectElement | null;
  compareA?.addEventListener('change', () => {
    compareTagA = normalizeTag(compareA.value);
  });

  const compareB = document.getElementById('compare-tag-b') as HTMLSelectElement | null;
  compareB?.addEventListener('change', () => {
    compareTagB = normalizeTag(compareB.value);
  });

  const compareButton = document.getElementById('compare') as HTMLButtonElement | null;
  compareButton?.addEventListener('click', () => {
    void runComparison();
  });

  window.addEventListener('beforeunload', () => {
    destroyCharts();
  });
}

async function init(): Promise<void> {
  setupHandlers();
  const hash = typeof window.location.hash === 'string' ? window.location.hash : '';
  setActiveTab(hash === '#settings' ? 'settings' : 'data');

  const settingsRoot = document.getElementById('domain-settings-root') as HTMLElement | null;

  chrome.runtime.onMessage.addListener((message: unknown) => {
    const action = isRecord(message) ? message.action : null;
    void (async (): Promise<void> => {
      if (action === 'TAGS_UPDATED') {
        allowedScopes = await fetchAllowedScopes();
        availableTags = await fetchAllTags();
        activeTag = await fetchActiveTag();
        if (!availableTags.includes(activeTag)) {
          activeTag = baselineTag;
        }
        if (!availableTags.includes(compareTagA)) {
          compareTagA = baselineTag;
        }
        if (!availableTags.includes(compareTagB)) {
          compareTagB = activeTag;
        }
        renderTagSelect('active-tag', activeTag);
        renderTagSelect('compare-tag-a', compareTagA);
        renderTagSelect('compare-tag-b', compareTagB);
        await refreshDashboard();
        await runComparison();
        return;
      }

      if (action === 'DATA_UPDATED') {
        await refreshDashboard();
        await runComparison();
      }
    })();
  });

  try {
    allowedScopes = await fetchAllowedScopes();
    const allowed = allowedScopes.map((s) => s.origin);

    const domainSelect = document.getElementById('domain-selector') as HTMLSelectElement | null;
    const domainDisplay = document.getElementById('current-domain-display');

    function renderDomainSelector(domains: string[], selected: string): void {
      if (!domainSelect) return;
      domainSelect.innerHTML = '';
      for (const d of domains) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        domainSelect.append(opt);
      }
      domainSelect.value = selected;
      if (domainDisplay) {
        domainDisplay.textContent = selected;
      }
    }

    async function getActiveTabOrigin(): Promise<string | null> {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : undefined;
        const url = tab?.url;
        return getOriginFromUrl(url);
      } catch {
        return null;
      }
    }

    const currentOrigin = await getActiveTabOrigin();
    const initial = currentOrigin && allowed.includes(currentOrigin) ? currentOrigin : (allowed[0] ?? '');
    selectedDomain = initial;
    selectedUrlPatterns = allowedScopes.find((s) => s.origin === selectedDomain)?.urlPatterns ?? ([] as string[]);
    renderDomainSelector(allowed, selectedDomain);

    domainSelect?.addEventListener('change', () => {
      selectedDomain = domainSelect.value;
      selectedUrlPatterns = allowedScopes.find((s) => s.origin === selectedDomain)?.urlPatterns ?? ([] as string[]);
      if (domainDisplay) {
        domainDisplay.textContent = selectedDomain;
      }
      void (async (): Promise<void> => {
        availableTags = await fetchAllTags();
        activeTag = await fetchActiveTag();
        if (!availableTags.includes(activeTag)) {
          activeTag = baselineTag;
        }
        compareTagB = activeTag;
        const alternative = availableTags.find((tag) => tag !== compareTagB);
        compareTagA = alternative ?? baselineTag;
        if (compareTagA === compareTagB) {
          compareTagA = baselineTag;
        }
        renderTagSelect('active-tag', activeTag);
        renderTagSelect('compare-tag-a', compareTagA);
        renderTagSelect('compare-tag-b', compareTagB);
        await refreshDashboard();
        await runComparison();
      })();
    });

    availableTags = await fetchAllTags();
    activeTag = await fetchActiveTag();
    if (!availableTags.includes(activeTag)) {
      activeTag = baselineTag;
    }

    compareTagB = activeTag;
    const alternative = availableTags.find((tag) => tag !== compareTagB);
    compareTagA = alternative ?? baselineTag;
    if (compareTagA === compareTagB) {
      compareTagA = baselineTag;
    }

    renderTagSelect('active-tag', activeTag);
    renderTagSelect('compare-tag-a', compareTagA);
    renderTagSelect('compare-tag-b', compareTagB);

    await refreshDashboard();
    await runComparison();

    if (settingsRoot) {
      const refreshSettings = (): void => {
        void (async (): Promise<void> => {
          allowedScopes = await fetchAllowedScopes();
          renderDomainSettings(settingsRoot, allowedScopes, refreshSettings);

          const nextAllowed = allowedScopes.map((s) => s.origin);
          if (domainSelect && nextAllowed.length > 0) {
            const nextSelected = nextAllowed.includes(selectedDomain) ? selectedDomain : (nextAllowed[0] ?? '');
            selectedDomain = nextSelected;
            selectedUrlPatterns = allowedScopes.find((s) => s.origin === selectedDomain)?.urlPatterns ?? ([] as string[]);
            renderDomainSelector(nextAllowed, selectedDomain);
          }
        })();
      };
      refreshSettings();
    }
  } catch {
    setEmpty('overview-empty', 'Unable to initialize dashboard.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
