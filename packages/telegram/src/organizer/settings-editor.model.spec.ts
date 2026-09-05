import { asGameTemplateId } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import {
  nextTemplateStep,
  previousTemplateStep,
  templateEditorFields,
} from './settings-editor.model.js';
import {
  parseTemplateWizardDraft,
  type TemplateWizardDraft,
} from '../templates/template-wizard.model.js';

describe('template settings editor model', () => {
  it('moves forward and backward through every field and preview', () => {
    const steps = [...templateEditorFields, 'PREVIEW'] as const;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      expect(nextTemplateStep(step)).toBe(steps[index + 1] ?? 'PREVIEW');
      expect(previousTemplateStep(step)).toBe(steps[index - 1] ?? 'NAME');
    }
    expect(previousTemplateStep('CAPACITY')).toBe('DURATION');
  });

  it('strictly revives a version-1 draft with bigint snapshot values', () => {
    const draft: TemplateWizardDraft = {
      version: 1,
      mode: 'EDIT',
      step: 'PREVIEW',
      draftId: '018f6ba062d27bd18f1312e0c8424611',
      viewRevision: 7,
      templateId: asGameTemplateId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
      expectedRevision: 2,
      snapshot: {
        name: 'Среда вечером',
        defaultTotalCostMinor: 125050n,
      },
      previewed: true,
    };

    expect(
      parseTemplateWizardDraft({
        ...draft,
        snapshot: {
          ...draft.snapshot,
          defaultTotalCostMinor: 'bigint:125050',
        },
      }),
    ).toEqual(draft);
  });

  it('rejects unknown JSON keys and unsupported draft versions', () => {
    const valid = {
      version: 1,
      mode: 'CREATE',
      step: 'NAME',
      draftId: '018f6ba062d27bd18f1312e0c8424611',
      viewRevision: 0,
      snapshot: {},
      previewed: false,
    };
    expect(() =>
      parseTemplateWizardDraft({ ...valid, surprise: true }),
    ).toThrow(/unknown draft key/i);
    expect(() => parseTemplateWizardDraft({ ...valid, version: 2 })).toThrow(
      /unsupported draft version/i,
    );
  });

  it('requires a persisted view revision in version-1 drafts', () => {
    expect(() =>
      parseTemplateWizardDraft({
        version: 1,
        mode: 'CREATE',
        step: 'NAME',
        draftId: '018f6ba062d27bd18f1312e0c8424611',
        snapshot: {},
        previewed: false,
      }),
    ).toThrow(/view revision/i);
  });
});
