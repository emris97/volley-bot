import { describe, expect, it, vi } from 'vitest';
import { WorkerRunStateRegistry } from './worker-run-state.js';

describe('WorkerRunStateRegistry', () => {
  it('is ready only while every required consumer is running', () => {
    const state = new WorkerRunStateRegistry(['one', 'two']);

    expect(state.isReady()).toBe(false);
    state.markRunning('one');
    expect(state.isReady()).toBe(false);
    state.markRunning('two');
    expect(state.isReady()).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)(
    'becomes non-ready after an unexpected worker %s without an unhandled rejection',
    async (ending) => {
      const state = new WorkerRunStateRegistry(['consumer']);
      const logger = vi.fn();
      const run =
        ending === 'resolve'
          ? Promise.resolve()
          : Promise.reject(new Error('worker failed'));

      state.markRunning('consumer');
      state.observeRun('consumer', run, logger);
      await vi.waitFor(() => expect(state.isReady()).toBe(false));

      expect(logger).toHaveBeenCalledOnce();
      expect(state.status('consumer')).toBe('FAILED');
    },
  );

  it('marks planned shutdown before the run resolves and never reports it as failed', async () => {
    let release!: () => void;
    const run = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = new WorkerRunStateRegistry(['consumer']);
    const logger = vi.fn();
    state.markRunning('consumer');
    state.observeRun('consumer', run, logger);

    state.markStopping('consumer');
    expect(state.isReady()).toBe(false);
    release();
    await run;
    await vi.waitFor(() => expect(state.status('consumer')).toBe('STOPPED'));

    expect(logger).not.toHaveBeenCalled();
  });
});
