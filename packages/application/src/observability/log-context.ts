import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogContext } from './logger.js';

const logContextStorage = new AsyncLocalStorage<LogContext>();

export const runWithLogContext = <Result>(
  context: LogContext,
  action: () => Result,
): Result =>
  logContextStorage.run(
    { ...(logContextStorage.getStore() ?? {}), ...context },
    action,
  );

export const currentLogContext = (): LogContext =>
  logContextStorage.getStore() ?? {};
