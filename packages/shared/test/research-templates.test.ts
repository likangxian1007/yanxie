import { describe, expect, it } from 'vitest';
import { ResearchMethod, ResearchTemplate } from '../src/research';
import { PRESET_RESEARCH_TEMPLATES } from '../src/research-templates';

describe('预置研究方法', () => {
  it('每种方法有合法模板和可操作的字段、步骤及检查项', () => {
    expect(PRESET_RESEARCH_TEMPLATES.map((t) => t.method).sort()).toEqual(
      [...ResearchMethod.options].sort(),
    );
    for (const template of PRESET_RESEARCH_TEMPLATES) {
      expect(ResearchTemplate.safeParse(template).success, template.method).toBe(true);
      expect(template.fields.length).toBeGreaterThan(0);
      expect(new Set(template.fields.map((f) => f.id)).size).toBe(template.fields.length);
      const ids = template.steps.flatMap((s) => [s.id, ...s.checklist.map((c) => c.id)]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(template.steps.every((s) => s.description && s.checklist.length > 0)).toBe(true);
    }
  });
  it('允许没有假设、数值或 Notebook 的研究，且不改变模型配置', () => {
    for (const template of PRESET_RESEARCH_TEMPLATES) {
      expect(
        template.fields.every((f) => !f.required),
        template.method,
      ).toBe(true);
      expect(template).not.toHaveProperty('model');
      expect(template).not.toHaveProperty('effort');
      expect(template).not.toHaveProperty('profile');
    }
  });
  it('各方法保留自己的研究对象和解释方式', () => {
    const fields = (method: string) =>
      PRESET_RESEARCH_TEMPLATES.find((t) => t.method === method)!.fields.map((f) => f.id);
    expect(fields('experimental')).toEqual(
      expect.arrayContaining(['protocol', 'samples', 'deviations']),
    );
    expect(fields('observational')).toEqual(expect.arrayContaining(['variables', 'cleaning']));
    expect(fields('qualitative')).toEqual(
      expect.arrayContaining(['cases', 'memo', 'counterexamples']),
    );
    expect(fields('literature')).toEqual(expect.arrayContaining(['edition', 'sourceCriticism']));
    expect(fields('theoretical')).toEqual(
      expect.arrayContaining(['assumptions', 'derivation', 'counterexamples']),
    );
  });
});
