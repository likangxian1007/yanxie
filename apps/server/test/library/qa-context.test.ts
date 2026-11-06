import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid, type PaperQaTurn, type PaperQaSession } from '@srh/shared';
import { papers, paperChunks } from '../../src/db/schema';
import { invalidateIndex } from '../../src/modules/library/search';
import { retrieveForQuestion } from '../../src/modules/library/qa';
import { setLibraryLlmForTest } from '../../src/modules/library/llm';
import { waitForQaJobs } from '../../src/modules/library/qa-jobs';
import type { LlmClient } from '../../src/agents/llm/client';
import { makeApp, setupProject, signup, type Session, type TestApp } from '../helpers';

let t: TestApp, owner: Session, outsider: Session, pid: string;
let calls: { stream?: boolean; messages: { role: string; content: string }[] }[] = [];
beforeAll(async () => {
  t = await makeApp();
  const group = await setupProject(t.app, ['member']);
  owner = group.owner;
  pid = group.project.id;
  outsider = await signup(t.app);
  setLibraryLlmForTest(t.app.ctx, {
    model: 'mock',
    reasoningModel: 'mock',
    client: {
      chat: {
        completions: {
          async create(body: (typeof calls)[number]) {
            calls.push(body);
            if (!body.stream)
              return { choices: [{ message: { content: 'summary, overview, main findings' } }] };
            return (async function* () {
              yield { choices: [{ delta: { content: '基于所提供论文段落的回答 [p.1 ¶1]。' } }] };
            })();
          },
        },
      },
    },
  } as unknown as LlmClient);
}, 60000);
beforeEach(() => {
  calls = [];
});
afterAll(async () => {
  await waitForQaJobs(t.app.ctx);
  await t.close();
});
const scope = (team = false, who = owner) =>
  team ? pid : { kind: 'personal' as const, ownerUserId: who.user.id };
async function seed(
  options: {
    team?: boolean;
    who?: Session;
    empty?: boolean;
    archived?: boolean;
    many?: boolean;
  } = {},
) {
  const { team = false, who = owner, empty = false, archived = false, many = false } = options;
  const id = `ppr_${ulid()}`;
  const [paper] = await t.db.db
    .insert(papers)
    .values({
      id,
      projectId: team ? pid : null,
      ownerUserId: team ? null : who.user.id,
      title: 'Quasistatic crystal transport',
      citekey: `crystal${ulid()}`,
      source: 'upload',
      status: 'ready',
      parser: 'pdf-text',
      pageCount: many ? 20 : 3,
      chunkCount: empty ? 0 : many ? 20 : 3,
      archivedAt: archived ? new Date() : null,
      createdBy: { kind: 'user', id: who.user.id, name: who.user.name },
    })
    .returning();
  const content = empty
    ? []
    : many
      ? Array.from({ length: 20 }, (_, i) => ({
          sectionPath: i === 0 ? 'Abstract' : i === 19 ? 'Conclusion' : `Section ${i}`,
          text:
            i === 0
              ? 'Crystal transport is the central research question.'
              : i === 19
                ? 'The final conclusion reports reproducibility constraints.'
                : `Quasistatic specimen ${i} has calibrated thermal measurements.`,
        }))
      : [
          {
            sectionPath: 'Abstract',
            text: 'Crystal transport depends on thermal gradients and sample geometry.',
          },
          {
            sectionPath: 'Methods',
            text: 'Quasistatic measurements use calibrated sensors under vacuum.',
          },
          {
            sectionPath: 'Conclusion',
            text: 'The final conclusion reports reproducibility constraints.',
          },
        ];
  if (content.length)
    await t.db.db.insert(paperChunks).values(
      content.map((c, seq) => ({
        id: `${id}:${seq}`,
        paperId: id,
        projectId: team ? pid : null,
        seq,
        kind: seq === 0 ? ('abstract' as const) : ('paragraph' as const),
        sectionPath: c.sectionPath,
        page: seq + 1,
        para: 1,
        text: c.text,
        boxes: [],
      })),
    );
  invalidateIndex(t.app.ctx, scope(team, who));
  return paper!;
}
const base = (p: typeof papers.$inferSelect) =>
  `${p.projectId ? `/projects/${p.projectId}` : ''}/library/papers/${p.id}`;
async function session(p: typeof papers.$inferSelect) {
  const r = await owner.req('POST', `${base(p)}/qa/sessions`, { title: '概括与追问' });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<PaperQaSession>();
}
async function ask(
  p: typeof papers.$inferSelect,
  s: PaperQaSession,
  question: string,
  extra: Record<string, unknown> = {},
) {
  const r = await owner.req('POST', `${base(p)}/qa/sessions/${s.id}/turns`, {
    requestId: randomUUID(),
    question,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(202);
  await waitForQaJobs(t.app.ctx);
  const rows = await owner.req('GET', `${base(p)}/qa/sessions/${s.id}/turns`);
  return rows.json<PaperQaTurn[]>().find((x) => x.id === r.json().id)!;
}

describe('单篇文献概览与追问上下文', () => {
  it.each([false, true])(
    '个人/团队=%s：概括文献即使没有关键词命中也把当前论文交给回答模型',
    async (team) => {
      const p = await seed({ team }),
        s = await session(p),
        r = await ask(p, s, '概括文献');
      expect(r.status).toBe('done');
      expect(r.sources).toHaveLength(3);
      expect(r.sources.every((source) => source.paperId === p.id)).toBe(true);
      const answer = calls.find((c) => c.stream);
      expect(answer).toBeDefined();
      expect(answer!.messages.at(-1)!.content).toContain('calibrated sensors');
      expect(answer!.messages.at(-1)!.content).toContain('reproducibility constraints');
      expect(r.answer).not.toContain('没有检索到');
    },
  );
  it('长论文的概览保留首尾和正文覆盖，不只取关键词命中的头几个段落', async () => {
    const p = await seed({ many: true }),
      s = await session(p),
      r = await ask(p, s, '概括文献');
    expect(r.sources.length).toBeGreaterThan(3);
    expect(r.sources.length).toBeLessThanOrEqual(12);
    expect(r.sources.some((s) => s.page === 1)).toBe(true);
    expect(r.sources.some((s) => s.page === 20)).toBe(true);
    expect(r.sources.some((s) => s.page > 3 && s.page < 18)).toBe(true);
  });
  it('普通关键词提问仍优先携带相关段落，并补充单篇概览', async () => {
    const p = await seed(),
      r = await retrieveForQuestion(t.app.ctx, scope(), {
        question: 'calibrated sensors',
        paperId: p.id,
      });
    expect(r.sources[0]?.text).toContain('calibrated sensors');
    expect(r.sources.some((s) => s.sectionPath === 'Conclusion')).toBe(true);
  });
  it('追问检索使用用户选中的历史问题，不依赖“再详细一点”字面命中', async () => {
    const p = await seed(),
      s = await session(p),
      first = await ask(p, s, 'quasistatic sensors', { searchScope: 'all' });
    const follow = await ask(p, s, '再详细一点', {
      searchScope: 'all',
      contextTurnIds: [first.id],
    });
    expect(first.status).toBe('done');
    expect(follow.status).toBe('done');
    expect(follow.sources.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.stream)).toHaveLength(2);
    expect(follow.context[0]?.turnId).toBe(first.id);
  });
  it('只有当前论文的正文能兜底；不读取其他个人库、项目库或归档论文', async () => {
    const personal = await seed({ who: outsider }),
      team = await seed({ team: true }),
      archived = await seed({ archived: true });
    for (const p of [personal, team, archived]) {
      const found = await retrieveForQuestion(t.app.ctx, scope(), {
        question: '概括文献',
        paperId: p.id,
      });
      expect(found.sources).toEqual([]);
    }
  });
  it('真正没有正文时明确失败并给出下一步，不冒充模型已完成回答', async () => {
    const p = await seed({ empty: true }),
      s = await session(p),
      r = await ask(p, s, '概括文献');
    expect(r.status).toBe('failed');
    expect(r.error).toContain('正文');
    expect(r.answer).toBe('');
    expect(calls.some((c) => c.stream)).toBe(false);
  });
  it('全库检索没有命中时不随机拼接其他论文作为依据', async () => {
    const p = await seed(),
      s = await session(p),
      r = await ask(p, s, 'unmatchablezqxv', { searchScope: 'all' });
    expect(r.sources).toEqual([]);
    expect(r.status).toBe('failed');
    expect(calls.some((c) => c.stream)).toBe(false);
  });
});
