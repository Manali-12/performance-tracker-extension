import { MessageAction } from '../shared/messages';
import type { ExtensionMessage, InitInjectionPayload, LogPayload } from '../shared/types';

import { handleBackgroundMessage, runRetentionCleanup } from './message-handler';
import { getAllowedScopes, initDB } from './storage';

const retentionAlarmName = 'retention-cleanup';
const retentionAlarmPeriodMinutes = 1440;
const defaultRetentionDays = 90;

type BadgeStatus = 'good' | 'neutral' | 'bad';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDevLoggingEnabled(): boolean {
  try {
    return import.meta.env.DEV;
  } catch {
    return false;
  }
}

function logDev(message: string): void {
  if (!isDevLoggingEnabled()) {
    return;
  }
  console.log(`[PerfMonitor][background] ${message}`);
}

function logInjection(message: string): void {
  console.log(`[PerfMonitor][inject] ${message}`);
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

function matchesUrlPatterns(urlValue: unknown, urlPatterns: string[]): boolean {
  if (!Array.isArray(urlPatterns) || urlPatterns.length === 0) {
    return true;
  }
  if (typeof urlValue !== 'string') {
    return false;
  }
  try {
    const pathname = new URL(urlValue).pathname;
    const set = new Set<string>(urlPatterns.map((p) => normalizeUrlPattern(p)).filter((p) => p.length > 0));
    return set.has(pathname);
  } catch {
    return false;
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

async function injectContentScript(tabId: number, tabUrl: string): Promise<void> {
  if (!isInjectableUrl(tabUrl)) {
    logInjection(`Skipping injection - non-injectable URL: ${tabUrl}`);
    return;
  }

  let origin = '';
  try {
    origin = new URL(tabUrl).origin;
  } catch {
    origin = '';
  }
  if (!origin) {
    logInjection(`Skipping injection - could not parse origin from: ${tabUrl}`);
    return;
  }

  const permitted = await hasOriginPermission(origin);
  if (!permitted) {
    logInjection(`Skipping injection - no host permission for: ${origin}`);
    return;
  }
  logInjection(`Host permission present for: ${origin}`);

  const scopes = await getAllowedScopes();
  const scope = scopes.find((s) => s.origin === origin);
  if (!scope) {
    logInjection(`Skipping injection - origin not in allowedScopes: ${origin}`);
    return;
  }

  const patterns = Array.isArray(scope.urlPatterns) ? scope.urlPatterns : ([] as string[]);
  if (!matchesUrlPatterns(tabUrl, patterns)) {
    logInjection(`Skipping injection - URL path not in urlPatterns for ${origin}: ${tabUrl}`);
    return;
  }

  logInjection(`Injecting content script into tab ${tabId} at ${tabUrl}`);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/index.js'],
      world: 'ISOLATED'
    });
    logInjection(`Content script injected successfully into tab ${tabId}`);
  } catch (err) {
    logInjection(`Content script injection failed for tab ${tabId}: ${String(err)}`);
  }
}

function updateExtensionBadge(status: BadgeStatus): void {
  try {
    if (status === 'bad') {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e53935' });
      return;
    }

    if (status === 'good') {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#43a047' });
      return;
    }

    chrome.action.setBadgeText({ text: '' });
  } catch {
    // ignore
  }
}

async function initialize(): Promise<void> {
  try {
    await initDB();
    logDev('IndexedDB initialized');
  } catch {
    logDev('IndexedDB init failed');
  }

  try {
    chrome.alarms.create(retentionAlarmName, { periodInMinutes: retentionAlarmPeriodMinutes });
  } catch {
    // ignore
  }
}

void initialize();

try {
  chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
    if (changeInfo.status !== 'complete') {
      return;
    }
    const tabUrl = tab.url;
    if (typeof tabUrl !== 'string') {
      return;
    }
    void injectContentScript(tabId, tabUrl);
  });
} catch {
  // ignore
}

try {
  chrome.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
    if (alarm.name !== retentionAlarmName) {
      return;
    }

    void runRetentionCleanup(defaultRetentionDays);
  });
} catch {
  // ignore
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage<unknown> | Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    const action = (message as { action?: unknown }).action;

    if (action === MessageAction.Log) {
      const payload = (message as ExtensionMessage<LogPayload>).payload;
      console.log('[PerfMonitor][log]', payload.message);
      sendResponse({ ok: true });
      return;
    }

    if (action === 'INJECT_CONTENT_SCRIPT') {
      const payload = (message as { payload?: unknown }).payload;
      const tabId = isRecord(payload) ? payload.tabId : null;
      const tabUrl = isRecord(payload) ? payload.url : null;
      if (typeof tabId !== 'number' || typeof tabUrl !== 'string') {
        sendResponse({ ok: false });
        return;
      }

      void (async (): Promise<void> => {
        logInjection(`INJECT_CONTENT_SCRIPT requested for tab ${tabId} at ${tabUrl}`);
        await injectContentScript(tabId, tabUrl);
        sendResponse({ ok: true });
      })();

      return true;
    }

    if (action === MessageAction.InitInjection) {
      const payload = (message as ExtensionMessage<InitInjectionPayload>).payload;
      const tabId = sender.tab?.id;
      const tabUrl = sender.tab?.url;

      if (typeof tabId !== 'number') {
        logInjection('INIT_INJECTION rejected - missing tabId on sender');
        sendResponse({ ok: false, error: 'No tabId available on sender' });
        return;
      }

      let origin = '';
      try {
        origin = typeof tabUrl === 'string' ? new URL(tabUrl).origin : '';
      } catch {
        origin = '';
      }

      if (!origin) {
        logInjection(`INIT_INJECTION rejected - invalid tab URL: ${String(tabUrl)}`);
        sendResponse({ ok: false, error: 'Invalid tab url' });
        return;
      }

      void (async (): Promise<void> => {
        logInjection(`INIT_INJECTION received from tab ${tabId} at ${String(tabUrl)}`);
        const permitted = await hasOriginPermission(origin);
        if (!permitted) {
          logInjection(`INIT_INJECTION rejected - no host permission for: ${origin}`);
          sendResponse({ ok: false, error: 'Missing host permission' });
          return;
        }
        logInjection(`INIT_INJECTION allowed - host permission present for: ${origin}`);

        const scopes = await getAllowedScopes();
        const scope = scopes.find((s) => s.origin === origin);
        if (!scope) {
          logInjection(`INIT_INJECTION rejected - origin not in allowedScopes: ${origin}`);
          sendResponse({ ok: false, error: 'Origin not allowed' });
          return;
        }

        const patterns = Array.isArray(scope.urlPatterns) ? scope.urlPatterns : ([] as string[]);
        if (!matchesUrlPatterns(tabUrl, patterns)) {
          logInjection(`INIT_INJECTION rejected - URL path not allowed for ${origin}: ${String(tabUrl)}`);
          sendResponse({ ok: false, error: 'Path not allowed' });
          return;
        }

        chrome.scripting
          .executeScript({
            target: { tabId },
            files: [payload.injectedScriptPath],
            world: 'MAIN'
          })
          .then(() => {
            logInjection(`Injected page script into MAIN world for tab ${tabId}`);
            sendResponse({ ok: true });
          })
          .catch((err: unknown) => {
            logInjection(`Failed to inject page script into MAIN world for tab ${tabId}: ${String(err)}`);
            sendResponse({ ok: false });
          });
      })();

      return true;
    }

    if (action === 'UPDATE_BADGE_STATUS') {
      const payload = (message as { payload?: unknown }).payload;
      const statusValue = isRecord(payload) ? payload.status : null;
      if (statusValue !== 'good' && statusValue !== 'neutral' && statusValue !== 'bad') {
        sendResponse({ ok: false });
        return;
      }

      updateExtensionBadge(statusValue);
      sendResponse({ ok: true });
      return;
    }

    if (!isRecord(message) || typeof message.action !== 'string') {
      sendResponse({ ok: false });
      return;
    }

    void handleBackgroundMessage(message)
      .then((result) => {
        sendResponse(result);
      })
      .catch(() => {
        sendResponse({ ok: false });
      });

    return true;
  }
);
