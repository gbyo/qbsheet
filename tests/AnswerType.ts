/**
 * One way a tossup can be answered, for tests.
 *
 * The point value is the whole of it — the desktop records no marker, no packet position, and no
 * other property of a buzz. `isPower` and `isNeg` are derived rather than stored, which is why a
 * format whose base tossup is worth more than ten has a power it did not ask for.
 */
/** One way a tossup can be answered. The point value is the whole of it. */
export default class AnswerType {
  value: number;

  private explicitLabel?: string;

  private explicitShortLabel?: string;

  constructor(points: number) {
    this.value = points;
  }

  get label(): string {
    return this.explicitLabel ? this.explicitLabel : this.value.toString();
  }

  set label(text: string) {
    this.explicitLabel = text;
  }

  get shortLabel(): string {
    return this.explicitShortLabel ? this.explicitShortLabel : this.label;
  }

  set shortLabel(text: string) {
    this.explicitShortLabel = text;
  }

  /** Derived, not stored: a power is a tossup worth more than ten, wherever that lands. */
  get isPower(): boolean {
    return this.value > 10;
  }

  get isNeg(): boolean {
    return this.value < 0;
  }

  get id(): string {
    return `AnswerType_${this.label}`;
  }
}
