import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, SETTINGS_STORE, SESSIONS_STORE } from './constants';
import type { SessionMetrics, SettingsRecord } from './types';

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

let dbPromise: Promise<IDBPDatabase<PerfMonitorDbSchema>> | undefined;

export function getDb(): Promise<IDBPDatabase<PerfMonitorDbSchema>> {
  if (dbPromise) {
    return dbPromise;
  }

  const promise = openDB<PerfMonitorDbSchema>(DB_NAME, DB_VERSION, {
    upgrade(db: IDBPDatabase<PerfMonitorDbSchema>) {
      const sessions = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
      sessions.createIndex('timestamp', 'timestamp');
      sessions.createIndex('versionTag', 'versionTag');
      sessions.createIndex('url', 'url');
      sessions.createIndex('route', 'route');
      sessions.createIndex('versionTag_timestamp', ['versionTag', 'timestamp']);
      sessions.createIndex('origin', 'origin');
      sessions.createIndex('origin_timestamp', ['origin', 'timestamp']);

      db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
    }
  });

  dbPromise = promise;
  return promise;
}

export async function initDb(): Promise<void> {
  await getDb();
}
