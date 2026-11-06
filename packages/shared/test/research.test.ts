import { describe, expect, it } from 'vitest';
import {
  ResearchFindingUpdateInput,
  ResearchMethod,
  ResearchRecordCreateInput,
  ResearchRecordUpdateInput,
  ResearchSourceUpdateInput,
} from '../src';

describe('research shared contracts', () => {
  it('accepts every method without requiring hypotheses, numbers or notebook', () => {
    expect(ResearchMethod.options).toHaveLength(7);
    for (const method of ResearchMethod.options) {
      const record = ResearchRecordCreateInput.parse({
        templateId: `rtpl_preset_${method}`,
        title: method,
      });
      expect(record.fieldValues).toEqual({});
      expect(record.resources).toEqual([]);
    }
  });

  it('keeps PATCH inputs sparse; defaults must not erase existing fields', () => {
    expect(ResearchRecordUpdateInput.parse({ baseVersion: 1, title: '改题目' })).toEqual({
      baseVersion: 1,
      title: '改题目',
    });
    expect(ResearchSourceUpdateInput.parse({ baseVersion: 2, citation: '补书目' })).toEqual({
      baseVersion: 2,
      citation: '补书目',
    });
    expect(ResearchFindingUpdateInput.parse({ baseVersion: 3, limitations: '补局限' })).toEqual({
      baseVersion: 3,
      limitations: '补局限',
    });
  });
});
