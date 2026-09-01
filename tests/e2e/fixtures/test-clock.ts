export class TestClock {
  public constructor(private current = new Date('2026-09-01T12:00:00.000Z')) {}

  public now = (): Date => new Date(this.current);

  public async advanceTo(value: Date): Promise<void> {
    if (value.getTime() < this.current.getTime()) {
      throw new Error('Test clock cannot move backwards');
    }
    this.current = new Date(value);
  }
}
