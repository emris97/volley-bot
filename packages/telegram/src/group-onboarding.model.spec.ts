import { asGroupId } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import {
  encodeActionCallback,
  encodeAnswerCallback,
  nextWizardCode,
  parseOnboardingCallback,
  parseWizardProgress,
  type WizardAnswer,
} from './group-onboarding.model.js';

const groupId = asGroupId('00000000-0000-4000-8000-000000000001');

describe('group onboarding model', () => {
  it('finds the first unanswered step in the fixed seven-step order', () => {
    expect(nextWizardCode({ tz: 'Europe/Astrakhan', mp: true })).toBe('tp');
  });

  it('round-trips every allowed answer and both summary actions within 64 bytes', () => {
    const answers: WizardAnswer[] = [
      { code: 'tz', value: 'Europe/Astrakhan' },
      { code: 'mp', value: true },
      { code: 'tp', value: 1440 },
      { code: 'tr', value: 60 },
      { code: 'rm', value: 120 },
      { code: 'ro', value: 'UP_10' },
      { code: 'pin', value: false },
    ];
    const callbacks = [
      ...answers.map((answer) => encodeAnswerCallback(groupId, answer)),
      encodeActionCallback(groupId, 'SAVE'),
      encodeActionCallback(groupId, 'RESET'),
    ];

    expect(callbacks.every((value) => Buffer.byteLength(value) <= 64)).toBe(
      true,
    );
    expect(callbacks.map(parseOnboardingCallback)).toEqual([
      ...answers.map((answer) => ({ kind: 'ANSWER', groupId, answer })),
      { kind: 'SAVE', groupId },
      { kind: 'RESET', groupId },
    ]);
  });

  it('rejects unknown persisted values and malformed callback choices', () => {
    expect(() => parseWizardProgress({ tz: 'Europe/Moscow' })).toThrow(
      'Invalid stored onboarding progress',
    );
    for (const callback of [
      `cfg:${groupId}:tp:15`,
      `cfg:${groupId}:pin:yes`,
      `cfg:${groupId}:save:1:extra`,
      `other:${groupId}:mp:1`,
    ]) {
      expect(() => parseOnboardingCallback(callback)).toThrow(
        expect.objectContaining({ code: 'INVALID_CALLBACK' }),
      );
    }
  });
});
