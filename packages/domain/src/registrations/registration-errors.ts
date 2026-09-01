export class InvalidRegistrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidRegistrationError';
  }
}

export class RegistrationMutationNotAllowedError extends Error {
  public constructor(message = 'Registration mutation is not allowed') {
    super(message);
    this.name = 'RegistrationMutationNotAllowedError';
  }
}
