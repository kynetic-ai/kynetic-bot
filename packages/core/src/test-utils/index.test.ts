import { describe, it, expect } from 'vitest';
import { delay } from './index.js';

describe('test utilities', () => {
  it('delay should wait for specified time', async () => {
    const start = Date.now();
    await delay(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});
