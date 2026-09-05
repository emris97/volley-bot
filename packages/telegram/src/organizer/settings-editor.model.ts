export const templateEditorFields = [
  'NAME',
  'VENUE',
  'ADDRESS',
  'TIME',
  'DURATION',
  'CAPACITY',
  'OPENING',
  'CLOSING',
  'CONFIRMATION_PROMPT',
  'CONFIRMATION_RESPONSE',
  'REMINDER',
  'MEMBER_PRIORITY',
  'COST',
  'ROUNDING',
] as const;

export type SettingsEditorField = (typeof templateEditorFields)[number];
export type TemplateWizardStep = SettingsEditorField | 'PREVIEW';

export const nextTemplateStep = (
  step: TemplateWizardStep,
): TemplateWizardStep => {
  const index = templateEditorFields.indexOf(step as SettingsEditorField);
  return index < 0 || index === templateEditorFields.length - 1
    ? 'PREVIEW'
    : templateEditorFields[index + 1]!;
};

export const previousTemplateStep = (
  step: TemplateWizardStep,
): TemplateWizardStep => {
  if (step === 'PREVIEW') return templateEditorFields.at(-1)!;
  const index = templateEditorFields.indexOf(step);
  return index <= 0 ? 'NAME' : templateEditorFields[index - 1]!;
};

export const isTemplateWizardStep = (
  value: unknown,
): value is TemplateWizardStep =>
  value === 'PREVIEW' ||
  templateEditorFields.includes(value as SettingsEditorField);
