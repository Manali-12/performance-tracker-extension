import { describe, it, expect } from 'vitest';
import { DB_NAME } from '../../src/shared/constants';

describe('#dbName', () => {
  it('should use PerfMonitorDB as database name', () => {
    expect(DB_NAME).toBe('PerfMonitorDB');
  });
});
