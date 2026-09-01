export type WorkerConsumerStatus =
  'STARTING' | 'RUNNING' | 'FAILED' | 'STOPPING' | 'STOPPED';

export interface WorkerRunState {
  isReady(): boolean;
}

export const REQUIRED_WORKER_CONSUMERS = [
  'volley-outbox-dispatcher',
  'volley-game-scheduler',
  'volley-outbox',
  'volley-game-messages',
  'volley-notifications',
  'volley-payment-reminders',
] as const;

export const WORKER_RUN_STATE = Symbol.for('volley.worker.run-state');

export class WorkerRunStateRegistry implements WorkerRunState {
  private readonly states = new Map<string, WorkerConsumerStatus>();

  public constructor(required: readonly string[] = REQUIRED_WORKER_CONSUMERS) {
    for (const name of required) this.states.set(name, 'STARTING');
  }

  public isReady(): boolean {
    return (
      this.states.size > 0 &&
      [...this.states.values()].every((status) => status === 'RUNNING')
    );
  }

  public status(name: string): WorkerConsumerStatus | undefined {
    return this.states.get(name);
  }

  public markStarting(name: string): void {
    this.assertRequired(name);
    this.states.set(name, 'STARTING');
  }

  public markRunning(name: string): void {
    this.assertRequired(name);
    if (this.states.get(name) !== 'FAILED') this.states.set(name, 'RUNNING');
  }

  public markStopping(name: string): void {
    this.assertRequired(name);
    this.states.set(name, 'STOPPING');
  }

  public markStopped(name: string): void {
    this.assertRequired(name);
    if (this.states.get(name) !== 'FAILED') this.states.set(name, 'STOPPED');
  }

  public observeRun(
    name: string,
    run: Promise<unknown>,
    logUnexpected: (error: Error) => void,
  ): void {
    this.assertRequired(name);
    void run.then(
      () =>
        this.finishRun(
          name,
          new Error(`${name} stopped unexpectedly`),
          logUnexpected,
        ),
      (error: unknown) =>
        this.finishRun(
          name,
          error instanceof Error ? error : new Error(String(error)),
          logUnexpected,
        ),
    );
  }

  private finishRun(
    name: string,
    error: Error,
    logUnexpected: (error: Error) => void,
  ): void {
    const status = this.states.get(name);
    if (status === 'STOPPING' || status === 'STOPPED') {
      this.states.set(name, 'STOPPED');
      return;
    }
    this.states.set(name, 'FAILED');
    logUnexpected(error);
  }

  private assertRequired(name: string): void {
    if (!this.states.has(name)) {
      throw new Error(`Unknown worker consumer: ${name}`);
    }
  }
}
