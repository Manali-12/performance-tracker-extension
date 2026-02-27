import { MessageAction } from './messages';

export interface ExtensionMessage<TPayload> {
  action: MessageAction;
  payload: TPayload;
  timestamp: number;
}

export interface InitInjectionPayload {
  injectedScriptPath: string;
}

export interface LogPayload {
  message: string;
}

export interface SettingsRecord {
  key: string;
  value: unknown;
}

export interface SessionMetrics {
  id: string;
  timestamp: number;
  versionTag: string;
  url: string;
  route: string;
  navigationType: 'hard' | 'spa';
}
