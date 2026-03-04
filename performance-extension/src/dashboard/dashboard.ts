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
  origin?: string;
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

interface TagSessionCount {
  tag: string;
  count: number;
}

interface RegressionMetric {
  baseline: number;
  current: number;
  changePercent: number;
  status: 'improved' | 'neutral' | 'regressed';
}

interface PerformanceReportMetadata {
  domain: string;
  baselineTag: string;
  currentTag: string;
  generatedAt: string;
  percentileModel: {
    load: 'P95';
    lcp: 'P95';
    tbt: 'P95';
    cls: 'P75';
  };
}

interface PerformanceReportMetricRow extends RegressionMetric {}

interface PerformanceReport {
  metadata: PerformanceReportMetadata;
  sessionCounts: {
    baseline: number;
    current: number;
  };
  metrics: {
    load: PerformanceReportMetricRow;
    lcp: PerformanceReportMetricRow;
    cls: PerformanceReportMetricRow;
    tbt: PerformanceReportMetricRow;
  };
  thresholdsUsed: {
    load: string;
    lcp: string;
    cls: string;
    tbt: string;
  };
}

interface AllowedScope {
  origin: string;
  urlPatterns: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getChromeRuntime(): { sendMessage: (message: unknown) => Promise<unknown>; onMessage?: { addListener: (callback: (message: unknown) => void) => void } } | null {
  const chromeValue = (globalThis as unknown as { chrome?: unknown }).chrome;
  if (!isRecord(chromeValue)) {
    return null;
  }

  const runtimeValue = chromeValue.runtime;
  if (!isRecord(runtimeValue) || typeof runtimeValue.sendMessage !== 'function') {
    return null;
  }

  const sendMessage = (runtimeValue.sendMessage as (message: unknown) => Promise<unknown>).bind(runtimeValue);
  const onMessageValue = runtimeValue.onMessage;
  const onMessage = isRecord(onMessageValue) && typeof onMessageValue.addListener === 'function'
    ? { addListener: (onMessageValue.addListener as (callback: (message: unknown) => void) => void).bind(onMessageValue) }
    : undefined;

  return { sendMessage, onMessage };
}

function getExtensionMode(): ExtensionMode {
  try {
    return import.meta.env.DEV ? 'dev' : 'silent';
  } catch {
    return 'silent';
  }
}

async function refreshAfterDomainChange(nextSelectedOrigin?: string): Promise<void> {
  allowedScopes = await fetchAllowedScopes();
  const allowed = allowedScopes.map((s) => s.origin);

  const domainSelect = document.getElementById('domain-selector') as HTMLSelectElement | null;
  const domainDisplay = document.getElementById('current-domain-display');

  const selected =
    typeof nextSelectedOrigin === 'string' && nextSelectedOrigin.length > 0 && allowed.includes(nextSelectedOrigin)
      ? nextSelectedOrigin
      : (allowed[0] ?? '');

  selectedDomain = selected;
  selectedUrlPatterns = allowedScopes.find((s) => s.origin === selectedDomain)?.urlPatterns ?? ([] as string[]);

  if (domainSelect) {
    domainSelect.innerHTML = '';
    for (const d of allowed) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      domainSelect.append(opt);
    }
    if (selectedDomain) {
      domainSelect.value = selectedDomain;
    }
  }

  if (domainDisplay) {
    domainDisplay.textContent = selectedDomain;
  }

  if (!selectedDomain) {
    setEmpty('overview-empty', 'No allowed domains configured yet. Add a domain first.');
    setEmpty('compare-empty', 'No allowed domains configured yet. Add a domain first.');
    setSessionsEmpty('No allowed domains configured yet. Add a domain first.');
    clearRegressionEmpty();
    clearComparisonDeltas();
    compareChart?.destroy();
    compareChart = null;
    destroyCharts();
    return;
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
}

function renderComparisonDeltasInsufficient(): void {
  const root = document.getElementById('comparison-deltas') as HTMLElement | null;
  if (!root) {
    return;
  }

  const rows: Array<{ label: string; badge: string }> = [
    { label: 'Load', badge: 'P95 Model' },
    { label: 'LCP', badge: 'P95 Model' },
    { label: 'CLS', badge: 'P75 Model (CLS)' },
    { label: 'TBT', badge: 'P95 Model' }
  ];

  root.innerHTML = '';
  for (const row of rows) {
    const card = document.createElement('div');
    card.className = 'delta-card needs';

    const top = document.createElement('div');
    top.className = 'delta-top';

    const title = document.createElement('div');
    title.className = 'delta-metric';
    title.textContent = row.label;

    const badge = document.createElement('div');
    badge.className = 'delta-badge';
    badge.textContent = row.badge;

    top.append(title, badge);

    const change = document.createElement('div');
    change.className = 'delta-change';
    change.textContent = 'Insufficient data';

    card.append(top, change);
    root.append(card);
  }
}

async function fetchAllowedScopes(): Promise<AllowedScope[]> {
  try {
    const runtime = getChromeRuntime();
    if (!runtime) {
      return [];
    }
    const resp = await runtime.sendMessage({ action: 'GET_ALLOWED_SCOPES' });
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
    const hasScheme = /^https?:\/\//i.test(trimmed);
    const normalized = hasScheme ? trimmed : `http://${trimmed}`;
    return new URL(normalized).origin;
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
    const runtime = getChromeRuntime();
    if (!runtime) {
      return false;
    }
    const res = await runtime.sendMessage({ action: 'SET_ALLOWED_SCOPES', payload: { scopes } });
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

function formatLastUpdatedLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatKpiValue(metric: 'load' | 'lcp' | 'tbt' | 'cls', value: number): string {
  if (metric === 'cls') {
    return value.toFixed(3);
  }
  if (metric === 'tbt') {
    return `${Math.round(value)} ms`;
  }
  return `${Math.round(value)} ms`;
}

function mapStatusToKpiClass(status: 'green' | 'orange' | 'red'): 'good' | 'needs' | 'poor' {
  if (status === 'green') return 'good';
  if (status === 'orange') return 'needs';
  return 'poor';
}

function renderKpiSummaryRow(sessions: SessionMetrics[]): void {
  const root = document.getElementById('kpi-summary-row') as HTMLElement | null;
  if (!root) {
    return;
  }

  const loadValues = sessions
    .map((s) => toFiniteNumber(s.loadMetrics?.totalLoadTime))
    .filter((v): v is number => v !== null);
  const lcpValues = sessions
    .map((s) => toFiniteNumber(s.webVitals?.lcp))
    .filter((v): v is number => v !== null);
  const clsValues = sessions
    .map((s) => toFiniteNumber(s.webVitals?.cls))
    .filter((v): v is number => v !== null);
  const tbtValues = sessions
    .map((s) => toFiniteNumber(s.webVitals?.tbt))
    .filter((v): v is number => v !== null);

  const loadP95 = percentile(loadValues, regressionPercentileP95);
  const lcpP95 = percentile(lcpValues, regressionPercentileP95);
  const clsP75 = percentile(clsValues, regressionPercentileP75);
  const tbtP95 = percentile(tbtValues, regressionPercentileP95);

  const items: Array<{ metric: 'load' | 'lcp' | 'cls' | 'tbt'; name: string; model: string; value: number }>= [
    { metric: 'load', name: 'Load', model: 'P95', value: loadP95 },
    { metric: 'lcp', name: 'LCP', model: 'P95', value: lcpP95 },
    { metric: 'cls', name: 'CLS', model: 'P75', value: clsP75 },
    { metric: 'tbt', name: 'TBT', model: 'P95', value: tbtP95 }
  ];

  root.innerHTML = '';
  for (const item of items) {
    const status = getMetricStatus(item.metric, item.value);
    const card = document.createElement('div');
    card.className = `kpi-card-compact ${mapStatusToKpiClass(status)}`;

    const top = document.createElement('div');
    top.className = 'kpi-top';

    const name = document.createElement('div');
    name.className = 'kpi-name';
    name.textContent = item.name;

    const model = document.createElement('div');
    model.className = 'kpi-model';
    model.textContent = `${item.model} Model`;

    top.append(name, model);

    const value = document.createElement('div');
    value.className = 'kpi-value';
    value.textContent = formatKpiValue(item.metric, item.value);

    card.append(top, value);
    root.append(card);
  }
}

function renderMetadataStrip(params: {
  domain: string;
  baselineTag: string;
  currentTag: string;
  baselineSessions: number;
  currentSessions: number;
  lastUpdated: number;
}): void {
  const strip = document.getElementById('metadata-strip') as HTMLElement | null;
  if (!strip) {
    return;
  }

  const entries: Array<{ key: string; value: string }> = [
    { key: 'Percentile Model', value: 'Load/LCP/TBT = P95 | CLS = P75' },
    { key: 'Last Updated', value: formatLastUpdatedLabel(params.lastUpdated) }
  ];

  strip.innerHTML = '';
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'meta-item';

    const key = document.createElement('div');
    key.className = 'meta-key';
    key.textContent = `${entry.key}:`;

    const value = document.createElement('div');
    value.className = 'meta-value';
    value.textContent = entry.value;

    item.append(key, value);
    strip.append(item);
  }
}

function setGraphsLoading(active: boolean): void {
  const node = document.getElementById('graphs-loading') as HTMLElement | null;
  if (!node) {
    return;
  }

  node.classList.toggle('active', active);
  node.setAttribute('aria-hidden', active ? 'false' : 'true');
}

function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatSecondsForReport(valueMs: number): string {
  const seconds = valueMs / 1000;
  return `${seconds.toFixed(2)}s`;
}

function formatChangeForReport(value: number): string {
  return `${value.toFixed(1)}%`;
}

function resolveRegressionBanner(metrics: PerformanceReport['metrics']): { state: 'good' | 'neutral' | 'bad'; text: string } {
  const statuses = Object.values(metrics).map((m) => m.status);
  const hasRegressed = statuses.includes('regressed');
  const hasImproved = statuses.includes('improved');

  if (hasRegressed) {
    return { state: 'bad', text: 'Performance Regression Detected' };
  }
  if (hasImproved) {
    return { state: 'good', text: 'Performance Improved' };
  }
  return { state: 'neutral', text: 'No Significant Performance Change' };
}

function metricRowLabel(metric: keyof PerformanceReport['metrics']): string {
  if (metric === 'load') return 'Load';
  if (metric === 'lcp') return 'LCP';
  if (metric === 'cls') return 'CLS';
  return 'TBT';
}

function statusLabel(status: RegressionMetric['status']): string {
  if (status === 'improved') return 'improved';
  if (status === 'regressed') return 'regressed';
  return 'neutral';
}

async function buildPerformanceReport(origin: string, baseline: string, current: string): Promise<PerformanceReport> {
  const baselineTagNormalized = normalizeTag(baseline);
  const currentTagNormalized = normalizeTag(current);

  const urlPatterns = allowedScopes.find((s) => s.origin === origin)?.urlPatterns ?? selectedUrlPatterns;

  const [baselineSessions, currentSessions] = await Promise.all([
    fetchSessionsByTagForOrigin(baselineTagNormalized, origin, urlPatterns),
    fetchSessionsByTagForOrigin(currentTagNormalized, origin, urlPatterns)
  ]);

  const percentileModel: PerformanceReportMetadata['percentileModel'] = {
    load: 'P95',
    lcp: 'P95',
    tbt: 'P95',
    cls: 'P75'
  };

  const thresholdsUsed: PerformanceReport['thresholdsUsed'] = {
    load: '≤3s good, ≤6s needs improvement',
    lcp: '≤2.5s good, ≤4s needs improvement',
    cls: '≤0.1 good, ≤0.25 needs improvement',
    tbt: '≤200ms good, ≤600ms needs improvement'
  };

  const metricFromSessions = (sessions: SessionMetrics[], kind: keyof PerformanceReport['metrics']): number[] => {
    if (kind === 'load') {
      return sessions
        .map((s) => toFiniteNumber(s.loadMetrics?.totalLoadTime))
        .filter((v): v is number => v !== null);
    }
    if (kind === 'lcp') {
      return sessions
        .map((s) => toFiniteNumber(s.webVitals?.lcp))
        .filter((v): v is number => v !== null);
    }
    if (kind === 'tbt') {
      return sessions
        .map((s) => toFiniteNumber(s.webVitals?.tbt))
        .filter((v): v is number => v !== null);
    }
    return sessions
      .map((s) => toFiniteNumber(s.webVitals?.cls))
      .filter((v): v is number => v !== null);
  };

  const computeMetric = (kind: keyof PerformanceReport['metrics']): PerformanceReportMetricRow => {
    const baseValues = metricFromSessions(baselineSessions, kind);
    const curValues = metricFromSessions(currentSessions, kind);

    if (baseValues.length === 0 || curValues.length === 0) {
      return {
        baseline: 0,
        current: 0,
        changePercent: 0,
        status: 'neutral'
      };
    }

    const base = kind === 'cls' ? percentile(baseValues, regressionPercentileP75) : percentile(baseValues, regressionPercentileP95);
    const cur = kind === 'cls' ? percentile(curValues, regressionPercentileP75) : percentile(curValues, regressionPercentileP95);
    const change = percentChange(base, cur);
    const status = kind === 'cls' ? classifyCls(change, base, cur) : classifyChange(change);

    return {
      baseline: base,
      current: cur,
      changePercent: change,
      status
    };
  };

  const metrics: PerformanceReport['metrics'] = {
    load: computeMetric('load'),
    lcp: computeMetric('lcp'),
    cls: computeMetric('cls'),
    tbt: computeMetric('tbt')
  };

  return {
    metadata: {
      domain: origin,
      baselineTag: baselineTagNormalized,
      currentTag: currentTagNormalized,
      generatedAt: new Date().toISOString(),
      percentileModel
    },
    sessionCounts: {
      baseline: baselineSessions.length,
      current: currentSessions.length
    },
    metrics,
    thresholdsUsed
  };
}

function reportToHtml(report: PerformanceReport): string {
  const banner = resolveRegressionBanner(report.metrics);
  const time = report.metadata.generatedAt;
  const domain = report.metadata.domain;

  const formatMetricValue = (key: keyof PerformanceReport['metrics'], value: number): string => {
    if (key === 'cls') {
      return value.toFixed(3);
    }
    if (key === 'tbt') {
      return `${Math.round(value)} ms`;
    }
    return formatSecondsForReport(value);
  };

  const metricTableRows = (['load', 'lcp', 'cls', 'tbt'] as const)
    .map((key) => {
      const m = report.metrics[key];
      return `
        <tr>
          <td>${metricRowLabel(key)}</td>
          <td class="num">${formatMetricValue(key, m.baseline)}</td>
          <td class="num">${formatMetricValue(key, m.current)}</td>
          <td class="num">${formatChangeForReport(m.changePercent)}</td>
          <td>${statusLabel(m.status)}</td>
        </tr>
      `.trim();
    })
    .join('\n');

  const bannerClass = banner.state === 'bad' ? 'bad' : banner.state === 'good' ? 'good' : 'neutral';

  const insufficient = report.sessionCounts.baseline < regressionMinSessions || report.sessionCounts.current < regressionMinSessions;
  const insufficientNote = insufficient
    ? `<div class="note">Not enough sessions for statistically strong comparison. Baseline: ${report.sessionCounts.baseline}, Current: ${report.sessionCounts.current}.</div>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Angular Performance Monitor Report</title>
    <style>
      :root {
        --bg: #0b1220;
        --panel: rgba(255,255,255,0.06);
        --border: rgba(255,255,255,0.12);
        --text: rgba(255,255,255,0.92);
        --muted: rgba(255,255,255,0.68);
      }
      html, body { height: 100%; margin: 0; padding: 0; background: radial-gradient(1200px 600px at 10% 10%, #1f2a44 0%, var(--bg) 45%, #050a14 100%); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
      main { padding: 28px; display: flex; flex-direction: column; gap: 16px; }
      .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 16px; }
      h1 { margin: 0; font-size: 22px; font-weight: 700; }
      h2 { margin: 0; font-size: 14px; font-weight: 700; }
      .muted { color: var(--muted); font-size: 12px; }
      .row { display: flex; flex-wrap: wrap; gap: 14px; }
      .kpi { flex: 1; min-width: 220px; border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: rgba(255,255,255,0.04); }
      .kpi .label { font-size: 12px; color: var(--muted); }
      .kpi .value { font-size: 18px; font-weight: 700; margin-top: 6px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 10px 8px; text-align: left; }
      th { color: rgba(255,255,255,0.86); font-size: 12px; letter-spacing: 0.02em; }
      td.num { text-align: right; font-variant-numeric: tabular-nums; }
      .banner { border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; font-size: 13px; font-weight: 700; }
      .banner.good { background: rgba(67, 160, 71, 0.14); }
      .banner.bad { background: rgba(229, 57, 53, 0.14); }
      .banner.neutral { background: rgba(245, 158, 11, 0.14); }
      .note { margin-top: 10px; font-size: 12px; color: var(--muted); }
      footer { margin-top: 10px; font-size: 12px; color: var(--muted); }
      code { color: rgba(255,255,255,0.86); }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>Angular Performance Monitor Report</h1>
        <div class="muted">Domain: <code>${domain}</code></div>
        <div class="muted">Baseline Tag: <code>${report.metadata.baselineTag}</code> | Current Tag: <code>${report.metadata.currentTag}</code></div>
        <div class="muted">Generated at: <code>${time}</code></div>
      </div>

      <div class="panel">
        <div class="banner ${bannerClass}">${banner.text}</div>
        ${insufficientNote}
      </div>

      <div class="panel">
        <h2>KPI Summary (Percentiles)</h2>
        <p class="muted">Load/LCP/TBT use P95; CLS uses P75.</p>
        <div class="row">
          <div class="kpi"><div class="label">Load (P95)</div><div class="value">${formatSecondsForReport(report.metrics.load.current)}</div><div class="muted">Baseline ${formatSecondsForReport(report.metrics.load.baseline)} | ${formatChangeForReport(report.metrics.load.changePercent)} ${statusLabel(report.metrics.load.status)}</div></div>
          <div class="kpi"><div class="label">LCP (P95)</div><div class="value">${formatSecondsForReport(report.metrics.lcp.current)}</div><div class="muted">Baseline ${formatSecondsForReport(report.metrics.lcp.baseline)} | ${formatChangeForReport(report.metrics.lcp.changePercent)} ${statusLabel(report.metrics.lcp.status)}</div></div>
          <div class="kpi"><div class="label">CLS (P75)</div><div class="value">${report.metrics.cls.current.toFixed(3)}</div><div class="muted">Baseline ${report.metrics.cls.baseline.toFixed(3)} | ${formatChangeForReport(report.metrics.cls.changePercent)} ${statusLabel(report.metrics.cls.status)}</div></div>
          <div class="kpi"><div class="label">TBT (P95)</div><div class="value">${Math.round(report.metrics.tbt.current)} ms</div><div class="muted">Baseline ${Math.round(report.metrics.tbt.baseline)} ms | ${formatChangeForReport(report.metrics.tbt.changePercent)} ${statusLabel(report.metrics.tbt.status)}</div></div>
        </div>
      </div>

      <div class="panel">
        <h2>Comparison Table</h2>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th class="num">Baseline</th>
              <th class="num">Current</th>
              <th class="num">Change %</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${metricTableRows}
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Percentile Model</h2>
        <p class="muted">This report uses <code>P95</code> for load/LCP/TBT and <code>P75</code> for CLS to reduce noise and focus on worst-case user experience.</p>
        <p class="muted">Thresholds used:</p>
        <ul class="muted">
          <li>Load: ${report.thresholdsUsed.load}</li>
          <li>LCP: ${report.thresholdsUsed.lcp}</li>
          <li>CLS: ${report.thresholdsUsed.cls}</li>
          <li>TBT: ${report.thresholdsUsed.tbt}</li>
        </ul>
      </div>

      <footer>Generated by Angular Performance Monitor</footer>
    </main>
  </body>
</html>`;
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

function renderComparisonTableInsufficient(): void {
  const table = document.getElementById('comparison-table') as HTMLTableElement | null;
  if (!table) {
    return;
  }

  table.innerHTML = '';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const headers = ['Metric', 'Baseline Value (P95/P75)', 'Current Value', 'Change %', 'Status'];
  for (const header of headers) {
    const th = document.createElement('th');
    th.textContent = header;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  const rows = ['Load (P95)', 'LCP (P95)', 'CLS (P75)', 'TBT (P95)'];
  for (const metricLabel of rows) {
    const tr = document.createElement('tr');

    const metricCell = document.createElement('td');
    metricCell.textContent = metricLabel;

    const baselineCell = document.createElement('td');
    baselineCell.textContent = '-';

    const currentCell = document.createElement('td');
    currentCell.textContent = '-';

    const changeCell = document.createElement('td');
    changeCell.textContent = '-';

    const statusCell = document.createElement('td');
    statusCell.textContent = 'insufficient data';

    tr.append(metricCell, baselineCell, currentCell, changeCell, statusCell);
    tbody.append(tr);
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
    const runtime = getChromeRuntime();
    if (!runtime) {
      return;
    }

    await runtime.sendMessage({ action: 'UPDATE_BADGE_STATUS', payload: { status } });
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
  const runtime = getChromeRuntime();
  if (!runtime) {
    return [baselineTag];
  }
  const response = await runtime.sendMessage({ action: 'GET_ALL_TAGS', payload: { origin: selectedDomain, urlPatterns: selectedUrlPatterns } });
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
  const runtime = getChromeRuntime();
  if (!runtime) {
    return baselineTag;
  }
  const response = await runtime.sendMessage({ action: 'GET_ACTIVE_TAG', payload: { origin: selectedDomain, urlPatterns: selectedUrlPatterns } });
  logDev('GET_ACTIVE_TAG response', response);

  if (!isRecord(response) || response.ok !== true) {
    return baselineTag;
  }

  return normalizeTag(response.tag);
}

async function updateActiveTag(tag: string): Promise<boolean> {
  const normalized = normalizeTag(tag);
  const runtime = getChromeRuntime();
  if (!runtime) {
    return false;
  }
  const response = await runtime.sendMessage({ action: 'SET_ACTIVE_TAG', payload: { tag: normalized, origin: selectedDomain, urlPatterns: selectedUrlPatterns } });
  logDev('SET_ACTIVE_TAG response', response);
  return isRecord(response) && response.ok === true;
}

async function fetchSessionsByTag(tag: string): Promise<SessionMetrics[]> {
  const normalizedTag = normalizeTag(tag);
  const runtime = getChromeRuntime();
  if (!runtime) {
    return [];
  }
  const response = await runtime.sendMessage({ action: 'GET_SESSIONS_BY_TAG', payload: { tag: normalizedTag, origin: selectedDomain, urlPatterns: selectedUrlPatterns } });
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

async function fetchSessionsByTagForOrigin(tag: string, origin: string, urlPatterns: string[]): Promise<SessionMetrics[]> {
  const normalizedTag = normalizeTag(tag);
  const runtime = getChromeRuntime();
  if (!runtime) {
    return [];
  }
  const response = await runtime.sendMessage({ action: 'GET_SESSIONS_BY_TAG', payload: { tag: normalizedTag, origin, urlPatterns } });
  logDev('GET_SESSIONS_BY_TAG (report) response', response);

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

type DashboardTab = 'data' | 'graphs' | 'settings' | 'export';

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
  const exportButton = document.getElementById('tab-btn-export') as HTMLButtonElement | null;
  const dataPanel = document.getElementById('tab-panel-data');
  const graphsPanel = document.getElementById('tab-panel-graphs');
  const settingsPanel = document.getElementById('tab-panel-settings');
  const exportPanel = document.getElementById('tab-panel-export');

  const dataActive = tab === 'data';
  const graphsActive = tab === 'graphs';
  const settingsActive = tab === 'settings';
  const exportActive = tab === 'export';

  dataButton?.classList.toggle('active', dataActive);
  graphsButton?.classList.toggle('active', graphsActive);
  settingsButton?.classList.toggle('active', settingsActive);
  exportButton?.classList.toggle('active', exportActive);
  dataButton?.setAttribute('aria-selected', dataActive ? 'true' : 'false');
  graphsButton?.setAttribute('aria-selected', graphsActive ? 'true' : 'false');
  settingsButton?.setAttribute('aria-selected', settingsActive ? 'true' : 'false');
  exportButton?.setAttribute('aria-selected', exportActive ? 'true' : 'false');

  dataPanel?.classList.toggle('active', dataActive);
  graphsPanel?.classList.toggle('active', graphsActive);
  settingsPanel?.classList.toggle('active', settingsActive);
  exportPanel?.classList.toggle('active', exportActive);
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
          const nextSelected = selectedDomain === scope.origin ? nextScopes[0]?.origin ?? '' : selectedDomain;
          await refreshAfterDomainChange(nextSelected);
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
    el.classList.toggle('empty', message.length > 0);
  }
}

function clearEmpty(elId: string): void {
  setEmpty(elId, '');
}

function setExportEmpty(message: string): void {
  setEmpty('export-empty', message);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function reportToExcelXls(report: PerformanceReport): string {
  const metaRows: Array<[string, string]> = [
    ['Domain', report.metadata.domain],
    ['Baseline Tag', report.metadata.baselineTag],
    ['Current Tag', report.metadata.currentTag],
    ['Generated At', report.metadata.generatedAt],
    ['Baseline Sessions', String(report.sessionCounts.baseline)],
    ['Current Sessions', String(report.sessionCounts.current)]
  ];

  const metaTable = metaRows
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  const metricTable = [
    '<tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Change %</th><th>Status</th></tr>',
    `<tr><td>Total Load Time</td><td>${report.metrics.load.baseline.toFixed(0)}</td><td>${report.metrics.load.current.toFixed(0)}</td><td>${report.metrics.load.changePercent.toFixed(2)}</td><td>${escapeHtml(report.metrics.load.status)}</td></tr>`,
    `<tr><td>LCP</td><td>${report.metrics.lcp.baseline.toFixed(0)}</td><td>${report.metrics.lcp.current.toFixed(0)}</td><td>${report.metrics.lcp.changePercent.toFixed(2)}</td><td>${escapeHtml(report.metrics.lcp.status)}</td></tr>`,
    `<tr><td>CLS</td><td>${report.metrics.cls.baseline.toFixed(3)}</td><td>${report.metrics.cls.current.toFixed(3)}</td><td>${report.metrics.cls.changePercent.toFixed(2)}</td><td>${escapeHtml(report.metrics.cls.status)}</td></tr>`,
    `<tr><td>TBT</td><td>${report.metrics.tbt.baseline.toFixed(0)}</td><td>${report.metrics.tbt.current.toFixed(0)}</td><td>${report.metrics.tbt.changePercent.toFixed(2)}</td><td>${escapeHtml(report.metrics.tbt.status)}</td></tr>`
  ].join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: Arial, sans-serif; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    td, th { border: 1px solid #ccc; padding: 8px; text-align: left; }
    th { background: #f2f2f2; }
  </style>
</head>
<body>
  <h2>Performance Report</h2>
  <table>${metaTable}</table>
  <h3>Metrics</h3>
  <table>${metricTable}</table>
</body>
</html>`;
}

async function exportPerformanceReport(format: 'html' | 'excel'): Promise<void> {
  setExportEmpty('');

  const origin = selectedDomain;
  const baseline = compareTagA;
  const current = compareTagB;

  if (!origin) {
    setExportEmpty('Select a domain first.');
    return;
  }

  if (!baseline || !current || baseline === current) {
    setExportEmpty('Select two different comparison tags (Tag A vs Tag B) first.');
    return;
  }

  try {
    const report = await buildPerformanceReport(origin, baseline, current);
    const timeIso = report.metadata.generatedAt;
    const timePart = sanitizeFilenamePart(timeIso.replace(/[:.]/g, '-'));
    const domainPart = sanitizeFilenamePart(origin);
    const baseName = `performance-report-${domainPart}-${timePart}`;

    if (format === 'html') {
      const htmlBlob = new Blob([reportToHtml(report)], { type: 'text/html' });
      downloadBlob(htmlBlob, `${baseName}.html`);
      return;
    }

    const xlsBlob = new Blob([reportToExcelXls(report)], { type: 'application/vnd.ms-excel' });
    downloadBlob(xlsBlob, `${baseName}.xls`);
  } catch {
    setExportEmpty('Unable to export report.');
  }
}

async function exportAllData(): Promise<void> {
  setExportEmpty('');

  const runtime = getChromeRuntime();
  if (!runtime) {
    setExportEmpty('Unable to access extension runtime.');
    return;
  }

  try {
    const response = await runtime.sendMessage({ action: 'GET_ALL_SESSIONS' });
    if (!isRecord(response) || response.ok !== true) {
      setExportEmpty('Unable to download data.');
      return;
    }

    const sessions = (response as Record<string, unknown>).sessions;
    if (!Array.isArray(sessions)) {
      setExportEmpty('Unable to download data.');
      return;
    }

    const timePart = sanitizeFilenamePart(new Date().toISOString().replace(/[:.]/g, '-'));
    const normalizedSessions = sessions as unknown as SessionMetrics[];
    const xlsBlob = new Blob([allSessionsToExcelXls(normalizedSessions)], { type: 'application/vnd.ms-excel' });
    downloadBlob(xlsBlob, `performance-monitor-all-domains-${timePart}.xls`);
  } catch {
    setExportEmpty('Unable to download data.');
  }
}

function allSessionsToExcelXls(sessions: SessionMetrics[]): string {
  const exportedAt = new Date().toISOString();

  const safeNumber = (value: unknown): string => {
    if (typeof value !== 'number') {
      return '';
    }
    if (!Number.isFinite(value)) {
      return '';
    }
    return String(value);
  };

  const safeText = (value: unknown): string => {
    if (typeof value !== 'string') {
      return '';
    }
    return value;
  };

  const rows = sessions
    .map((s) => {
      const origin = safeText((s as unknown as Record<string, unknown>).origin ?? ((): unknown => {
        try {
          return new URL(safeText(s.url)).origin;
        } catch {
          return '';
        }
      })());
      const ts = typeof s.timestamp === 'number' && Number.isFinite(s.timestamp) ? s.timestamp : null;
      const isoTime = ts ? new Date(ts).toISOString() : '';

      return {
        origin,
        url: safeText(s.url),
        versionTag: safeText(s.versionTag),
        timestampMs: ts ? String(ts) : '',
        timestampIso: isoTime,
        loadTotalMs: safeNumber(s.loadMetrics?.totalLoadTime),
        loadDclMs: safeNumber(s.loadMetrics?.domContentLoaded),
        fcpMs: safeNumber(s.webVitals?.fcp),
        lcpMs: safeNumber(s.webVitals?.lcp),
        cls: safeNumber(s.webVitals?.cls),
        tbtMs: safeNumber(s.webVitals?.tbt)
      };
    })
    .sort((a, b) => {
      const at = Number(a.timestampMs);
      const bt = Number(b.timestampMs);
      if (!Number.isFinite(at) && !Number.isFinite(bt)) {
        return 0;
      }
      if (!Number.isFinite(at)) {
        return 1;
      }
      if (!Number.isFinite(bt)) {
        return -1;
      }
      return bt - at;
    });

  const header = [
    'Origin',
    'URL',
    'Version Tag',
    'Timestamp (ms)',
    'Timestamp (ISO)',
    'Load Total (ms)',
    'DOM Content Loaded (ms)',
    'FCP (ms)',
    'LCP (ms)',
    'CLS',
    'TBT (ms)'
  ];

  const tableRows = rows
    .map((r) => {
      const cells = [
        r.origin,
        r.url,
        r.versionTag,
        r.timestampMs,
        r.timestampIso,
        r.loadTotalMs,
        r.loadDclMs,
        r.fcpMs,
        r.lcpMs,
        r.cls,
        r.tbtMs
      ];

      return `<tr>${cells.map((c) => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`;
    })
    .join('');

  const headerRow = `<tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Performance Monitor - All Sessions</title>
    <style>
      body { font-family: Arial, sans-serif; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #d1d5db; padding: 6px 8px; font-size: 12px; }
      th { background: #f3f4f6; text-align: left; }
      .meta { margin-bottom: 12px; font-size: 12px; color: #374151; }
    </style>
  </head>
  <body>
    <div class="meta">Exported at: ${escapeHtml(exportedAt)} | Sessions: ${escapeHtml(String(rows.length))}</div>
    <table>
      <thead>${headerRow}</thead>
      <tbody>${tableRows}</tbody>
    </table>
  </body>
</html>`;
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
    setEmpty(params.emptyId, 'Not enough data to display trend');
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
    setEmpty('overview-empty', 'Not enough data to display trend');
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

function renderTagSelectWithCounts(selectId: string, selected: string, counts: Map<string, number>): void {
  const select = document.getElementById(selectId) as HTMLSelectElement | null;
  if (!select) {
    return;
  }

  select.innerHTML = '';
  for (const tag of availableTags) {
    const option = document.createElement('option');
    option.value = tag;
    const count = counts.get(tag) ?? 0;
    option.textContent = `${tag} (${count})`;
    select.append(option);
  }

  select.value = selected;
}

async function fetchSessionCountsForTags(tags: string[]): Promise<Map<string, number>> {
  const entries = await Promise.all(
    tags.map(async (tag): Promise<TagSessionCount> => {
      const sessions = await fetchSessionsByTag(tag);
      return { tag, count: sessions.length };
    })
  );

  const map = new Map<string, number>();
  for (const entry of entries) {
    map.set(entry.tag, entry.count);
  }
  return map;
}

function clearComparisonDeltas(): void {
  const root = document.getElementById('comparison-deltas') as HTMLElement | null;
  if (root) {
    root.innerHTML = '';
  }
}

function arrowForStatus(status: RegressionMetric['status']): string {
  if (status === 'improved') return '↓';
  if (status === 'regressed') return '↑';
  return '→';
}

function labelForChange(change: number): string {
  const abs = Math.abs(change);
  const formatted = `${abs.toFixed(0)}%`;
  if (change < 0) {
    return `${arrowForStatus('improved')} ${formatted} Improvement`;
  }
  if (change > 0) {
    return `${arrowForStatus('regressed')} ${formatted} Regression`;
  }
  return `${arrowForStatus('neutral')} 0% Neutral`;
}

function renderComparisonDeltas(metrics: Record<string, RegressionMetric>): void {
  const root = document.getElementById('comparison-deltas') as HTMLElement | null;
  if (!root) {
    return;
  }

  const rows: Array<{ key: 'load' | 'lcp' | 'cls' | 'tbt'; label: string; badge: string }> = [
    { key: 'load', label: 'Load', badge: 'P95 Model' },
    { key: 'lcp', label: 'LCP', badge: 'P95 Model' },
    { key: 'cls', label: 'CLS', badge: 'P75 Model (CLS)' },
    { key: 'tbt', label: 'TBT', badge: 'P95 Model' }
  ];

  root.innerHTML = '';
  for (const row of rows) {
    const metric = metrics[row.key];
    const status = metric?.status ?? 'neutral';
    const card = document.createElement('div');
    card.className = `delta-card ${status === 'improved' ? 'good' : status === 'regressed' ? 'poor' : 'needs'}`;

    const top = document.createElement('div');
    top.className = 'delta-top';

    const title = document.createElement('div');
    title.className = 'delta-metric';
    title.textContent = row.label;

    const badge = document.createElement('div');
    badge.className = 'delta-badge';
    badge.textContent = row.badge;

    top.append(title, badge);

    const change = document.createElement('div');
    change.className = 'delta-change';
    change.textContent = labelForChange(metric?.changePercent ?? 0);

    card.append(top, change);
    root.append(card);
  }
}

async function refreshDashboard(): Promise<void> {
  try {
    setGraphsLoading(true);
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
    renderKpiSummaryRow(sessions);

    const counts = await fetchSessionCountsForTags(availableTags);
    renderTagSelectWithCounts('active-tag', activeTag, counts);
    renderTagSelectWithCounts('compare-tag-a', compareTagA, counts);
    renderTagSelectWithCounts('compare-tag-b', compareTagB, counts);

    const baselineSessions = counts.get(compareTagA) ?? 0;
    const currentSessions = counts.get(compareTagB) ?? 0;
    renderMetadataStrip({
      domain: selectedDomain,
      baselineTag: compareTagA,
      currentTag: compareTagB,
      baselineSessions,
      currentSessions,
      lastUpdated: Date.now()
    });
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
  } finally {
    setGraphsLoading(false);
  }
}

async function runComparison(): Promise<void> {
  try {
    setGraphsLoading(true);
    const [sessionsA, sessionsB] = await Promise.all([fetchSessionsByTag(compareTagA), fetchSessionsByTag(compareTagB)]);

    if (sessionsA.length === 0 || sessionsB.length === 0) {
      setEmpty(
        'compare-empty',
        `Need at least ${regressionMinSessions} sessions per tag. Tag A: ${sessionsA.length}, Tag B: ${sessionsB.length}.`
      );
      compareChart?.destroy();
      compareChart = null;
      renderComparisonTableInsufficient();
      renderComparisonDeltasInsufficient();

      setRegressionBanner('neutral');
      setRegressionEmpty(
        `Need at least ${regressionMinSessions} sessions per tag for regression analysis. Baseline: ${sessionsA.length}, Current: ${sessionsB.length}.`
      );
      await sendBadgeStatus('neutral');
      return;
    }

    if (sessionsA.length < regressionMinSessions || sessionsB.length < regressionMinSessions) {
      setRegressionBanner('neutral');
      setEmpty(
        'compare-empty',
        `Need at least ${regressionMinSessions} sessions per tag. Tag A: ${sessionsA.length}, Tag B: ${sessionsB.length}.`
      );
      setRegressionEmpty(
        `Need at least ${regressionMinSessions} sessions per tag for regression analysis. Baseline: ${sessionsA.length}, Current: ${sessionsB.length}.`
      );
      renderComparisonTableInsufficient();
      renderComparisonDeltasInsufficient();
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
      renderComparisonDeltas(regressionMetrics);

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
    clearComparisonDeltas();
    await sendBadgeStatus('neutral');
  } finally {
    setGraphsLoading(false);
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

  const tabExport = document.getElementById('tab-btn-export') as HTMLButtonElement | null;
  tabExport?.addEventListener('click', () => {
    setActiveTab('export');
  });

  const exportHtml = document.getElementById('export-report-html') as HTMLButtonElement | null;
  exportHtml?.addEventListener('click', () => {
    void exportPerformanceReport('html');
  });

  const exportExcel = document.getElementById('export-report-excel') as HTMLButtonElement | null;
  exportExcel?.addEventListener('click', () => {
    void exportPerformanceReport('excel');
  });

  const exportAll = document.getElementById('export-all-data') as HTMLButtonElement | null;
  exportAll?.addEventListener('click', () => {
    void exportAllData();
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

      const settingsRoot = document.getElementById('domain-settings-root') as HTMLElement | null;
      if (settingsRoot) {
        const refreshSettings = (): void => {
          void (async (): Promise<void> => {
            allowedScopes = await fetchAllowedScopes();
            renderDomainSettings(settingsRoot, allowedScopes, refreshSettings);
          })();
        };
        renderDomainSettings(settingsRoot, allowedScopes, refreshSettings);
      }

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

  const deleteButton = document.getElementById('delete-version') as HTMLButtonElement | null;
  deleteButton?.addEventListener('click', () => {
    if (activeTag === baselineTag) {
      return;
    }

    const origin = selectedDomain;
    void (async (): Promise<void> => {
      const confirmed = window.confirm(`Delete version '${activeTag}' for this domain?`);
      if (!confirmed) {
        return;
      }

      const alsoDelete = await showConfirm({
        title: 'Delete Sessions',
        message: 'Delete sessions too? If you cancel, sessions are kept and reassigned to baseline.',
        confirmText: 'Delete Sessions',
        cancelText: 'Keep Sessions'
      });

      const runtime = getChromeRuntime();
      if (!runtime) {
        return;
      }

      const res = await runtime.sendMessage({ action: 'DELETE_VERSION', payload: { origin, tag: activeTag, deleteSessions: alsoDelete } });
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
      const origin = selectedDomain;
      const confirmed = window.confirm(`Delete domain ${origin} and all its data?`);
      if (!confirmed) {
        return;
      }

      const runtime = getChromeRuntime();
      if (!runtime) {
        return;
      }

      const res = await runtime.sendMessage({ action: 'DELETE_DOMAIN', payload: { origin } });
      if (!isRecord(res) || res.ok !== true) {
        return;
      }

      allowedScopes = await fetchAllowedScopes();
      const settingsRoot = document.getElementById('domain-settings-root') as HTMLElement | null;
      if (settingsRoot) {
        const refreshSettings = (): void => {
          void (async (): Promise<void> => {
            allowedScopes = await fetchAllowedScopes();
            renderDomainSettings(settingsRoot, allowedScopes, refreshSettings);
          })();
        };
        renderDomainSettings(settingsRoot, allowedScopes, refreshSettings);
      }

      const remaining = allowedScopes.map((s) => s.origin);
      const nextSelected = remaining[0] ?? '';
      await refreshAfterDomainChange(nextSelected);
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
  setActiveTab('data');

  const runtime = getChromeRuntime();
  runtime?.onMessage?.addListener((message: unknown) => {
    const action = isRecord(message) ? message.action : null;
    void (async (): Promise<void> => {
      if (action === 'TAGS_UPDATED') {
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
    const settingsRoot = document.getElementById('domain-settings-root') as HTMLElement | null;

    const renderDomainSelector = (domains: string[], selected: string): void => {
      if (!domainSelect) {
        return;
      }
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
    };

    const initial = allowed[0] ?? '';
    if (!initial) {
      setEmpty('overview-empty', 'No allowed domains configured yet. Add a domain first.');
      setSessionsEmpty('No allowed domains configured yet. Add a domain first.');
      return;
    }
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
