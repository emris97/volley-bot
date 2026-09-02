export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type LogOutput = string;

export interface LogContext extends Record<string, unknown> {
  correlationId?: string;
  updateId?: string;
  groupId?: string;
  gameId?: string;
  jobId?: string;
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  secrets?: readonly string[];
  output?: (line: LogOutput) => void;
  now?: () => Date;
}

const levels: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

const sensitiveKeys = new Set([
  'authorization',
  'authorizationheader',
  'bottoken',
  'body',
  'caption',
  'content',
  'databaseurl',
  'initdata',
  'messagecontent',
  'rawinitdata',
  'rawmessage',
  'redisurl',
  'telegrammessage',
  'telegramwebhooksecret',
  'text',
  'webhooksecret',
  'xtelegrambotapisecrettoken',
]);

const genericSensitiveKeyParts = [
  'password',
  'token',
  'secret',
  'cookie',
  'message',
] as const;

export class JsonLogger {
  private readonly minimumLevel: number;
  private readonly secrets: readonly string[];
  private readonly output: (line: LogOutput) => void;
  private readonly now: () => Date;

  public constructor(options: JsonLoggerOptions = {}) {
    this.minimumLevel = levels.indexOf(options.level ?? 'info');
    this.secrets = [
      ...(options.secrets ?? []),
      ...urlCredentials(options.secrets ?? []),
    ]
      .filter((secret) => secret.length > 0)
      .filter((secret, index, values) => values.indexOf(secret) === index)
      .toSorted((left, right) => right.length - left.length);
    this.output =
      options.output ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
  }

  public fatal(message: unknown, fields?: unknown): void {
    this.write('fatal', message, fields);
  }

  public error(message: unknown, fields?: unknown, context?: string): void {
    this.write('error', message, mergeContext(fields, context));
  }

  public warn(message: unknown, fields?: unknown): void {
    this.write('warn', message, fields);
  }

  public info(message: unknown, fields?: LogContext): void {
    this.write('info', message, fields);
  }

  public debug(message: unknown, fields?: unknown): void {
    this.write('debug', message, fields);
  }

  public trace(message: unknown, fields?: unknown): void {
    this.write('trace', message, fields);
  }

  public log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  public verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, fields?: unknown): void {
    if (levels.indexOf(level) < this.minimumLevel) return;
    const safeContext = redactValue(
      currentLogContext(),
      this.secrets,
      undefined,
      new WeakSet<object>(),
    );
    const safeFields = redactValue(
      fields,
      this.secrets,
      undefined,
      new WeakSet<object>(),
    );
    const contextualFields = isRecord(safeContext) ? safeContext : {};
    const payload = {
      ...contextualFields,
      ...(isRecord(safeFields)
        ? safeFields
        : safeFields === undefined
          ? {}
          : { details: safeFields }),
      timestamp: this.now().toISOString(),
      level,
      message: redactString(formatMessage(message), this.secrets),
    };
    this.output(JSON.stringify(payload, jsonReplacer));
  }
}

const mergeContext = (fields: unknown, context: string | undefined): unknown =>
  context === undefined
    ? fields
    : isRecord(fields)
      ? { ...fields, context }
      : { details: fields, context };

const formatMessage = (message: unknown): string => {
  if (message instanceof Error) return message.message;
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(message, jsonReplacer);
  } catch {
    return String(message);
  }
};

const redactValue = (
  value: unknown,
  secrets: readonly string[],
  key?: string,
  seen = new WeakSet<object>(),
): unknown => {
  if (key !== undefined && isSensitiveKey(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, secrets),
      stack:
        value.stack === undefined
          ? undefined
          : redactString(value.stack, secrets),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      return value.map((item) => redactValue(item, secrets, undefined, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (isRecord(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          redactValue(entryValue, secrets, entryKey, seen),
        ]),
      );
    } finally {
      seen.delete(value);
    }
  }
  return value;
};

const redactString = (value: string, secrets: readonly string[]): string => {
  let safe = value;
  for (const secret of secrets) safe = safe.split(secret).join('[REDACTED]');
  safe = safe.replace(
    /\b(?:postgres(?:ql)?|redis):\/\/[^\s"']+/giu,
    '[REDACTED_URL]',
  );
  safe = safe.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s"']+)@/giu,
    '$1[REDACTED]@',
  );
  safe = safe.replace(
    /\b(?:authorization\s*:\s*)?(?:bearer|basic|tma)\s+[^\s"']+/giu,
    '[REDACTED_AUTHORIZATION]',
  );
  safe = safe.replace(
    /\b(?:query_id|auth_date|user|hash)=[^\s"']+(?:&[^\s"']*)?/giu,
    '[REDACTED_INIT_DATA]',
  );
  return safe;
};

const urlCredentials = (values: readonly string[]): string[] =>
  values.flatMap((value) => {
    try {
      const url = new URL(value);
      if (!['postgres:', 'postgresql:', 'redis:'].includes(url.protocol)) {
        return [];
      }
      return [
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
      ].filter((credential) => credential.length > 0);
    } catch {
      return [];
    }
  });

const normalizeKey = (value: string): string =>
  value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

const isSensitiveKey = (value: string): boolean => {
  const normalized = normalizeKey(value);
  return (
    sensitiveKeys.has(normalized) ||
    genericSensitiveKeyParts.some((part) => normalized.includes(part))
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;
import { currentLogContext } from './log-context.js';
