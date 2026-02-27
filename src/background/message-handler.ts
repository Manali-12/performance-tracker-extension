import {
  appendApiBatch,
  deleteDomain,
  deleteOldSessions,
  deleteVersion,
  getActiveTag,
  getAllTags,
  getAllowedOrigins,
  getAllowedScopes,
  getLatestSessionByOrigin,
  getLatestSessionByOriginAndTag,
  getLatestSession,
  getSessionsByTag,
  getStorageEstimate,
  addAllowedOrigin,
  setAllowedScopes,
  setActiveTag,
  saveSession,
  type ApiMetric,
  type AllowedScope,
  type SessionMetrics
} from './storage';

type BackgroundMessageAction =
  | 'METRICS_CAPTURED'
  | 'API_BATCH_CAPTURED'
  | 'GET_LATEST_SESSION'
  | 'GET_SESSIONS_BY_TAG'
  | 'GET_STORAGE_USAGE'
  | 'GET_ALL_TAGS'
  | 'GET_ACTIVE_TAG'
  | 'SET_ACTIVE_TAG'
  | 'GET_ALLOWED_ORIGINS'
  | 'GET_ALLOWED_SCOPES'
  | 'SET_ALLOWED_SCOPES'
  | 'DELETE_VERSION'
  | 'DELETE_DOMAIN'
  | 'GET_LATEST_SESSION_BY_ORIGIN'
  | 'ADD_ALLOWED_ORIGIN'
  | 'DATA_UPDATED'
  | 'TAGS_UPDATED';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPayload(message: Record<string, unknown>): unknown {
  return message.payload;
}

function readAction(message: Record<string, unknown>): BackgroundMessageAction | null {
  const actionValue = message.action;
  if (typeof actionValue !== 'string') {
    return null;
  }
  return actionValue as BackgroundMessageAction;
}

export async function handleBackgroundMessage(message: unknown): Promise<unknown> {
  if (!isRecord(message)) {
    return { ok: false };
  }

  const action = readAction(message);
  if (!action) {
    return { ok: false };
  }

  try {
    if (action === 'TAGS_UPDATED') {
      return { ok: true };
    }

    if (action === 'DATA_UPDATED') {
      return { ok: true };
    }

    if (action === 'METRICS_CAPTURED') {
      console.log('[PerfMonitor][receive] METRICS_CAPTURED received');
      const payload = readPayload(message);
      if (!payload) {
        console.log('[PerfMonitor][receive] METRICS_CAPTURED missing payload');
        return { ok: false };
      }

      const maybeUrl = isRecord(payload) ? payload.url : null;
      console.log(`[PerfMonitor][receive] METRICS_CAPTURED payload url=${typeof maybeUrl === 'string' ? maybeUrl : ''}`);

      await saveSession(payload as unknown as SessionMetrics);

      chrome.runtime.sendMessage({ action: 'DATA_UPDATED' }).catch(() => {
        // ignore
      });

      console.log('[PerfMonitor][receive] METRICS_CAPTURED saved');
      return { ok: true };
    }

    if (action === 'API_BATCH_CAPTURED') {
      console.log('[PerfMonitor][receive] API_BATCH_CAPTURED received');
      const payload = readPayload(message);
      if (!isRecord(payload) || typeof payload.sessionId !== 'string') {
        console.log('[PerfMonitor][receive] API_BATCH_CAPTURED invalid payload');
        return { ok: false };
      }

      console.log(`[PerfMonitor][receive] API_BATCH_CAPTURED sessionId=${payload.sessionId}`);
      const apiMetrics = Array.isArray(payload.apiMetrics) ? (payload.apiMetrics as unknown as ApiMetric[]) : [];
      await appendApiBatch(payload.sessionId, apiMetrics);
      console.log(`[PerfMonitor][receive] API_BATCH_CAPTURED appended sessionId=${payload.sessionId}`);
      return { ok: true };
    }

    if (action === 'GET_LATEST_SESSION') {
      const session = await getLatestSession();
      return { ok: true, session };
    }

    if (action === 'GET_LATEST_SESSION_BY_ORIGIN') {
      const payload = readPayload(message);
      const origin = isRecord(payload) ? payload.origin : null;
      const tag = isRecord(payload) ? payload.tag : null;
      const urlPatterns = isRecord(payload) ? payload.urlPatterns : null;
      if (typeof origin !== 'string') {
        return { ok: false };
      }
      const patterns = Array.isArray(urlPatterns) ? (urlPatterns as unknown[]).filter((p) => typeof p === 'string') as string[] : undefined;

      if (typeof tag === 'string') {
        const session = await getLatestSessionByOriginAndTag(origin, tag, patterns);
        return { ok: true, session };
      }

      const session = await getLatestSessionByOrigin(origin, patterns);
      return { ok: true, session };
    }

    if (action === 'GET_SESSIONS_BY_TAG') {
      const payload = readPayload(message);
      const tag = isRecord(payload) ? payload.tag : null;
      const origin = isRecord(payload) ? (typeof payload.origin === 'string' ? payload.origin : undefined) : undefined;
      const urlPatterns = isRecord(payload) ? payload.urlPatterns : null;
      if (typeof tag !== 'string') {
        return { ok: false };
      }

      const patterns = Array.isArray(urlPatterns) ? (urlPatterns as unknown[]).filter((p) => typeof p === 'string') as string[] : undefined;
      const sessions = await getSessionsByTag(tag, origin, patterns);
      return { ok: true, sessions };
    }

    if (action === 'GET_STORAGE_USAGE') {
      const estimate = await getStorageEstimate();
      return { ok: true, estimate };
    }

    if (action === 'GET_ALL_TAGS') {
      const payload = readPayload(message);
      const origin = isRecord(payload) ? (typeof payload.origin === 'string' ? payload.origin : undefined) : undefined;
      const tags = await getAllTags(origin);
      return { ok: true, tags };
    }

    if (action === 'GET_ACTIVE_TAG') {
      const payload = readPayload(message);
      const origin = isRecord(payload) ? (typeof payload.origin === 'string' ? payload.origin : undefined) : undefined;
      const tag = await getActiveTag(origin);
      return { ok: true, tag };
    }

    if (action === 'SET_ACTIVE_TAG') {
      const payload = readPayload(message);
      const tag = isRecord(payload) ? payload.tag : null;
      const origin = isRecord(payload) ? (typeof payload.origin === 'string' ? payload.origin : undefined) : undefined;
      if (typeof tag !== 'string') {
        return { ok: false };
      }

      await setActiveTag(tag, origin);
      chrome.runtime.sendMessage({ action: 'TAGS_UPDATED' }).catch(() => {
        // ignore
      });
      return { ok: true };
    }

    if (action === 'GET_ALLOWED_ORIGINS') {
      const origins = await getAllowedOrigins();
      return { ok: true, origins };
    }

    if (action === 'GET_ALLOWED_SCOPES') {
      const scopes = await getAllowedScopes();
      return { ok: true, scopes };
    }

    if (action === 'SET_ALLOWED_SCOPES') {
      const payload = readPayload(message);
      const scopesRaw = isRecord(payload) ? payload.scopes : null;
      if (!Array.isArray(scopesRaw)) {
        return { ok: false };
      }
      await setAllowedScopes(scopesRaw as unknown as AllowedScope[]);
      chrome.runtime.sendMessage({ action: 'TAGS_UPDATED' }).catch(() => {
        // ignore
      });
      return { ok: true };
    }

    if (action === 'DELETE_VERSION') {
      const payload = readPayload(message);
      const origin = isRecord(payload) ? payload.origin : null;
      const tag = isRecord(payload) ? payload.tag : null;
      const deleteSessions = isRecord(payload) ? payload.deleteSessions : null;
      if (typeof origin !== 'string' || typeof tag !== 'string' || typeof deleteSessions !== 'boolean') {
        return { ok: false };
      }
      await deleteVersion(origin, tag, deleteSessions);
      chrome.runtime.sendMessage({ action: 'TAGS_UPDATED' }).catch(() => {
        // ignore
      });
      return { ok: true };
    }

    if (action === 'DELETE_DOMAIN') {
      const payload = readPayload(message);
      const origin = isRecord(payload) ? payload.origin : null;
      if (typeof origin !== 'string') {
        return { ok: false };
      }
      await deleteDomain(origin);
      chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => {
        // ignore
      });
      chrome.runtime.sendMessage({ action: 'TAGS_UPDATED' }).catch(() => {
        // ignore
      });
      return { ok: true };
    }

    if (action === 'ADD_ALLOWED_ORIGIN') {
      const payload = readPayload(message);
      const origin = isRecord(payload) ? payload.origin : null;
      if (typeof origin !== 'string') {
        return { ok: false };
      }
      await addAllowedOrigin(origin);
      return { ok: true };
    }

    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function runRetentionCleanup(retentionDays: number): Promise<void> {
  await deleteOldSessions(retentionDays);
}
