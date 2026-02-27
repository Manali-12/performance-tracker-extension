(function () {
  if (typeof window === 'undefined') {
    return;
  }

  if (window.__perfMonitorInjected) {
    return;
  }

  window.__perfMonitorInjected = true;

  var canUseRuntimeMessaging =
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime !== 'undefined' &&
    typeof chrome.runtime.sendMessage === 'function';

  function safeSendRuntimeMessage(message) {
    if (!canUseRuntimeMessaging) {
      return;
    }

    try {
      chrome.runtime.sendMessage(message).catch(function () {
        // ignore
      });
    } catch (e) {
      // ignore
    }
  }

  function sendLog(msg) {
    safeSendRuntimeMessage({ action: 'LOG', payload: { message: String(msg) }, timestamp: Date.now() });
  }

  sendLog('Monitoring started');

  safeSendRuntimeMessage({
    action: 'INIT_INJECTION',
    payload: { injectedScriptPath: 'content/injected.js' },
    timestamp: Date.now()
  });

  function postConfigToInjected() {
    window.postMessage(
      {
        type: 'PERF_MONITOR_CONFIG',
        payload: {
          samplingRate: 1,
          extensionMode: 'dev',
          versionTag: '',
          apiTrackingEnabled: true,
          redactQueryParams: true,
          privacyMode: false
        }
      },
      '*'
    );
  }

  var configAcked = false;
  var configRetryTimeoutId = null;

  function stopConfigRetries() {
    if (configRetryTimeoutId) {
      clearTimeout(configRetryTimeoutId);
      configRetryTimeoutId = null;
    }
  }

  function startConfigRetries() {
    function retry() {
      if (configAcked) {
        stopConfigRetries();
        return;
      }

      postConfigToInjected();
      configRetryTimeoutId = setTimeout(retry, 250);
    }

    retry();
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) {
      return;
    }

    var data = event.data;
    if (!data || typeof data !== 'object') {
      return;
    }

    if (data.type === 'PERF_MONITOR_CONFIG_ACK') {
      configAcked = true;
      stopConfigRetries();
      sendLog('Injected script acknowledged config');
      return;
    }

    if (data.type === 'PERF_MONITOR_INJECTED_READY') {
      sendLog('Injected script is running');
      return;
    }

    if (data.type === 'PERF_MONITOR_INJECTED_LOAD') {
      var payload = data.payload || {};
      if (payload.ok === true) {
        sendLog('Injected script loaded');
      } else {
        sendLog('Injected script failed to load: ' + String(payload.error || 'unknown'));
      }
      return;
    }

    if (data.type === 'PERF_MONITOR_API_BATCH') {
      var payload = data.payload || {};
      safeSendRuntimeMessage({
        action: 'API_BATCH_CAPTURED',
        payload: {
          sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : '',
          apiMetrics: Array.isArray(payload.apiMetrics) ? payload.apiMetrics : []
        },
        timestamp: Date.now()
      });
      return;
    }

    if (data.type === 'PERF_MONITOR_SESSION_COMPLETE') {
      safeSendRuntimeMessage({ action: 'METRICS_CAPTURED', payload: data.payload, timestamp: Date.now() });
    }
  });

  startConfigRetries();
})();
