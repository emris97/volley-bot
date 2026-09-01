import { describe, expect, it, vi } from 'vitest';
import { WorkerLifecycleService } from './worker-lifecycle.service.js';

describe('WorkerLifecycleService', () => {
  it('starts registered consumers during module initialization', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const service = new WorkerLifecycleService([
      { start, stop: vi.fn().mockResolvedValue(undefined) },
    ]);

    await service.onModuleInit();

    expect(start).toHaveBeenCalledOnce();
  });

  it('stops registered consumers in reverse order during shutdown', async () => {
    const calls: string[] = [];
    const service = new WorkerLifecycleService([
      {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(async () => {
          calls.push('first');
        }),
      },
      {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(async () => {
          calls.push('second');
        }),
      },
    ]);

    await service.onApplicationShutdown();

    expect(calls).toEqual(['second', 'first']);
  });
});
