import { INJECTED_SCRIPT_PATH } from '../shared/constants';
import { MessageAction } from '../shared/messages';
import type { ExtensionMessage, InitInjectionPayload, LogPayload } from '../shared/types';

type ExtensionMode = 'dev' | 'silent';

interface PerfMonitorConfigPayload {
  samplingRate: number;
  extensionMode: ExtensionMode;
  versionTag: string;
  apiTrackingEnabled: boolean;
  redactQueryParams: boolean;
  privacyMode: boolean;
}

interface PerfMonitorSessionCompleteMessage {
  type: 'PERF_MONITOR_SESSION_COMPLETE';
  payload: unknown;
}

interface PerfMonitorApiBatchMessage {
  type: 'PERF_MONITOR_API_BATCH';
  payload: unknown;
}

interface ApiBatchPayload {
  sessionId: string;
  apiMetrics: unknown;
}

interface PerfMonitorConfigAckMessage {
  type: 'PERF_MONITOR_CONFIG_ACK';
}

declare global {
  interface Window {
    __perfMonitorInjected?: boolean;
  }
}

function canUseRuntimeMessaging(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined' && typeof chrome.runtime.sendMessage === 'function';
}

function safeSendRuntimeMessage<T>(message: ExtensionMessage<T> | Record<string, unknown>): void {
  if (!canUseRuntimeMessaging()) {
    return;
  }

  chrome.runtime.sendMessage(message).catch(() => {
    // ignore
  });
}

function sendLog(message: string): void {
  const payload: LogPayload = { message };
  const logMsg: ExtensionMessage<LogPayload> = {
    action: MessageAction.Log,
    payload,
    timestamp: Date.now()
  };

  safeSendRuntimeMessage(logMsg);
}

function getExtensionMode(): ExtensionMode {
  return 'dev';
}

const extensionMode = getExtensionMode();

((): void => {
  if (window.__perfMonitorInjected) {
    if (extensionMode === 'dev') {
      console.log('[PerfMonitor][content] Already injected - skipping');
    }
    return;
  }

  window.__perfMonitorInjected = true;

  if (extensionMode === 'dev') {
    console.log('[PerfMonitor][content] Monitoring started');
  }
  sendLog('Monitoring started');

  const initPayload: InitInjectionPayload = { injectedScriptPath: INJECTED_SCRIPT_PATH };
  const initMsg: ExtensionMessage<InitInjectionPayload> = {
    action: MessageAction.InitInjection,
    payload: initPayload,
    timestamp: Date.now()
  };

  if (!canUseRuntimeMessaging()) {
    if (extensionMode === 'dev') {
      console.log('[PerfMonitor][content] chrome.runtime is not available - skipping background injection request');
    }
  } else {
    chrome.runtime.sendMessage(initMsg).catch(() => {
      sendLog('Failed to request injection');
    });
  }

function getSamplingRate(): number {
  return 1;
}

function getVersionTag(): string {
  return '';
}

function getApiTrackingEnabled(): boolean {
  return true;
}

function getRedactQueryParams(): boolean {
  return true;
}

function getPrivacyMode(): boolean {
  return false;
}

function postConfigToInjected(): void {
  const payload: PerfMonitorConfigPayload = {
    samplingRate: getSamplingRate(),
    extensionMode: getExtensionMode(),
    versionTag: getVersionTag(),
    apiTrackingEnabled: getApiTrackingEnabled(),
    redactQueryParams: getRedactQueryParams(),
    privacyMode: getPrivacyMode()
  };

  window.postMessage({ type: 'PERF_MONITOR_CONFIG', payload }, '*');
}

let configAcked = false;
let configRetryTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

function stopConfigRetries(): void {
  if (configRetryTimeoutId) {
    globalThis.clearTimeout(configRetryTimeoutId);
    configRetryTimeoutId = null;
  }
}

function startConfigRetries(): void {
  const retry = (): void => {
    if (configAcked) {
      stopConfigRetries();
      return;
    }

    postConfigToInjected();
    configRetryTimeoutId = globalThis.setTimeout(retry, 250);
  };

  retry();
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data as unknown;
  if (!data || typeof data !== 'object') {
    return;
  }

  const ackMsg = data as Partial<PerfMonitorConfigAckMessage>;
  if (ackMsg.type === 'PERF_MONITOR_CONFIG_ACK') {
    configAcked = true;
    stopConfigRetries();
    if (extensionMode === 'dev') {
      console.log('[PerfMonitor][content] Config acknowledged by injected script');
    }
    return;
  }

  const apiBatchMsg = data as Partial<PerfMonitorApiBatchMessage>;
  if (apiBatchMsg.type === 'PERF_MONITOR_API_BATCH') {
    const payload = apiBatchMsg.payload as unknown;
    const batchPayload = payload as Partial<ApiBatchPayload>;

    chrome.runtime
      .sendMessage({
        action: 'API_BATCH_CAPTURED',
        payload: {
          sessionId: typeof batchPayload.sessionId === 'string' ? batchPayload.sessionId : '',
          apiMetrics: Array.isArray(batchPayload.apiMetrics) ? batchPayload.apiMetrics : []
        },
        timestamp: Date.now()
      })
      .catch(() => {
        sendLog('Failed to forward API batch');
      });
    return;
  }

  const msg = data as Partial<PerfMonitorSessionCompleteMessage>;
  if (msg.type !== 'PERF_MONITOR_SESSION_COMPLETE') {
    return;
  }

  const metricsMsg: ExtensionMessage<unknown> = {
    action: MessageAction.MetricsCaptured,
    payload: msg.payload,
    timestamp: Date.now()
  };

  safeSendRuntimeMessage(metricsMsg);
});

startConfigRetries();

})();
