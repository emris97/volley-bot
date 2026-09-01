import { describe, expect, it } from 'vitest';
import { packageMarker as domainMarker } from '@volley/domain';
import { packageMarker as applicationMarker } from '@volley/application';

describe('workspace', () => {
  it('resolves internal packages through workspace aliases', () => {
    expect([domainMarker, applicationMarker]).toEqual([
      'domain',
      'application',
    ]);
  });
});
