export type TemplateInputErrorCode =
  | 'NAME'
  | 'VENUE'
  | 'ADDRESS'
  | 'TIME'
  | 'DURATION'
  | 'CAPACITY'
  | 'OPENING'
  | 'CLOSING'
  | 'CONFIRMATION'
  | 'REMINDER'
  | 'COST';

export class TemplateInputError extends Error {
  public constructor(public readonly code: TemplateInputErrorCode) {
    super(`Invalid template ${code.toLowerCase()}`);
    this.name = 'TemplateInputError';
  }
}

export class TemplateNameConflictError extends Error {
  public static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === 'TemplateNameConflictError';
  }

  public constructor() {
    super('An active template with this name already exists');
    this.name = 'TemplateNameConflictError';
  }
}

export class TemplateRevisionConflictError extends Error {
  public constructor() {
    super('Template revision is stale');
    this.name = 'TemplateRevisionConflictError';
  }
}

export class TemplateNotFoundError extends Error {
  public constructor() {
    super('Template not found');
    this.name = 'TemplateNotFoundError';
  }
}
