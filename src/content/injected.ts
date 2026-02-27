(() => {
  type ExtensionMode = 'dev' | 'silent';
  type NavigationType = 'hard' | 'spa';

  interface ApiMetric {
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

  interface SessionMetricsPayload {
    id: string;
    timestamp: number;
    versionTag: string;
    url: string;
    route: string;
    navigationType: NavigationType;
    loadMetrics: LoadMetrics;
    webVitals: WebVitals;
    memoryMetrics: MemoryMetrics | null;
    resourceMetrics: ResourceMetric[];
    apiMetrics: ApiMetric[];
  }

  interface PerfMonitorConfigPayload {
    samplingRate: number;
    extensionMode: ExtensionMode;
    versionTag: string;
    apiTrackingEnabled: boolean;
    redactQueryParams: boolean;
    privacyMode: boolean;
  }

  interface PerfMonitorMessage<TType extends string, TPayload> {
    type: TType;
    payload: TPayload;
  }

  const injectedGuardKey = '__perfMonitorInjected';
  const patchGuardKey = '__perfMonitorPatched';
  const lcpFinalizeGuardKey = '__perfLcpFinalizeListenersAdded';

  const apiBatchMaxSize = 20;
  const apiBatchFlushIntervalMs = 5000;

  const win = window as unknown as Record<string, unknown>;
  if (win[injectedGuardKey] === true) {
    return;
  }
  win[injectedGuardKey] = true;

  try {
    window.postMessage({ type: 'PERF_MONITOR_INJECTED_READY' }, '*');
  } catch {
    // ignore
  }

  let config: PerfMonitorConfigPayload | null = null;
  let configReceived = false;

  let sampledIn = false;

  let sessionId = crypto.randomUUID();
  let navigationType: NavigationType = 'hard';

  let fcpValue = 0;
  let lcpValue = 0;
  let clsValue = 0;
  let tbtValue = 0;

  let lcpFinalized = false;

  let resourceMetrics: ResourceMetric[] = [];
  let loadMetrics: LoadMetrics = {
    domContentLoaded: 0,
    loadEventEnd: 0,
    totalLoadTime: 0
  };

  let memoryMetrics: MemoryMetrics | null = null;

  let apiMetrics: ApiMetric[] = [];
  let apiQueue: ApiMetric[] = [];
  let apiBatchTimerId: ReturnType<typeof globalThis.setTimeout> | null = null;

  let fcpTimestamp = 0;
  let tbtStopTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let lcpFallbackTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

  let finalized = false;

  let paintObserver: PerformanceObserver | null = null;
  let lcpObserver: PerformanceObserver | null = null;
  let clsObserver: PerformanceObserver | null = null;
  let longTaskObserver: PerformanceObserver | null = null;

  let spaListenerRegistered = false;

  function logDev(message: string): void {
    if (config?.extensionMode !== 'dev') {
      return;
    }

    console.log(`[PerfMonitor][injected] ${message}`);
  }

  function safeDisconnect(observer: PerformanceObserver | null): void {
    try {
      observer?.disconnect();
    } catch {
      // ignore
    }
  }

  function clearTimers(): void {
    if (tbtStopTimeoutId !== null) {
      globalThis.clearTimeout(tbtStopTimeoutId);
      tbtStopTimeoutId = null;
    }

    if (lcpFallbackTimeoutId !== null) {
      globalThis.clearTimeout(lcpFallbackTimeoutId);
      lcpFallbackTimeoutId = null;
    }

    if (apiBatchTimerId !== null) {
      globalThis.clearTimeout(apiBatchTimerId);
      apiBatchTimerId = null;
    }
  }

  function resetSessionState(nextNavigationType: NavigationType): void {
    finalized = false;
    sessionId = crypto.randomUUID();
    navigationType = nextNavigationType;

    sampledIn = false;

    fcpValue = 0;
    lcpValue = 0;
    clsValue = 0;
    tbtValue = 0;
    fcpTimestamp = 0;

    lcpFinalized = false;

    resourceMetrics = [];
    loadMetrics = {
      domContentLoaded: 0,
      loadEventEnd: 0,
      totalLoadTime: 0
    };
    memoryMetrics = null;

    apiMetrics = [];
    apiQueue = [];

    clearTimers();

    safeDisconnect(paintObserver);
    safeDisconnect(lcpObserver);
    safeDisconnect(clsObserver);
    safeDisconnect(longTaskObserver);

    paintObserver = null;
    lcpObserver = null;
    clsObserver = null;
    longTaskObserver = null;

    try {
      performance.clearResourceTimings();
    } catch {
      // ignore
    }
  }

  function finalizeLcp(): void {
    if (lcpFinalized) {
      return;
    }
    lcpFinalized = true;

    safeDisconnect(lcpObserver);
    lcpObserver = null;

    logDev(`LCP finalized: ${Math.round(lcpValue)}ms`);
  }

  function ensureGlobalLcpFinalizeListeners(): void {
    const guard = win[lcpFinalizeGuardKey];
    if (guard === true) {
      return;
    }

    win[lcpFinalizeGuardKey] = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        finalizeLcp();
      }
    });

    window.addEventListener('beforeunload', () => {
      finalizeLcp();
    });

    window.addEventListener(
      'load',
      () => {
        lcpFallbackTimeoutId = globalThis.setTimeout(() => {
          finalizeLcp();
        }, 3000);
      },
      { once: true }
    );
  }

  function supportsCryptoDigest(): boolean {
    return typeof crypto?.subtle?.digest === 'function';
  }

  async function sha256Hex(value: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = Array.from(new Uint8Array(digest));
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function stripQueryParams(rawUrl: string): string {
    const queryIndex = rawUrl.indexOf('?');
    if (queryIndex < 0) {
      return rawUrl;
    }
    return rawUrl.slice(0, queryIndex);
  }

  async function buildApiUrl(rawUrl: string): Promise<string> {
    try {
      const redactQueryParams = config?.redactQueryParams === true;
      const privacyMode = config?.privacyMode === true;
      const normalizedUrl = redactQueryParams ? stripQueryParams(rawUrl) : rawUrl;

      if (!privacyMode) {
        return normalizedUrl;
      }

      if (!supportsCryptoDigest()) {
        return 'sha256:unsupported';
      }

      const hashed = await sha256Hex(normalizedUrl);
      return `sha256:${hashed}`;
    } catch {
      return 'sha256:error';
    }
  }

  function shouldTrackApi(): boolean {
    if (!config) {
      return false;
    }

    if (config.apiTrackingEnabled !== true) {
      return false;
    }

    return sampledIn;
  }

  function clearApiBatchTimer(): void {
    if (apiBatchTimerId === null) {
      return;
    }
    globalThis.clearTimeout(apiBatchTimerId);
    apiBatchTimerId = null;
  }

  function flushApiQueue(): void {
    try {
      if (apiQueue.length === 0) {
        clearApiBatchTimer();
        return;
      }

      window.postMessage({ type: 'PERF_MONITOR_API_BATCH', payload: { sessionId, apiMetrics: apiQueue } }, '*');
      apiQueue = [];
      clearApiBatchTimer();
    } catch {
      apiQueue = [];
      clearApiBatchTimer();
    }
  }

  function queueApiMetric(metric: ApiMetric): void {
    try {
      apiMetrics.push(metric);
      apiQueue.push(metric);

      if (apiQueue.length >= apiBatchMaxSize) {
        flushApiQueue();
        return;
      }

      if (apiBatchTimerId === null) {
        apiBatchTimerId = globalThis.setTimeout(() => {
          flushApiQueue();
        }, apiBatchFlushIntervalMs);
      }
    } catch {
      // ignore
    }
  }

  function getFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
    if (init?.method) {
      return String(init.method).toUpperCase();
    }

    if (typeof input === 'string') {
      return 'GET';
    }

    if (input instanceof URL) {
      return 'GET';
    }

    try {
      const req = input as Request;
      if (typeof req.method === 'string') {
        return req.method.toUpperCase();
      }
    } catch {
      // ignore
    }

    return 'GET';
  }

  function getFetchUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') {
      return input;
    }

    if (input instanceof URL) {
      return input.toString();
    }

    try {
      const req = input as Request;
      if (typeof req.url === 'string') {
        return req.url;
      }
    } catch {
      // ignore
    }

    return '';
  }

  function shouldSkipSizeCalculation(response: Response): boolean {
    if (response.type === 'opaque') {
      return true;
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > 0) {
      return true;
    }

    return false;
  }

  async function estimateFetchPayloadSize(response: Response): Promise<number> {
    try {
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const parsed = Number(contentLength);
        if (Number.isFinite(parsed) && parsed >= 0) {
          return parsed;
        }
      }

      if (shouldSkipSizeCalculation(response)) {
        return 0;
      }

      const cloned = response.clone();
      const blob = await cloned.blob();
      return blob.size;
    } catch {
      return 0;
    }
  }

  function isResponseCached(response: Response, payloadSize: number): boolean {
    try {
      const xCache = response.headers.get('x-cache');
      if (xCache && xCache.toUpperCase() === 'HIT') {
        return true;
      }

      if (response.type === 'opaque') {
        return true;
      }

      return payloadSize === 0;
    } catch {
      return payloadSize === 0;
    }
  }

  function ensureApiInterceptorsPatched(): void {
    const patchState = (() => {
      const existing = win[patchGuardKey];
      if (!existing) {
        return { spa: false, api: false };
      }
      if (typeof existing === 'object') {
        const state = existing as { spa?: boolean; api?: boolean };
        return { spa: state.spa === true, api: state.api === true };
      }
      if (existing === true) {
        return { spa: true, api: true };
      }
      return { spa: false, api: false };
    })();

    if (patchState.api) {
      return;
    }

    patchState.api = true;
    win[patchGuardKey] = patchState;

    try {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args: Parameters<typeof originalFetch>): Promise<Response> => {
        if (!shouldTrackApi()) {
          return originalFetch(...args);
        }

        const start = performance.now();
        const startTimeUnix = Date.now();

        const method = getFetchMethod(args[0], args[1]);
        const rawUrl = getFetchUrl(args[0]);
        const requestId = `${method}:${rawUrl}:${startTimeUnix}`;

        try {
          const response = await originalFetch(...args);
          const end = performance.now();
          const duration = end - start;

          const url = await buildApiUrl(rawUrl);
          const payloadSize = await estimateFetchPayloadSize(response);

          const metric: ApiMetric = {
            requestId,
            url,
            method,
            status: response.status,
            duration,
            payloadSize,
            startTime: startTimeUnix,
            failed: false,
            cached: isResponseCached(response, payloadSize)
          };

          queueApiMetric(metric);
          return response;
        } catch (error) {
          const end = performance.now();
          const url = await buildApiUrl(rawUrl);
          const metric: ApiMetric = {
            requestId,
            url,
            method,
            status: 0,
            duration: end - start,
            payloadSize: 0,
            startTime: startTimeUnix,
            failed: true,
            cached: false
          };

          queueApiMetric(metric);
          throw error;
        }
      };
    } catch {
      // ignore
    }

    try {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null
      ): void {
        try {
          const record = this as unknown as Record<string, unknown>;
          record.__perfMethod = String(method).toUpperCase();
          record.__perfUrl = typeof url === 'string' ? url : url.toString();
        } catch {
          // ignore
        }

        originalOpen.call(this, method, url as unknown as string, async ?? true, username ?? null, password ?? null);
      };

      XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
        if (!shouldTrackApi()) {
          originalSend.call(this, body ?? null);
          return;
        }

        const start = performance.now();
        const startTimeUnix = Date.now();

        const record = this as unknown as Record<string, unknown>;
        const method = typeof record.__perfMethod === 'string' ? (record.__perfMethod as string) : 'GET';
        const rawUrl = typeof record.__perfUrl === 'string' ? (record.__perfUrl as string) : '';
        const requestId = `${method}:${rawUrl}:${startTimeUnix}`;

        const onLoadEnd = (): void => {
          try {
            this.removeEventListener('loadend', onLoadEnd);
          } catch {
            // ignore
          }

          const end = performance.now();
          const duration = end - start;
          const status = (() => {
            try {
              return Number.isFinite(this.status) ? this.status : 0;
            } catch {
              return 0;
            }
          })();

          const failed = status === 0;

          const payloadSize = (() => {
            try {
              const headerLength = this.getResponseHeader('content-length');
              if (headerLength) {
                const parsed = Number(headerLength);
                if (Number.isFinite(parsed) && parsed >= 0) {
                  return parsed;
                }
              }

              const responseText = this.responseText;
              if (typeof responseText === 'string') {
                return responseText.length;
              }
            } catch {
              // ignore
            }
            return 0;
          })();

          void (async (): Promise<void> => {
            const url = await buildApiUrl(rawUrl);
            const cached = payloadSize === 0;
            const metric: ApiMetric = {
              requestId,
              url,
              method,
              status,
              duration,
              payloadSize,
              startTime: startTimeUnix,
              failed,
              cached
            };

            queueApiMetric(metric);
          })();
        };

        try {
          this.addEventListener('loadend', onLoadEnd, { passive: true });
        } catch {
          // ignore
        }

        originalSend.call(this, body ?? null);
      };
    } catch {
      // ignore
    }
  }

  function getCurrentRoute(): string {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function readNavigationTiming(): void {
    try {
      const navEntries = performance.getEntriesByType('navigation');
      const navEntry = navEntries.length > 0 ? (navEntries[0] as PerformanceNavigationTiming) : null;
      if (!navEntry) {
        return;
      }

      const startTime = navEntry.startTime;
      loadMetrics = {
        domContentLoaded: navEntry.domContentLoadedEventEnd - startTime,
        loadEventEnd: navEntry.loadEventEnd - startTime,
        totalLoadTime: navEntry.loadEventEnd - startTime
      };
    } catch {
      // ignore
    }
  }

  function readMemoryMetrics(): void {
    try {
      const perf = performance as unknown as { memory?: MemoryMetrics };
      if (!perf.memory) {
        memoryMetrics = null;
        return;
      }

      memoryMetrics = {
        usedJSHeapSize: perf.memory.usedJSHeapSize,
        totalJSHeapSize: perf.memory.totalJSHeapSize,
        jsHeapSizeLimit: perf.memory.jsHeapSizeLimit
      };
    } catch {
      memoryMetrics = null;
    }
  }

  function takeResourceSnapshotAfterLoad(): void {
    const snapshot = (): void => {
      try {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const allowedInitiatorTypes = new Set<string>(['script', 'link', 'img', 'css']);

        resourceMetrics = entries
          .filter((e) => allowedInitiatorTypes.has(e.initiatorType))
          .map((e) => ({
            name: e.name,
            initiatorType: e.initiatorType,
            transferSize: e.transferSize,
            duration: e.duration,
            decodedBodySize: e.decodedBodySize
          }));
      } catch {
        resourceMetrics = [];
      }
    };

    if (document.readyState === 'complete') {
      globalThis.setTimeout(snapshot, 2000);
      return;
    }

    window.addEventListener(
      'load',
      () => {
        globalThis.setTimeout(snapshot, 2000);
      },
      { once: true }
    );
  }

  function schedulePostMessage(payload: SessionMetricsPayload): void {
    const msg: PerfMonitorMessage<'PERF_MONITOR_SESSION_COMPLETE', SessionMetricsPayload> = {
      type: 'PERF_MONITOR_SESSION_COMPLETE',
      payload
    };

    const send = (): void => {
      window.postMessage(msg, '*');
    };

    const requestIdleCallbackFn = (globalThis as unknown as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;

    if (requestIdleCallbackFn) {
      requestIdleCallbackFn(send);
      return;
    }

    globalThis.setTimeout(send, 0);
  }

  function finalizeSession(reason: string): void {
    if (finalized) {
      return;
    }
    finalized = true;

    clearTimers();

    safeDisconnect(paintObserver);
    safeDisconnect(lcpObserver);
    safeDisconnect(clsObserver);
    safeDisconnect(longTaskObserver);

    paintObserver = null;
    lcpObserver = null;
    clsObserver = null;
    longTaskObserver = null;

    readNavigationTiming();
    readMemoryMetrics();

    flushApiQueue();

    const versionTag = config?.versionTag ?? '';

    const payload: SessionMetricsPayload = {
      id: sessionId,
      timestamp: Date.now(),
      versionTag,
      url: location.href,
      route: getCurrentRoute(),
      navigationType,
      loadMetrics,
      webVitals: {
        fcp: fcpValue,
        lcp: lcpValue,
        cls: clsValue,
        tbt: tbtValue
      },
      memoryMetrics,
      resourceMetrics,
      apiMetrics
    };

    logDev(`Session finalized (${reason}) id=${sessionId} type=${navigationType}`);
    schedulePostMessage(payload);
  }

  function setupFcpObserver(): void {
    try {
      paintObserver = new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        for (const entry of entries) {
          if (entry.name === 'first-contentful-paint') {
            fcpValue = entry.startTime;
            fcpTimestamp = entry.startTime;
            safeDisconnect(paintObserver);
            paintObserver = null;
            logDev(`FCP captured: ${Math.round(fcpValue)}ms`);

            if (longTaskObserver) {
              tbtStopTimeoutId = globalThis.setTimeout(() => {
                safeDisconnect(longTaskObserver);
                longTaskObserver = null;
                logDev('TBT observation window ended');
              }, 5000);
            }

            return;
          }
        }
      });

      paintObserver.observe({ type: 'paint', buffered: true });
    } catch {
      paintObserver = null;
    }
  }

  function setupLcpObserver(): void {
    try {
      lcpObserver = new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        if (entries.length === 0) {
          return;
        }

        const lastEntry = entries[entries.length - 1];
        lcpValue = lastEntry.startTime;
      });

      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      lcpObserver = null;
    }
  }

  function setupClsObserver(): void {
    try {
      clsObserver = new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>;
        for (const entry of entries) {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        }
      });

      clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch {
      clsObserver = null;
    }
  }

  function setupTbtObserver(): void {
    try {
      longTaskObserver = new PerformanceObserver((entryList) => {
        if (fcpTimestamp <= 0) {
          return;
        }

        const entries = entryList.getEntries();
        const windowEnd = fcpTimestamp + 5000;

        for (const entry of entries) {
          const taskStart = entry.startTime;
          const taskEnd = taskStart + entry.duration;

          if (taskStart >= windowEnd || taskEnd <= fcpTimestamp) {
            continue;
          }

          const blocking = entry.duration - 50;
          if (blocking > 0) {
            tbtValue += blocking;
          }
        }
      });

      longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {
      longTaskObserver = null;
    }
  }

  function startCapture(): void {
    if (!config) {
      return;
    }

    if (Math.random() > config.samplingRate) {
      logDev('Sampling: session skipped');
      sampledIn = false;
      return;
    }

    sampledIn = true;

    logDev(`Capture started id=${sessionId} type=${navigationType}`);

    readNavigationTiming();
    takeResourceSnapshotAfterLoad();

    setupFcpObserver();
    setupLcpObserver();
    setupClsObserver();
    setupTbtObserver();

    ensureApiInterceptorsPatched();

    if (!spaListenerRegistered) {
      spaListenerRegistered = true;
      window.addEventListener(
        'perf-spa-navigation',
        () => {
          finalizeSession('spa-navigation');
          resetSessionState('spa');
          startCapture();
        },
        { passive: true }
      );
    }

    window.addEventListener(
      'beforeunload',
      () => {
        flushApiQueue();
        finalizeSession('beforeunload');
      },
      { once: true }
    );

    window.addEventListener(
      'load',
      () => {
        globalThis.setTimeout(() => {
          finalizeSession('load+3s');
        }, 3000);
      },
      { once: true }
    );

    if (document.readyState === 'complete') {
      globalThis.setTimeout(() => {
        finalizeSession('injected-after-load+3s');
      }, 3000);
    }
  }

  function patchSpaNavigationDispatch(): void {
    const patchState = (() => {
      const existing = win[patchGuardKey];
      if (!existing) {
        return { spa: false, api: false };
      }
      if (typeof existing === 'object') {
        const state = existing as { spa?: boolean; api?: boolean };
        return { spa: state.spa === true, api: state.api === true };
      }
      if (existing === true) {
        return { spa: true, api: true };
      }
      return { spa: false, api: false };
    })();

    if (patchState.spa) {
      return;
    }

    patchState.spa = true;
    win[patchGuardKey] = patchState;

    try {
      const originalPushState = history.pushState.bind(history);
      const originalReplaceState = history.replaceState.bind(history);

      const dispatch = (): void => {
        window.dispatchEvent(new Event('perf-spa-navigation'));
      };

      history.pushState = (...args: Parameters<History['pushState']>) => {
        originalPushState(...args);
        dispatch();
      };

      history.replaceState = (...args: Parameters<History['replaceState']>) => {
        originalReplaceState(...args);
        dispatch();
      };

      window.addEventListener('popstate', dispatch, { passive: true });
    } catch {
      // ignore
    }
  }

  window.addEventListener(
    'message',
    (event: MessageEvent) => {
      if (event.source !== window) {
        return;
      }

      const data = event.data as unknown;
      if (!data || typeof data !== 'object') {
        return;
      }

      const maybeMsg = data as Partial<PerfMonitorMessage<string, unknown>>;
      if (maybeMsg.type !== 'PERF_MONITOR_CONFIG') {
        return;
      }

      const payload = maybeMsg.payload as PerfMonitorConfigPayload;
      const normalizedSampling = Number.isFinite(payload.samplingRate)
        ? Math.min(1, Math.max(0, payload.samplingRate))
        : 1;

      config = {
        samplingRate: normalizedSampling,
        extensionMode: payload.extensionMode === 'dev' ? 'dev' : 'silent',
        versionTag: typeof payload.versionTag === 'string' ? payload.versionTag : '',
        apiTrackingEnabled: payload.apiTrackingEnabled === true,
        redactQueryParams: payload.redactQueryParams === true,
        privacyMode: payload.privacyMode === true
      };

      window.postMessage({ type: 'PERF_MONITOR_CONFIG_ACK' }, '*');

      if (!configReceived) {
        configReceived = true;
        logDev('Config received');
        ensureGlobalLcpFinalizeListeners();
        patchSpaNavigationDispatch();
        startCapture();
      }
    },
    { passive: true }
  );

  // If config never arrives (should not happen), do nothing.
  globalThis.setTimeout(() => {
    if (!configReceived) {
      console.warn('[PerfMonitor][injected] No config received; capture not started');
    }
  }, 3000);
})();
