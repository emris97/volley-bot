import type { GameTemplateSnapshot } from '@volley/domain';

export interface GamePreviewModel {
  source: string;
  startsAtIso: string;
  settings?: GameTemplateSnapshot;
}

export const renderGamePreview = (model: GamePreviewModel): string => {
  const lines = [
    'game:preview',
    `source:${model.source}`,
    `starts-at:${model.startsAtIso}`,
  ];
  if (model.settings !== undefined) {
    lines.push(
      `venue:${model.settings.venue}`,
      `capacity:${model.settings.capacity}`,
      `duration:${model.settings.durationMinutes}`,
      `registration-opens:${model.settings.registrationOpensMinutesBefore}`,
      `confirmation:${model.settings.tentativePromptMinutesBefore}/${model.settings.tentativeResponseMinutes}`,
      `cost:${model.settings.defaultTotalCostMinor?.toString() ?? 'unset'} ${model.settings.currency}`,
    );
  }
  return lines.join('\n');
};
