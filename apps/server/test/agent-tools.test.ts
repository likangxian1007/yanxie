import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type DocumentMeta, type Project } from '@srh/shared';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';
import { agentSessions, projects, threads } from '../src/db/schema';
import { createClaim } from '../src/modules/claims/service';
import { createProjectThread } from '../src/modules/threads/service';
import { createMessage } from '../src/modules/timeline/service';
import {
  registerCollabPort,
  resetCollabPort,
  type AgentDocEdit,
  type DocumentsPort,
} from '../src/agents/tools/collab-port';
import { collabTools } from '../src/agents/tools/collab';
import { fileTools } from '../src/agents/tools/files';
import { htmlToText, isBlockedAddress, parseArxivAtom, webTools } from '../src/agents/tools/web';
import { toolsFor } from '../src/agents/tools/index';
import { ToolError, type ToolContext } from '../src/agents/tools/types';

let t: TestApp;
let project: Project;
let owner: Session;
let tc: ToolContext;

const OTHER = { kind: 'agent' as const, id: 'agt_other', name: '研协' };

// ---------------------------------------------------------------- 内存文档端口

const store = new Map<string, { meta: DocumentMeta; markdown: string }>();

function outlineOf(md: string) {
  return [...md.matchAll(/^(#{1,6})\s+(.+?)\s*$/gmu)].map((m) => ({
    heading: m[2]!,
    level: m[1]!.length,
  }));
}

function sectionRange(md: string, heading: string) {
  const lines = [...md.matchAll(/^(#{1,6})\s+(.+?)\s*$/gmu)];
  const i = lines.findIndex((m) => m[2] === heading);
  if (i < 0) throw new Error(`no heading ${heading}`);
  const self = lines[i]!;
  const next = lines.slice(i + 1).find((m) => m[1]!.length <= self[1]!.length);
  return {
    start: self.index,
    bodyStart: self.index + self[0].length,
    end: next ? next.index : md.length,
  };
}

function applyEdit(md: string, edit: AgentDocEdit): string {
  switch (edit.op) {
    case 'append':
      return `${md.trimEnd()}\n\n${edit.markdown}\n`;
    case 'insert_after_heading': {
      const r = sectionRange(md, edit.heading);
      return `${md.slice(0, r.bodyStart)}\n\n${edit.markdown}${md.slice(r.bodyStart)}`;
    }
    case 'replace_section': {
      const r = sectionRange(md, edit.heading);
      return `${md.slice(0, r.start)}${edit.markdown.trimEnd()}\n\n${md.slice(r.end)}`;
    }
    case 'replace_text': {
      let at = -1;
      for (let n = 0; n < (edit.occurrence ?? 1); n++) at = md.indexOf(edit.find, at + 1);
      return at < 0 ? md : md.slice(0, at) + edit.replace + md.slice(at + edit.find.length);
    }
    default:
      return md;
  }
}

const fakeDocs: DocumentsPort = {
  async list() {
    return [...store.values()].map((d) => d.meta);
  },
  async read(_ctx, _projectId, docId) {
    const d = store.get(docId);
    if (!d) throw new Error('not found');
    return { meta: d.meta, markdown: d.markdown, outline: outlineOf(d.markdown) };
  },
  async create(_ctx, actor, projectId, input) {
    const now = new Date().toISOString();
    const meta: DocumentMeta = {
      id: newId('document'),
      projectId,
      parentId: input.parentId ?? null,
      kind: 'doc',
      title: input.title ?? '未命名文档',
      icon: null,
      excerpt: (input.markdown ?? '').slice(0, 200),
      createdBy: actor,
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    store.set(meta.id, { meta, markdown: input.markdown ?? '' });
    return meta;
  },
  async applyEdit(_ctx, actor, _projectId, docId, edit) {
    const d = store.get(docId);
    if (!d) throw new Error('not found');
    d.markdown = applyEdit(d.markdown, edit);
    d.meta = { ...d.meta, updatedBy: actor, updatedAt: new Date().toISOString() };
    return { meta: d.meta, markdown: d.markdown };
  },
};

const ALL = [...collabTools, ...fileTools, ...webTools];

async function call(name: string, args: Record<string, unknown>) {
  const def = ALL.find((d) => d.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def.run(tc, def.schema.parse(args)) as Promise<Record<string, unknown>>;
}

async function toolError(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error('预期 ToolError');
}

const DOC_MD = [
  '# 文献综述',
  '',
  '## 1 引言',
  '',
  '引言内容。',
  '',
  '## 2 方法',
  '',
  '方法内容：GraphCL 与 MolCLR。',
  '',
  '### 2.1 细节',
  '',
  '细节内容。',
  '',
  '## 3 实验',
  '',
  '实验内容：GraphCL 基线。',
  '',
].join('\n');

let docId: string;

beforeAll(async () => {
  t = await makeApp({ AGENT_FETCH_URL: 'true' });
  // 协作模块在 register() 里注册了真实端口；这里的用例用假端口，先清空
  resetCollabPort();
  const s = await setupProject(t.app, ['member']);
  project = s.project;
  owner = s.owner;
  const ctx = t.app.ctx;
  const ownerRef = { kind: 'user' as const, id: owner.user.id, name: owner.user.name };
  const root = await createMessage(ctx, {
    projectId: project.id,
    threadId: null,
    author: ownerRef,
    body: '帮我调研图对比学习文献',
  });
  const { thread, sessionId } = await createProjectThread(ctx, {
    projectId: project.id,
    rootMessageId: root.id,
    title: '图对比学习文献调研',
    workingForUserId: owner.user.id,
    actor: ownerRef,
  });
  const [threadRow] = await t.db.db.select().from(threads).where(eq(threads.id, thread.id));
  const [sessionRow] = await t.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId));
  const [projectRow] = await t.db.db.select().from(projects).where(eq(projects.id, project.id));
  tc = {
    ctx,
    session: sessionRow!,
    project: projectRow!,
    thread: threadRow!,
    turnId: 'turn_test',
    actor: { kind: 'agent', id: sessionId, name: '研协' },
    requesterUserId: owner.user.id,
    visible: new Set(),
    setActivity: async () => {},
  };
}, 60_000);

afterAll(async () => {
  resetCollabPort();
  await t?.close();
});

describe('tool registry', () => {
  it('collab tools are hidden until the port is registered', () => {
    const before = toolsFor(t.app.ctx, 'thread').map((d) => d.name);
    expect(before).not.toContain('list_documents');
    expect(before).not.toContain('edit_document');
    expect(before).toContain('write_file');
    expect(before).toContain('fetch_url');

    registerCollabPort({ documents: fakeDocs });
    const after = toolsFor(t.app.ctx, 'thread').map((d) => d.name);
    expect(after).toContain('list_documents');
    expect(after).toContain('edit_document');
    expect(after).not.toContain('create_experiment'); // experiments 端口没注册
    const coord = toolsFor(t.app.ctx, 'coordinator').map((d) => d.name);
    expect(coord).toContain('read_document');
    expect(coord).not.toContain('edit_document');
    expect(coord).not.toContain('write_file');
    expect(coord).toContain('fetch_url');
    expect(coord).toContain('web_search');
    expect(coord).toContain('paper_search');
  });

  it('web tools follow AGENT_FETCH_URL', () => {
    const off = { ...t.app.ctx, config: { ...t.app.ctx.config, AGENT_FETCH_URL: false } };
    const names = toolsFor(off, 'thread').map((d) => d.name);
    expect(names).not.toContain('fetch_url');
    expect(names).not.toContain('web_search');
  });

  it('tool names are unique', () => {
    const names = ALL.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('documents + write guard', () => {
  it('create / list / read (with section)', async () => {
    const created = await call('create_document', { title: '文献综述', markdown: DOC_MD });
    docId = created.doc_id as string;
    expect(created.link).toBe(`[文献综述](#${docId})`);
    const list = (await call('list_documents', {})).documents as { id: string; kind: string }[];
    expect(list.find((d) => d.id === docId)?.kind).toBe('doc');
    const sec = await call('read_document', { doc_id: docId, section: '2 方法' });
    expect(sec.markdown).toContain('### 2.1 细节');
    expect(sec.markdown).not.toContain('3 实验');
    const missing = await toolError(call('read_document', { doc_id: docId, section: '9 不存在' }));
    expect(missing.details?.outline).toContain('2 方法');
  });

  it('edit without claim → claim_required', async () => {
    const err = await toolError(
      call('edit_document', {
        doc_id: docId,
        op: 'replace_section',
        heading: '2 方法',
        markdown: '## 2 方法\n\n新内容。',
      }),
    );
    expect(err.details?.code).toBe('claim_required');
    expect(err.details?.claim).toMatchObject({
      resource_kind: 'doc_section',
      resource_ref: `${docId}#2 方法`,
    });
  });

  it('section claim allows section edits (incl. sub-headings) but not whole-document ops', async () => {
    await createClaim(t.app.ctx, tc.actor, project.id, {
      resourceKind: 'doc_section',
      resourceRef: `${docId}#2 方法`,
      mode: 'exclusive',
      intent: '为 张三 写综述 §2',
      ttlSec: 1800,
      threadId: tc.thread!.id,
    });
    const ok = await call('edit_document', {
      doc_id: docId,
      op: 'insert_after_heading',
      heading: '2.1 细节',
      markdown: '补充一句细节。',
    });
    expect(ok.ok).toBe(true);
    expect(ok.excerpt).toContain('补充一句细节。');

    const scoped = await call('edit_document', {
      doc_id: docId,
      op: 'replace_text',
      heading: '2 方法',
      find: '方法内容：GraphCL',
      replace: '方法内容：GraphCL（ICML 2020）',
    });
    expect(scoped.excerpt).toContain('GraphCL（ICML 2020）');

    // 整篇范围的操作：小节认领不覆盖整篇
    const whole = await toolError(
      call('edit_document', { doc_id: docId, op: 'replace_text', find: '实验内容', replace: 'X' }),
    );
    expect(whole.details?.code).toBe('claim_required');
    const append = await toolError(
      call('edit_document', { doc_id: docId, op: 'append', markdown: '## 4 附录' }),
    );
    expect(append.details?.code).toBe('claim_required');
    expect(append.details?.claim).toMatchObject({ resource_kind: 'document', mode: 'shared' });

    // 带 heading 的 replace_text 也不能改到别的小节
    const outside = await toolError(
      call('edit_document', {
        doc_id: docId,
        op: 'replace_text',
        heading: '2 方法',
        find: 'GraphCL',
        replace: 'Y',
      }),
    );
    expect(outside.message).toContain('之外');
    expect(store.get(docId)!.markdown).toContain('实验内容：GraphCL 基线');
  });

  it("another holder's exclusive claim → claim_conflict", async () => {
    await createClaim(t.app.ctx, OTHER, project.id, {
      resourceKind: 'doc_section',
      resourceRef: `${docId}#3 实验`,
      mode: 'exclusive',
      intent: '整理复现结果写入 §3',
      ttlSec: 1800,
      threadId: 'thr_other',
      onBehalfOfUserId: owner.user.id,
    });
    const err = await toolError(
      call('edit_document', {
        doc_id: docId,
        op: 'replace_section',
        heading: '3 实验',
        markdown: '## 3 实验\n\n覆盖。',
      }),
    );
    expect(err.details?.code).toBe('claim_conflict');
    const claims = err.details?.claims as {
      holder: string;
      intent: string;
      on_behalf_of: string;
    }[];
    expect(claims[0]).toMatchObject({ intent: '整理复现结果写入 §3', on_behalf_of: '张三' });
    expect(store.get(docId)!.markdown).not.toContain('覆盖。');
  });

  it('unknown heading and missing op args are reported', async () => {
    const e1 = await toolError(
      call('edit_document', {
        doc_id: docId,
        op: 'replace_section',
        heading: '2 方法论',
        markdown: 'x',
      }),
    );
    expect(e1.message).toContain('没有标题');
    const e2 = await toolError(
      call('edit_document', { doc_id: docId, op: 'replace_section', heading: '2 方法' }),
    );
    expect(e2.message).toContain('markdown');
    const e3 = await toolError(
      call('edit_document', { doc_id: docId, op: 'set_cells', cells: [{ ref: 'A1', value: '1' }] }),
    );
    expect(e3.message).toContain('sheet');
  });

  it('不许写出重复标题（验收：LGTM 后文档里出现 3 个「运行清单」）；成功后带回大纲', async () => {
    // §2 已由本线程认领（上面的用例）
    const dup = await toolError(
      call('edit_document', {
        doc_id: docId,
        op: 'insert_after_heading',
        heading: '2.1 细节',
        markdown: '## 3 实验\n\n重复的一节。',
      }),
    );
    expect(dup.message).toContain('重复标题「3 实验」');
    expect(store.get(docId)!.markdown).not.toContain('重复的一节。');

    // 整节替换时，被替换的标题和它的子标题本身不算重复
    const ok = await call('edit_document', {
      doc_id: docId,
      op: 'replace_section',
      heading: '2 方法',
      markdown: '## 2 方法\n\n重写。\n\n### 2.1 细节\n\n细节。',
    });
    expect(ok.ok).toBe(true);
    expect(ok.outline).toContain('## 2 方法');
    const md = store.get(docId)!.markdown;
    expect(md.match(/^## 2 方法$/gmu)).toHaveLength(1);
  });

  it('delete_section 删掉重复的小节（终验 R2 #3：删不掉自己造出的空标题）', async () => {
    const dupDoc = await call('create_document', {
      title: '消融计划',
      markdown:
        '## 8 方法\n\n方法。\n\n## 9 结果表\n\n## 9 结果表\n\n| a |\n| --- |\n| 1 |\n\n## 10 待补\n\n路径。',
    });
    const id = dupDoc.doc_id as string;
    await createClaim(t.app.ctx, tc.actor, project.id, {
      resourceKind: 'document',
      resourceRef: id,
      mode: 'exclusive',
      intent: '去掉重复小节',
      ttlSec: 1800,
      threadId: tc.thread!.id,
    });
    const ambiguous = await toolError(
      call('edit_document', { doc_id: id, op: 'delete_section', heading: '9 结果表' }),
    );
    expect(ambiguous.message).toContain('occurrence');
    const ok = await call('edit_document', {
      doc_id: id,
      op: 'delete_section',
      heading: '9 结果表',
      occurrence: 1,
    });
    expect(ok.ok).toBe(true);
    const after = store.get(id)!.markdown;
    expect(after.match(/^## 9 结果表$/gmu)).toHaveLength(1);
    expect(after).toContain('| 1 |');
    expect(after).toContain('## 10 待补');

    // 内容里自己重复标题也拒绝
    const selfDup = await toolError(
      call('edit_document', {
        doc_id: id,
        op: 'append',
        markdown: '## 11 新节\n\n甲\n\n## 11 新节\n\n乙',
      }),
    );
    expect(selfDup.message).toContain('重复标题「11 新节」');
  });
});

describe('write_file guard', () => {
  const path = 'outputs/survey/notes.md';

  it('new file needs no claim', async () => {
    const res = await call('write_file', { path, content: '第一版' });
    expect(res).toMatchObject({ ok: true, path, created: true });
    const read = await call('read_file', { path_or_id: path });
    expect(read).toMatchObject({ path, text: '第一版', truncated: false });
    const list = (await call('list_files', { dir: 'outputs' })).files as { path: string }[];
    expect(list.map((f) => f.path)).toContain(path);
  });

  it('overwrite without claim is refused; with claim succeeds', async () => {
    const err = await toolError(call('write_file', { path, content: '第二版' }));
    expect(err.details?.code).toBe('claim_required');
    await createClaim(t.app.ctx, tc.actor, project.id, {
      resourceKind: 'file',
      resourceRef: 'outputs/survey/**',
      mode: 'exclusive',
      intent: '更新调研笔记',
      ttlSec: 1800,
      threadId: tc.thread!.id,
    });
    const res = await call('write_file', { path, content: '第二版' });
    expect(res).toMatchObject({ created: false });
    expect((await call('read_file', { path_or_id: path })).text).toBe('第二版');
  });

  it("new file inside another holder's exclusive glob is refused", async () => {
    await createClaim(t.app.ctx, OTHER, project.id, {
      resourceKind: 'file',
      resourceRef: 'data/raw/**',
      mode: 'exclusive',
      intent: '清洗原始数据',
      ttlSec: 1800,
      threadId: 'thr_other',
    });
    const err = await toolError(call('write_file', { path: 'data/raw/new.csv', content: 'a,b' }));
    expect(err.details?.code).toBe('claim_conflict');
  });
});

describe('web tools', () => {
  it('fetch_url rejects loopback, private and non-http URLs', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://localhost:8787/api',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/',
      'file:///etc/passwd',
      'ftp://example.com/',
    ]) {
      const err = await toolError(call('fetch_url', { url }));
      expect(err.message).toMatch(/拒绝|只能抓取/u);
    }
  });

  it('isBlockedAddress', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('htmlToText strips scripts, styles and tags', () => {
    const { title, text } = htmlToText(
      '<html><head><title>GraphCL &amp; 对比</title><style>p{}</style></head><body>' +
        '<script>alert(1)</script><h1>标题</h1><p>第一段&nbsp;内容</p><p>第二段</p></body></html>',
    );
    expect(title).toBe('GraphCL & 对比');
    expect(text).toBe('标题\n第一段 内容\n第二段');
  });

  it('parseArxivAtom', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>http://arxiv.org/abs/2010.13902v3</id>
        <updated>2021-04-03T00:00:00Z</updated>
        <published>2020-10-22T00:00:00Z</published>
        <title>Graph Contrastive Learning
          with Augmentations</title>
        <summary>  We propose GraphCL &amp; more.  </summary>
        <author><name>Yuning You</name></author>
        <author><name>Tianlong Chen</name></author>
        <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.0000/x</arxiv:doi>
        <link href="http://arxiv.org/abs/2010.13902v3" rel="alternate" type="text/html"/>
        <link title="pdf" href="http://arxiv.org/pdf/2010.13902v3" rel="related" type="application/pdf"/>
        <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
      </entry></feed>`;
    const [e] = parseArxivAtom(xml);
    expect(e).toMatchObject({
      title: 'Graph Contrastive Learning with Augmentations',
      arxiv_id: '2010.13902v3',
      url: 'https://arxiv.org/abs/2010.13902v3',
      pdf_url: 'https://arxiv.org/pdf/2010.13902v3',
      published: '2020-10-22T00:00:00Z',
      authors: ['Yuning You', 'Tianlong Chen'],
      summary: 'We propose GraphCL & more.',
      doi: '10.0000/x',
      primary_category: 'cs.LG',
    });
  });
});
