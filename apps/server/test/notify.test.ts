import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId, type NotifyOverview, type NotifySubscription } from '@srh/shared';
import { createDb } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';
import {
  inboxItems,
  messages,
  notifyDeliveries,
  notifySubscriptions,
  projectMembers,
  threads,
} from '../src/db/schema';
import {
  parsePlatformResponse,
  postWebhook,
  setNotifySenderForTest,
} from '../src/modules/notify/deliver';
import { enqueueEvent, flushPending } from '../src/modules/notify/pump';
import { maskUrl } from '../src/modules/notify/service';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

/**
 * 通知订阅（飞书 / 企业微信 / 钉钉 群机器人）。
 *
 * 四类用例：成功、未登录 401、无权限 403/404、参数错 422；
 * 另加：地址打码、平台白名单、隐私过滤（旁聊/个人线程/他人收件箱）、重试与自动停用。
 */
let t: TestApp;
let project: Awaited<ReturnType<typeof setupProject>>['project'];
let owner: Session;
let member: Session;

/** 假发送器：记录每次调用，按需返回成功/失败 */
interface Sent {
  url: string;
  payload: Record<string, unknown>;
}
let sent: Sent[] = [];
let nextResult: { ok: boolean; status: number; snippet: string; error?: string } = {
  ok: true,
  status: 200,
  snippet: '{"code":0,"msg":"success"}',
};

beforeAll(async () => {
  t = await makeApp({ NOTIFY_ENABLED: 'true', NOTIFY_MAX_PER_USER: '20' });
  const setup = await setupProject(t.app, ['member']);
  project = setup.project;
  owner = setup.owner;
  member = setup.others[0]!;
  // 第一条用例跑之前就要装好假发送器（afterEach 只在用例结束后执行）
  setNotifySenderForTest(async (url, payload) => {
    sent.push({ url, payload });
    return nextResult;
  });
}, 60_000);

afterAll(async () => {
  setNotifySenderForTest(null);
  await t?.close();
});

afterEach(() => {
  sent = [];
  nextResult = { ok: true, status: 200, snippet: '{"code":0,"msg":"success"}' };
  setNotifySenderForTest(async (url, payload) => {
    sent.push({ url, payload });
    return nextResult;
  });
});

const FEISHU_URL =
  'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef01-2345-6789-abcd-ef0123456789';
const WECOM_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef01-2345-6789';

async function createSub(
  session: Session,
  body: Record<string, unknown>,
): Promise<NotifySubscription> {
  const res = await session.req('POST', '/auth/me/notify', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<NotifySubscription>();
}

/** 造一条收件箱（直接入库，避免依赖其它模块的副作用） */
/**
 * 造一条收件箱。默认 `kind='decision'`（系统生成的文案，没有正文摘录）；
 * 要测 @ 提醒就传 `kind='mention'` + 真实消息 id 当 sourceId。
 */
async function makeInbox(
  userId: string,
  title: string,
  href = '/p/x',
  kind:
    | 'decision'
    | 'review'
    | 'mention'
    | 'conflict'
    | 'assignment'
    | 'finished'
    | 'recheck' = 'decision',
  sourceId: string = newId('message'),
) {
  const [row] = await t.db.db
    .insert(inboxItems)
    .values({
      id: newId('inbox'),
      projectId: project.id,
      userId,
      kind,
      title,
      href,
      sourceId,
    })
    .returning();
  return row!;
}

describe('订阅接口', () => {
  it('未登录 → 401', async () => {
    for (const [method, url] of [
      ['GET', '/auth/me/notify'],
      ['POST', '/auth/me/notify'],
      ['DELETE', '/auth/me/notify/nsub_x'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url: `/api/v1${url}`,
        ...(method === 'POST' ? { payload: { name: 'x' } } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('创建成功：地址只回打码版，原文不出现', async () => {
    const sub = await createSub(owner, {
      name: '实验室群',
      provider: 'feishu',
      url: FEISHU_URL,
    });
    expect(sub.urlHint).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/abcd****');
    expect(JSON.stringify(sub)).not.toContain('abcdef01-2345-6789-abcd-ef0123456789');

    const list = await owner.req('GET', '/auth/me/notify');
    const body = list.json<NotifyOverview>();
    expect(body.enabled).toBe(true);
    expect(list.body).not.toContain('abcdef01-2345-6789-abcd-ef0123456789');
  });

  it('企业微信地址用 query 里的 key 打码', async () => {
    const sub = await createSub(owner, {
      name: '企微群',
      provider: 'wecom',
      url: WECOM_URL,
    });
    expect(sub.urlHint).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd****');
  });

  it('参数错 → 422（http、非官方域名、路径不对、名字空）', async () => {
    const cases: unknown[] = [
      { name: 'x', provider: 'feishu', url: 'http://open.feishu.cn/open-apis/bot/v2/hook/a' },
      { name: 'x', provider: 'feishu', url: 'https://evil.example.com/open-apis/bot/v2/hook/a' },
      { name: 'x', provider: 'feishu', url: 'https://open.feishu.cn/other/path' },
      { name: '   ', provider: 'feishu', url: FEISHU_URL },
      { name: 'x', provider: 'unknown', url: FEISHU_URL },
    ];
    for (const body of cases) {
      const res = await owner.req('POST', '/auth/me/notify', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
  });

  it('每人上限超出 → 409', async () => {
    const limited = await makeApp({ NOTIFY_ENABLED: 'true', NOTIFY_MAX_PER_USER: '1' });
    try {
      const s = await signup(limited.app, '上限测试');
      const first = await s.req('POST', '/auth/me/notify', {
        name: 'a',
        provider: 'feishu',
        url: FEISHU_URL,
      });
      expect(first.statusCode).toBe(201);
      const second = await s.req('POST', '/auth/me/notify', {
        name: 'b',
        provider: 'feishu',
        url: FEISHU_URL,
      });
      expect(second.statusCode).toBe(409);
    } finally {
      await limited.close();
    }
  }, 60_000);

  it('删别人的订阅 → 404；删自己的 → 204', async () => {
    const sub = await createSub(owner, { name: '待删', provider: 'feishu', url: FEISHU_URL });
    expect((await member.req('DELETE', `/auth/me/notify/${sub.id}`)).statusCode).toBe(404);
    expect((await owner.req('DELETE', `/auth/me/notify/${sub.id}`)).statusCode).toBe(204);
  });

  it('开关关闭时：列表可读，新建/测试 403', async () => {
    const off = await makeApp({ NOTIFY_ENABLED: 'false' });
    try {
      const s = await signup(off.app, '开关关闭');
      const list = await s.req('GET', '/auth/me/notify');
      expect(list.statusCode).toBe(200);
      expect(list.json<NotifyOverview>().enabled).toBe(false);
      const created = await s.req('POST', '/auth/me/notify', {
        name: 'x',
        provider: 'feishu',
        url: FEISHU_URL,
      });
      expect(created.statusCode).toBe(403);
    } finally {
      await off.close();
    }
  }, 60_000);
});

describe('消息格式与发送', () => {
  it('发测试消息：飞书格式正确，成功时记录 lastSuccessAt', async () => {
    const sub = await createSub(owner, { name: '测试群', provider: 'feishu', url: FEISHU_URL });
    const res = await owner.req('POST', `/auth/me/notify/${sub.id}/test`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({
      msg_type: 'text',
      content: { text: expect.stringContaining('测试消息') },
    });
    const list = (await owner.req('GET', '/auth/me/notify')).json<NotifyOverview>();
    expect(list.subscriptions.find((s) => s.id === sub.id)?.lastSuccessAt).not.toBeNull();
  });

  it('企业微信用 msgtype/text.content 格式', async () => {
    const sub = await createSub(owner, { name: '企微格式', provider: 'wecom', url: WECOM_URL });
    await owner.req('POST', `/auth/me/notify/${sub.id}/test`);
    expect(sent[0]!.payload).toMatchObject({
      msgtype: 'text',
      text: { content: expect.any(String) },
    });
  });

  it('平台返回 code≠0 视为失败（HTTP 200 不能当成功）', async () => {
    nextResult = {
      ok: false,
      status: 200,
      snippet: '{"code":19001,"msg":"param invalid"}',
      error: '平台返回失败：{"code":19001}',
    };
    const sub = await createSub(owner, { name: '失败格式', provider: 'feishu', url: FEISHU_URL });
    const res = await owner.req('POST', `/auth/me/notify/${sub.id}/test`);
    expect(res.json<{ ok: boolean; message: string }>().ok).toBe(false);
    expect(res.json<{ message: string }>().message).toContain('失败');
  });
});

describe('事件推送与隐私', () => {
  it('收件箱有新东西 → 生成待发 → 发送成功 → 记录成功', async () => {
    const sub = await createSub(owner, { name: '事件群', provider: 'feishu', url: FEISHU_URL });
    const item = await makeInbox(owner.user.id, '李四 请你审阅《方法》', `/p/${project.id}`);

    await enqueueEvent(t.app.ctx, {
      type: 'inbox.created',
      projectId: project.id,
      seq: 9001,
      threadId: null,
      payload: item,
      actor: { kind: 'user', id: owner.user.id, name: owner.user.name },
    } as never);
    const n = await flushPending(t.app.ctx);
    expect(n).toBeGreaterThanOrEqual(1);
    // 主人的每个启用订阅都会收到（其它用例也建过订阅），这里只关心内容与记录
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // 只发固定文案（不再把收件箱标题里的正文摘录发出去）
    expect(JSON.stringify(sent[0]!.payload)).toContain('等你拍板');

    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
    expect(rows[0]!.attempts).toBe(1);
  });

  it('别人的收件箱不会推给我', async () => {
    const sub = await createSub(member, { name: '成员群', provider: 'feishu', url: FEISHU_URL });
    const ownerInbox = await makeInbox(owner.user.id, '只给主人看的提醒');
    await enqueueEvent(t.app.ctx, {
      type: 'inbox.created',
      projectId: project.id,
      seq: 9002,
      threadId: null,
      payload: ownerInbox,
      actor: { kind: 'system', id: 'sys', name: '系统' },
    } as never);
    await flushPending(t.app.ctx);
    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(0);
  });

  it('旁聊（agentVisible=false）一律不推', async () => {
    const sub = await createSub(owner, { name: '旁聊群', provider: 'feishu', url: FEISHU_URL });
    await enqueueEvent(t.app.ctx, {
      type: 'message.created',
      projectId: project.id,
      seq: 9003,
      threadId: null,
      payload: { id: 'msg_x', body: '这是旁聊', agentVisible: false, threadId: null },
      actor: { kind: 'user', id: owner.user.id, name: owner.user.name },
    } as never);
    await flushPending(t.app.ctx);
    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(0);
  });

  it('个人线程只推给线程主人', async () => {
    const [thread] = await t.db.db
      .insert(threads)
      .values({
        id: newId('thread'),
        projectId: project.id,
        kind: 'personal',
        rootMessageId: newId('message'),
        title: '我的私人线程',
        ownerUserId: owner.user.id,
      })
      .returning();
    const memberSub = await createSub(member, {
      name: '成员群2',
      provider: 'feishu',
      url: FEISHU_URL,
    });
    await enqueueEvent(t.app.ctx, {
      type: 'message.created',
      projectId: project.id,
      seq: 9004,
      threadId: thread!.id,
      payload: { id: 'msg_y', body: '私人内容', agentVisible: true, threadId: thread!.id },
      actor: { kind: 'user', id: owner.user.id, name: owner.user.name },
    } as never);
    await flushPending(t.app.ctx);
    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, memberSub.id));
    expect(rows).toHaveLength(0);
  });

  it('同一条事件重复入队只发一次（幂等）', async () => {
    const sub = await createSub(owner, { name: '幂等群', provider: 'feishu', url: FEISHU_URL });
    const item = await makeInbox(owner.user.id, '幂等测试');
    const event = {
      type: 'inbox.created',
      projectId: project.id,
      seq: 9005,
      threadId: null,
      payload: item,
      actor: { kind: 'system', id: 'sys', name: '系统' },
    };
    await enqueueEvent(t.app.ctx, event as never);
    await enqueueEvent(t.app.ctx, event as never);
    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(1);
  });
});

describe('重试与自动停用', () => {
  it('失败后进入重试（记录失败次数与下次时间），5 次后放弃', async () => {
    nextResult = { ok: false, status: 0, snippet: '', error: '连接失败' };
    const sub = await createSub(owner, { name: '重试群', provider: 'feishu', url: FEISHU_URL });
    const item = await makeInbox(owner.user.id, '重试测试');
    await enqueueEvent(t.app.ctx, {
      type: 'inbox.created',
      projectId: project.id,
      seq: 9101,
      threadId: null,
      payload: item,
      actor: { kind: 'system', id: 'sys', name: '系统' },
    } as never);

    // 第 1 次
    await flushPending(t.app.ctx);
    let [row] = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(row!.status).toBe('failed');
    expect(row!.attempts).toBe(1);
    expect(row!.nextAttemptAt).not.toBeNull();

    // 把下次时间拨到过去，连打 4 次凑满 5 次
    for (let i = 0; i < 4; i += 1) {
      await t.db.db
        .update(notifyDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(notifyDeliveries.id, row!.id));
      await flushPending(t.app.ctx);
      [row] = await t.db.db.select().from(notifyDeliveries).where(eq(notifyDeliveries.id, row!.id));
    }
    expect(row!.attempts).toBe(5);
    expect(row!.status).toBe('dropped');
    expect(row!.nextAttemptAt).toBeNull();
  });

  it('连续失败到阈值 → 自动停用并写原因', async () => {
    nextResult = { ok: false, status: 500, snippet: 'boom', error: 'HTTP 500' };
    const sub = await createSub(owner, { name: '停用群', provider: 'feishu', url: FEISHU_URL });
    // 把连败次数直接顶到 19，再失败一次就触发停用
    await t.db.db
      .update(notifySubscriptions)
      .set({ failureStreak: 19 })
      .where(eq(notifySubscriptions.id, sub.id));

    const item = await makeInbox(owner.user.id, '停用测试');
    await enqueueEvent(t.app.ctx, {
      type: 'inbox.created',
      projectId: project.id,
      seq: 9201,
      threadId: null,
      payload: item,
      actor: { kind: 'system', id: 'sys', name: '系统' },
    } as never);
    await flushPending(t.app.ctx);

    const [row] = await t.db.db
      .select()
      .from(notifySubscriptions)
      .where(eq(notifySubscriptions.id, sub.id));
    expect(row!.enabled).toBe(false);
    expect(row!.disabledReason).toContain('连续失败');

    // 停用后要在主人收件箱留一条提醒（计划书要求）
    const reminders = await t.db.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.sourceId, `nsub:${sub.id}`));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.userId).toBe(owner.user.id);
    expect(reminders[0]!.title).toContain('停用');
  });
});

// ---------------------------------------------------------------- 评审修复的回归用例

/** 造一条消息（可控制旁聊 agentVisible 与线程） */
async function makeMessage(opts: {
  body: string;
  agentVisible?: boolean;
  threadId?: string | null;
  authorId?: string;
  authorName?: string;
}) {
  const [row] = await t.db.db
    .insert(messages)
    .values({
      id: newId('message'),
      projectId: project.id,
      threadId: opts.threadId ?? null,
      authorKind: 'user',
      authorId: opts.authorId ?? owner.user.id,
      authorName: opts.authorName ?? owner.user.name,
      kind: 'text',
      body: opts.body,
      meta: {},
      agentVisible: opts.agentVisible ?? true,
    })
    .returning();
  return row!;
}

describe('内容红线：只发事件说明与链接，不发正文片段', () => {
  it('旁聊（agentVisible=false）里的 @ 提醒不外发', async () => {
    const sub = await createSub(owner, { name: '旁聊@群', provider: 'feishu', url: FEISHU_URL });
    const secret = '这是旁聊里的机密内容不该出现在群里';
    const msg = await makeMessage({ body: secret, agentVisible: false });
    const item = await makeInbox(
      owner.user.id,
      `${owner.user.name} 提到了你：${secret.slice(0, 40)}`,
    );

    await enqueueEvent(t.app.ctx, {
      type: 'inbox.created',
      projectId: project.id,
      seq: 9301,
      threadId: null,
      payload: { ...item, kind: 'mention', sourceId: msg.id },
      actor: { kind: 'user', id: owner.user.id, name: owner.user.name },
    } as never);
    await flushPending(t.app.ctx);

    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(0);
    expect(JSON.stringify(sent)).not.toContain(secret.slice(0, 20));
  });

  it('团队讨论里 @ 成员：会通知，但不带正文片段', async () => {
    const sub = await createSub(owner, { name: '讨论@群', provider: 'feishu', url: FEISHU_URL });
    const body = '这段正文的前四十个字绝对不能出现在飞书群里这是测试用的前缀';
    const msg = await makeMessage({ body, agentVisible: true });
    const item = await makeInbox(
      owner.user.id,
      `${owner.user.name} 提到了你：${body.slice(0, 40)}`,
    );

    await enqueueEvent(t.app.ctx, {
      type: 'inbox.created',
      projectId: project.id,
      seq: 9302,
      threadId: null,
      payload: { ...item, kind: 'mention', sourceId: msg.id },
      actor: { kind: 'user', id: owner.user.id, name: owner.user.name },
    } as never);
    await flushPending(t.app.ctx);

    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('@ 了你');
    expect(rows[0]!.text).not.toContain('这段正文的前四十个字');
    expect(JSON.stringify(sent)).not.toContain('这段正文的前四十个字');
  });

  it('普通消息通知不带正文；短消息也不会被整条发出去', async () => {
    const sub = await createSub(owner, {
      name: '消息群',
      provider: 'feishu',
      url: FEISHU_URL,
      eventTypes: ['message.created'],
    });
    await enqueueEvent(t.app.ctx, {
      type: 'message.created',
      projectId: project.id,
      seq: 9303,
      threadId: null,
      payload: { id: 'msg_short', body: '短消息原文', agentVisible: true, threadId: null },
      actor: { kind: 'user', id: owner.user.id, name: owner.user.name },
    } as never);
    await flushPending(t.app.ctx);
    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).not.toContain('短消息原文');
    expect(rows[0]!.text).toContain('发了新消息');
  });

  it('决策卡提醒用固定文案，不带问题原文', async () => {
    const sub = await createSub(owner, { name: '决策群', provider: 'feishu', url: FEISHU_URL });
    const question = '要不要把这条实验数据删掉这是个决策问题';
    const item = await makeInbox(owner.user.id, question);
    await t.db.db.update(inboxItems).set({ kind: 'decision' }).where(eq(inboxItems.id, item.id));
    await enqueueEvent(t.app.ctx, {
      type: 'inbox.created',
      projectId: project.id,
      seq: 9304,
      threadId: null,
      payload: { ...item, kind: 'decision', title: question },
      actor: { kind: 'agent', id: 'a', name: '协调者' },
    } as never);
    await flushPending(t.app.ctx);
    const rows = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('决策卡等你拍板');
    expect(rows[0]!.text).not.toContain('要不要把这条实验数据删掉');
  });
});

describe('发送前复核项目成员身份', () => {
  it('入队后被移出项目 → 终止投递，不发到他的群', async () => {
    // 用 member 的订阅：先把 member 加进来（setupProject 里已是 member）
    const sub = await createSub(member, {
      name: '成员群-移出',
      provider: 'feishu',
      url: FEISHU_URL,
    });
    const [delivery] = await t.db.db
      .insert(notifyDeliveries)
      .values({
        id: newId('notifyDelivery'),
        subscriptionId: sub.id,
        projectId: project.id,
        eventSeq: 9401,
        eventType: 'inbox.created',
        payload: { type: 'inbox.created', seq: 9401 },
        text: '【研协 Thinkloft】「项目」有新的待处理事项',
        status: 'pending',
        nextAttemptAt: new Date(0),
      })
      .returning();

    // 把他移出项目
    await t.db.db
      .delete(projectMembers)
      .where(eq(projectMembers.projectId, project.id) && eq(projectMembers.userId, member.user.id));

    await flushPending(t.app.ctx);

    const [after] = await t.db.db
      .select()
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.id, delivery!.id));
    expect(after!.status).toBe('dropped');
    expect(after!.error).toContain('失去项目访问权限');
    expect(sent).toHaveLength(0);
  });
});

describe('URL 打码与平台成功判定', () => {
  it('飞书地址带额外 key/sign 参数时，路径凭证与参数都要打码', () => {
    const hint = maskUrl(
      'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET-HOOK-1111?key=SECRET-KEY-2222&sign=SECRET-SIGN-3333',
      'feishu',
    );
    expect(hint).not.toContain('SECRET-HOOK-1111');
    expect(hint).not.toContain('SECRET-KEY-2222');
    expect(hint).not.toContain('SECRET-SIGN-3333');
    expect(hint).toContain('SECR****');
  });

  it('企微 / 钉钉遮 query 里的凭证，不动 /send 路径', () => {
    const wecom = maskUrl(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef01-2345',
      'wecom',
    );
    expect(wecom).not.toContain('abcdef01-2345');
    expect(wecom).toContain('/send');
    const ding = maskUrl(
      'https://oapi.dingtalk.com/robot/send?access_token=deadbeef1234',
      'dingtalk',
    );
    expect(ding).not.toContain('deadbeef1234');
    expect(ding).toContain('/send');
  });

  it('平台返回码必须明确为 0，空响应/HTML 一律算失败', () => {
    expect(parsePlatformResponse('feishu', 200, '{"code":0,"msg":"success"}').ok).toBe(true);
    expect(parsePlatformResponse('feishu', 200, '{"StatusCode":0}').ok).toBe(true);
    expect(parsePlatformResponse('wecom', 200, '{"errcode":0,"errmsg":"ok"}').ok).toBe(true);
    expect(parsePlatformResponse('dingtalk', 200, '{"errcode":0}').ok).toBe(true);

    expect(parsePlatformResponse('feishu', 200, '{"code":19001}').ok).toBe(false);
    expect(parsePlatformResponse('wecom', 200, '{"errcode":93000}').ok).toBe(false);
    expect(parsePlatformResponse('feishu', 200, '').ok).toBe(false); // 空响应
    expect(parsePlatformResponse('feishu', 200, '<html>502 Bad Gateway</html>').ok).toBe(false);
    expect(parsePlatformResponse('feishu', 200, '{"msg":"ok"}').ok).toBe(false); // 没有返回码
    expect(parsePlatformResponse('feishu', 500, '{"code":0}').ok).toBe(false); // HTTP 500
  });

  it('postWebhook 走真实解析：200 + code≠0 记为失败', async () => {
    setNotifySenderForTest(null); // 这一条要覆盖真实解析，不能用假发送器
    const fetchMock = vi.fn(
      async () => new Response('{"code":19001,"msg":"bad"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await postWebhook(FEISHU_URL, { msg_type: 'text' }, 'feishu');
      expect(res.ok).toBe(false);
      expect(res.error).toContain('19001');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('迁移', () => {
  it('空库上建好两张通知表', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'srh-notify-mig-'));
    const db = await createDb(`pglite:${dir}`);
    try {
      await db.migrate(migrationsFolder());
      const subs = await db.db.select().from(notifySubscriptions);
      const dels = await db.db.select().from(notifyDeliveries);
      expect(subs).toEqual([]);
      expect(dels).toEqual([]);
    } finally {
      await db.close();
    }
  }, 120_000);
});
