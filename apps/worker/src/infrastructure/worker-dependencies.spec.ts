import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WorkerDependencies } from './worker-dependencies.module.js';

describe('WorkerDependencies', () => {
  it('closes the shared PostgreSQL and Redis clients exactly once', async () => {
    const pool = Object.assign(new EventEmitter(), {
      end: vi.fn().mockResolvedValue(undefined),
    });
    const redis = {
      status: 'ready',
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    };
    const dependencies = new WorkerDependencies(pool as never, redis as never);

    await Promise.all([dependencies.stop(), dependencies.stop()]);
    await dependencies.stop();

    expect(pool.end).toHaveBeenCalledOnce();
    expect(redis.quit).toHaveBeenCalledOnce();
    expect(redis.disconnect).not.toHaveBeenCalled();
  });
});
