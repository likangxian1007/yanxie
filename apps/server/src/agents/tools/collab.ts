import { inArray, eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ReviewTargetKind,
  TodoPriority,
  type ClaimMode,
  type ClaimResourceKind,
  type DocumentMeta,
  type WorkClaim,
} from '@srh/shared';
import { projectMembers, reviews, users } from '../../db/schema';
import { findConflicts, findCoveringClaim, type ClaimResource } from '../../modules/claims/service';
import { excerpt } from '../../modules/timeline/service';
import {
  collab,
  type AgentDocEdit,
  type DocumentKindName,
  type DocumentOutlineItem,
} from './collab-port';
import { agentViewer } from './viewer';
import {
  ALL_ROLES,
  defineTool,
  ToolError,
  WORKER_ROLES,
  type ToolContext,
  type ToolDef,
} from './types';

/**
 * 协作对象工具：文档、看板卡片、待办、审阅、组会汇报。
 * 实现全部经由协作端口（collab-port.ts）；端口没注册的部分，对应工具不出现在工具列表里。
 * 写入守卫（ARCHITECTURE.md §5.3.6）在这里做：edit_document / update_card
 * 必须持有覆盖该资源的有效认领，且没有别人的冲突认领。
 */

// ---------------------------------------------------------------- 认领写入守卫（files.ts 也用）

/** 给模型看的认领（精简） */
export async function claimViews(tc: ToolContext, claims: WorkClaim[]) {
  const ids = [...new Set(claims.map((c) => c.onBehalfOfUserId).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await tc.ctx.db.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));
    for (const r of rows) names.set(r.id, r.name);
  }
  return claims.map((c) => ({
    claim_id: c.id,
    resource_kind: c.resourceKind,
    resource_ref: c.resourceRef,
    mode: c.mode,
    holder: c.holder.name,
    holder_kind: c.holder.kind,
    thread_id: c.threadId,
    on_behalf_of: c.onBehalfOfUserId ? (names.get(c.onBehalfOfUserId) ?? c.onBehalfOfUserId) : null,
    intent: c.intent,
    expires_at: c.expiresAt,
  }));
}

export interface GuardOptions {
  /** 给模型看的资源名，如「文献综述」§2 */
  label: string;
  /** 没有认领时建议的认领方式 */
  suggestMode: ClaimMode;
  /** 也算覆盖的上级资源（例如父标题的小节认领覆盖子标题） */
  coverAlternatives?: ClaimResource[];
  /** 还要检查别人认领的关联资源（父标题、被整节替换的子标题） */
  related?: ClaimResource[];
}

/**
 * 写入守卫：本会话（或本线程）必须持有覆盖 resource 的有效认领，且关联资源上没有别人的冲突认领。
 * 不满足时抛 ToolError：code=claim_conflict（别人独占着）或 claim_required（还没认领）。
 */
export async function requireCoveringClaim(
  tc: ToolContext,
  resource: ClaimResource,
  opts: GuardOptions,
): Promise<WorkClaim> {
  const projectId = tc.project.id;
  const self = { holderId: tc.session.id, threadId: tc.thread?.id ?? null };
  let covering = await findCoveringClaim(tc.ctx, projectId, resource, self);
  for (const alt of opts.coverAlternatives ?? []) {
    if (covering) break;
    covering = await findCoveringClaim(tc.ctx, projectId, alt, self);
  }

  const mode: ClaimMode = covering?.mode ?? 'exclusive';
  const targets = [resource, ...(opts.related ?? [])].map((r) => ({ ...r, mode }));
  const conflicts = await findConflicts(tc.ctx, projectId, targets, self);
  const seen = new Set<string>();
  const others: WorkClaim[] = [];
  for (const c of conflicts.flatMap((x) => x.conflictsWith)) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    others.push(c);
  }

  const howToClaim = {
    resource_kind: resource.resourceKind,
    resource_ref: resource.resourceRef,
    mode: opts.suggestMode,
  };

  if (others.length > 0 && (covering || others.some((c) => c.mode === 'exclusive'))) {
    const first = others[0]!;
    throw new ToolError(
      `${opts.label}正被 ${first.holder.name} 认领（意图：${first.intent || '未写'}），不能编辑。` +
        '不要换个粒度绕过：先做不重叠的部分，或把改动写成建议稿交给持有者（经协调者），目标冲突时交给人决定。',
      { code: 'claim_conflict', claims: await claimViews(tc, others) },
    );
  }
  if (!covering) {
    throw new ToolError(
      `需要先认领${opts.label}才能编辑：先调 claim(resource_kind="${resource.resourceKind}", ` +
        `resource_ref="${resource.resourceRef}", mode="${opts.suggestMode}", intent, ttl_sec)，` +
        '认领成功后重读最新内容再编辑。',
      {
        code: 'claim_required',
        claim: howToClaim,
        ...(others.length > 0 ? { claims: await claimViews(tc, others) } : {}),
      },
    );
  }
  return covering;
}

// ---------------------------------------------------------------- Markdown 小工具

const DOC_CHARS = 30_000;
const EDIT_EXCERPT_CHARS = 1500;

interface HeadingLine {
  heading: string;
  level: number;
  start: number;
  /** 本节（含子标题）结束的字符位置 */
  end: number;
}

/** 解析 markdown 的 ATX 标题（跳过代码块），给出每节的字符区间 */
function headingLines(md: string): HeadingLine[] {
  const out: HeadingLine[] = [];
  let pos = 0;
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const trimmed = line.trimStart();
    const f = /^(`{3,}|~{3,})/u.exec(trimmed);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
    } else if (fence === null) {
      const m = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*\r?$/u.exec(line);
      if (m) out.push({ heading: m[2]!.trim(), level: m[1]!.length, start: pos, end: md.length });
    }
    pos += line.length + 1;
  }
  for (let i = 0; i < out.length; i++) {
    const h = out[i]!;
    const next = out.slice(i + 1).find((x) => x.level <= h.level);
    h.end = next ? next.start : md.length;
  }
  return out;
}

const sameHeading = (a: string, b: string) => a.trim() === b.trim();

function findSection(md: string, heading: string): { start: number; end: number } | null {
  const h = headingLines(md).find((x) => sameHeading(x.heading, heading));
  return h ? { start: h.start, end: h.end } : null;
}

/** 大纲里的上级标题与子标题 */
function relatives(outline: DocumentOutlineItem[], heading: string) {
  const i = outline.findIndex((o) => sameHeading(o.heading, heading));
  if (i < 0) return null;
  const self = outline[i]!;
  const ancestors: string[] = [];
  let level = self.level;
  for (let j = i - 1; j >= 0; j--) {
    const o = outline[j]!;
    if (o.level < level) {
      ancestors.push(o.heading);
      level = o.level;
    }
  }
  const descendants: string[] = [];
  for (let j = i + 1; j < outline.length && outline[j]!.level > self.level; j++) {
    descendants.push(outline[j]!.heading);
  }
  return { ancestors, descendants };
}

function windowAround(text: string, at: number, size = EDIT_EXCERPT_CHARS): string {
  if (text.length <= size) return text;
  const start = Math.max(0, Math.min(at - Math.floor(size / 3), text.length - size));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + size)}${start + size < text.length ? '…' : ''}`;
}

function docLink(id: string, title: string) {
  return `[${title || '未命名'}](#${id})`;
}

function docView(meta: DocumentMeta & { kind?: DocumentKindName }) {
  return {
    id: meta.id,
    title: meta.title,
    kind: meta.kind ?? 'doc',
    parent_id: meta.parentId,
    created_by: meta.createdBy.name,
    updated_by: meta.updatedBy?.name ?? null,
    updated_at: meta.updatedAt,
    archived: meta.archivedAt !== null,
  };
}

function need<T>(value: T | undefined | null, what: string, op: string): T {
  if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
    throw new ToolError(`op=${op} 需要参数 ${what}`);
  }
  return value;
}

function port<K extends Parameters<typeof collab>[0]>(key: K) {
  const p = collab(key);
  if (!p) throw new ToolError('协作模块还没启用，这个工具暂时不可用');
  return p;
}

const has = (key: Parameters<typeof collab>[0]) => () => Boolean(collab(key));

// ---------------------------------------------------------------- 参数

const DocKind = z.enum(['doc', 'sheet', 'slides', 'latex']);
const EditOp = z.enum([
  'append',
  'insert_after_heading',
  'replace_section',
  'replace_text',
  'delete_section',
  'set_cells',
  'append_slides',
  'replace_slides',
]);
const Slide = z.object({
  title: z.string().max(200),
  body: z.string().max(20_000),
  layout: z.enum(['title', 'content', 'two-column', 'section']).optional(),
});
const DueAt = z.string().nullable().optional().describe('截止时间，ISO 8601；null 清空');

// ---------------------------------------------------------------- 文档

const documentTools = [
  defineTool({
    name: 'list_documents',
    description:
      '列出你能访问的文档（id、标题、类型、摘要、更新时间、所在空间）。按名字找文档时先用它把名字解析成 doc_ id。' +
      '协调者和团队线程只看得到团队空间；个人工作区还能看到主人的个人空间和别人分享给主人的文档。',
    roles: ALL_ROLES,
    enabled: has('documents'),
    schema: z.object({}),
    async run(tc) {
      const list = await port('documents').list(tc.ctx, tc.project.id, await agentViewer(tc));
      return {
        documents: list
          .filter((d) => d.archivedAt === null)
          .map((d) => ({
            id: d.id,
            title: d.title,
            kind: d.kind ?? 'doc',
            excerpt: excerpt(d.excerpt, 120),
            updated_at: d.updatedAt,
            ...(d.space === 'personal' ? { space: 'personal' } : {}),
          })),
      };
    },
  }),

  defineTool({
    name: 'read_document',
    description:
      '读取文档：元信息、大纲（小节标题原文，doc_section 认领的 resource_ref 用它）和 markdown 正文。' +
      '传 section（标题原文）只读那一节（含子标题）。编辑前、编辑后都要重读。' +
      '幻灯片读取结果只有文字，不含位置和样式；表格（sheet）有多张工作表时，set_cells 用 sheet 指定写哪张。',
    roles: ALL_ROLES,
    enabled: has('documents'),
    schema: z.object({
      doc_id: z.string(),
      section: z.string().optional().describe('只读这一节：大纲里的标题原文'),
    }),
    async run(tc, args) {
      const doc = await port('documents').read(
        tc.ctx,
        tc.project.id,
        args.doc_id,
        await agentViewer(tc),
      );
      let md = doc.markdown;
      if (args.section) {
        const range = findSection(md, args.section);
        if (!range) {
          throw new ToolError(`文档里没有标题「${args.section}」`, {
            outline: doc.outline.map((o) => o.heading),
          });
        }
        md = md.slice(range.start, range.end);
      }
      const truncated = md.length > DOC_CHARS;
      return {
        meta: docView(doc.meta),
        outline: doc.outline,
        ...(args.section ? { section: args.section } : {}),
        markdown: truncated ? md.slice(0, DOC_CHARS) : md,
        ...(truncated
          ? {
              truncated: true,
              note: `正文共 ${md.length} 字，只返回前 ${DOC_CHARS} 字。用 section 参数按小节读取其余部分。`,
            }
          : {}),
      };
    },
  }),

  defineTool({
    name: 'create_document',
    description:
      '新建一份项目文档（不需要认领）。kind：doc 正文（默认）/ sheet 表格 / slides 幻灯片 / latex 源码。' +
      '返回 doc_id 和可直接放进回复的链接。',
    roles: WORKER_ROLES,
    enabled: has('documents'),
    schema: z.object({
      title: z.string().trim().min(1).max(120),
      markdown: z.string().max(500_000).optional().describe('初始内容（markdown）'),
      kind: DocKind.optional(),
      parent_id: z.string().optional().describe('父文档 id（放在某文档下面）'),
      space: z
        .enum(['team', 'personal'])
        .optional()
        .describe('建在哪：team 团队空间（默认）；personal 主人的个人空间（只在个人工作区可用）'),
    }),
    async run(tc, args) {
      const viewer = await agentViewer(tc);
      if (args.space === 'personal' && !viewer.userId) {
        throw new ToolError('协调者和团队线程只能在团队空间新建文档');
      }
      const meta = await port('documents').create(
        tc.ctx,
        tc.actor,
        tc.project.id,
        {
          title: args.title,
          parentId: args.parent_id ?? null,
          ...(args.markdown !== undefined ? { markdown: args.markdown } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.space ? { space: args.space } : {}),
        },
        viewer,
      );
      return {
        ok: true,
        doc_id: meta.id,
        title: meta.title,
        kind: args.kind ?? 'doc',
        link: docLink(meta.id, meta.title),
      };
    },
  }),

  defineTool({
    name: 'edit_document',
    description:
      '编辑文档（必须先认领，否则被拒）。op：append 末尾追加（认领 document，shared 即可）；' +
      'insert_after_heading 在标题下插入 / replace_section 整节替换（认领 doc_section「doc_id#标题原文」或整篇）；' +
      'replace_text 精确替换一小段（find→replace；带 heading 时只认该节、find 必须只出现在该节里，否则需认领整篇）。' +
      'find 照抄 read_document 读出的 markdown 即可，可以包含标题行「## 标题」和跨段落的内容；replace 里用空行分段，会成为独立的新段落；' +
      '同样的原文出现多次时用 occurrence（1 起）指定第几处；replace 为空串即删除。' +
      'delete_section 删除整个小节（标题行连同正文、子标题；heading 必填，有同名小节时用 occurrence 指定第几个）。' +
      'set_cells 写表格单元格（sheet）；append_slides / replace_slides 幻灯片。heading 用 read_document 大纲里的原文。',
    roles: WORKER_ROLES,
    enabled: has('documents'),
    schema: z.object({
      doc_id: z.string(),
      op: EditOp,
      heading: z
        .string()
        .optional()
        .describe('小节标题原文（insert_after_heading / replace_section 必填）'),
      markdown: z
        .string()
        .max(200_000)
        .optional()
        .describe('append / insert_after_heading / replace_section 的内容'),
      find: z.string().optional().describe('replace_text：要替换的原文（逐字）'),
      replace: z.string().optional().describe('replace_text：替换成的文字'),
      occurrence: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'replace_text / delete_section：同样的原文或同名小节出现多次时，改第几处（1 起）',
        ),
      cells: z
        .array(z.object({ ref: z.string().describe('如 B3'), value: z.string() }))
        .max(2000)
        .optional(),
      sheet: z.string().optional().describe('set_cells：工作表名，默认第一个'),
      slides: z.array(Slide).max(100).optional(),
      reason: z
        .string()
        .max(1000)
        .optional()
        .describe('为什么这样改，一两句话；改动需要审阅时作为提案说明给审阅人看'),
    }),
    async run(tc, args) {
      const docs = port('documents');
      const { op } = args;

      // 1) 参数校验 → 端口的 edit
      let edit: AgentDocEdit;
      switch (op) {
        case 'append':
          edit = { op, markdown: need(args.markdown, 'markdown', op) };
          break;
        case 'insert_after_heading':
        case 'replace_section':
          edit = {
            op,
            heading: need(args.heading, 'heading', op).trim(),
            markdown: need(args.markdown, 'markdown', op),
          };
          break;
        case 'replace_text':
          edit = {
            op,
            find: need(args.find, 'find', op),
            replace: args.replace ?? '',
            ...(args.occurrence ? { occurrence: args.occurrence } : {}),
          };
          break;
        case 'delete_section':
          need(args.heading, 'heading', op);
          // 读到文档后再换算成 replace_text（见下）
          edit = { op: 'replace_text', find: '', replace: '' };
          break;
        case 'set_cells':
          if (!args.cells?.length) throw new ToolError('op=set_cells 需要参数 cells（至少一个）');
          edit = { op, cells: args.cells, ...(args.sheet ? { sheet: args.sheet } : {}) };
          break;
        case 'append_slides':
        case 'replace_slides':
          if (!args.slides?.length) throw new ToolError(`op=${op} 需要参数 slides（至少一张）`);
          edit = { op, slides: args.slides };
          break;
      }

      // 2) 读最新内容，核对标题 / 文档类型 / find
      const viewer = await agentViewer(tc);
      const doc = await docs.read(tc.ctx, tc.project.id, args.doc_id, viewer);
      const kind = doc.meta.kind ?? 'doc';
      if (op === 'set_cells' && kind !== 'sheet') {
        throw new ToolError(
          `「${doc.meta.title}」是 ${kind} 文档，set_cells 只能用于表格（sheet）`,
        );
      }
      if ((op === 'append_slides' || op === 'replace_slides') && kind !== 'slides') {
        throw new ToolError(`「${doc.meta.title}」是 ${kind} 文档，${op} 只能用于幻灯片（slides）`);
      }
      if (op === 'delete_section' && kind !== 'doc') {
        throw new ToolError(
          `delete_section 只能用于正文文档（doc），「${doc.meta.title}」是 ${kind}`,
        );
      }
      const sectionOp =
        op === 'insert_after_heading' ||
        op === 'replace_section' ||
        op === 'delete_section' ||
        (op === 'replace_text' && !!args.heading?.trim());
      const heading = sectionOp ? args.heading!.trim() : null;
      let rel: { ancestors: string[]; descendants: string[] } | null = null;
      if (heading) {
        rel = relatives(doc.outline, heading);
        if (!rel) {
          throw new ToolError(`文档里没有标题「${heading}」，heading 要用大纲里的原文`, {
            outline: doc.outline.map((o) => o.heading),
          });
        }
      }
      if (op === 'delete_section' && heading) {
        // 同名小节（重复标题）可能有好几个：按 occurrence 选，删掉标题行 + 正文 + 子标题
        const same = headingLines(doc.markdown).filter((h) => sameHeading(h.heading, heading));
        if (same.length > 1 && !args.occurrence) {
          throw new ToolError(
            `文档里有 ${same.length} 个「${heading}」小节，用 occurrence 指定删第几个（1 起，按出现顺序）`,
          );
        }
        const target = same[(args.occurrence ?? 1) - 1];
        if (!target) throw new ToolError(`文档里只有 ${same.length} 个「${heading}」小节`);
        const find = doc.markdown.slice(target.start, target.end).replace(/\s+$/u, '');
        let nth = 1;
        for (let at = doc.markdown.indexOf(find); at >= 0 && at < target.start;) {
          nth += 1;
          at = doc.markdown.indexOf(find, at + 1);
        }
        edit = { op: 'replace_text', find, replace: '', ...(nth > 1 ? { occurrence: nth } : {}) };
      } else if (edit.op === 'replace_text') {
        // 精确预检只用来做「是否在本节内」「occurrence 是否越界」的判断；
        // 没精确命中时交给服务层（它会容忍格式标记、空白差异，并在 not_found 时给出最相近的片段）
        const all = [...doc.markdown.matchAll(new RegExp(escapeRegExp(edit.find), 'gu'))];
        if (all.length && edit.occurrence && edit.occurrence > all.length) {
          throw new ToolError(
            `find 的原文在文档里只出现了 ${all.length} 次，occurrence 不能是 ${edit.occurrence}`,
          );
        }
        if (heading && all.length) {
          const range = findSection(doc.markdown, heading);
          const outside = all.some((m) => !range || m.index < range.start || m.index >= range.end);
          if (outside) {
            throw new ToolError(
              `find 的原文在「${heading}」之外也出现了（或不在这一节里）。给 find 多带几个字让它只匹配这一节，或认领整篇文档后不带 heading 替换`,
            );
          }
        }
      }

      // 2.5) 不许写出重复标题（验收：LGTM 后连改 21 次，文档里出现 3 个「## 3. 运行清单」）
      if (
        edit.op === 'append' ||
        edit.op === 'insert_after_heading' ||
        edit.op === 'replace_section'
      ) {
        const replaced = new Set<string>();
        if (edit.op === 'replace_section') {
          replaced.add(edit.heading);
          rel?.descendants.forEach((d) => replaced.add(d));
        }
        const existing = new Set(
          doc.outline.map((o) => o.heading.trim()).filter((h) => !replaced.has(h)),
        );
        const written = [...edit.markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)].map((m) =>
          m[1]!.trim(),
        );
        // replace_section / insert_after_heading 的内容以这一节自己的标题开头时，服务端会去掉它；
        // 其余位置再出现同名标题、或内容里自己重复，都会造出重复标题
        if (
          (edit.op === 'replace_section' || edit.op === 'insert_after_heading') &&
          written[0] !== undefined &&
          sameHeading(written[0], edit.heading) &&
          /^\s*#{1,6}\s/u.test(edit.markdown)
        ) {
          written.shift();
        }
        const seen = new Set<string>();
        const dup = written.filter((h) => {
          const d =
            existing.has(h) ||
            seen.has(h) ||
            (edit.op === 'replace_section' && sameHeading(h, edit.heading));
          seen.add(h);
          return d;
        });
        if (dup.length) {
          throw new ToolError(
            `这次写入会让文档出现重复标题「${dup[0]}」。要改那一节就用 replace_section（heading=「${dup[0]}」）整节替换；要改名就在替换那一节时连标题一起写新名字。先 read_document 看最新大纲。`,
            { outline: doc.outline.map((o) => o.heading) },
          );
        }
      }

      // 3) 写入守卫
      const sectionRef = (h: string) => ({
        resourceKind: 'doc_section' as ClaimResourceKind,
        resourceRef: `${args.doc_id}#${h}`,
      });
      const title = doc.meta.title || args.doc_id;
      if (heading && rel) {
        await requireCoveringClaim(tc, sectionRef(heading), {
          label: `「${title}」的「${heading}」一节`,
          suggestMode: 'exclusive',
          coverAlternatives: rel.ancestors.map(sectionRef),
          related: [
            ...rel.ancestors.map(sectionRef),
            ...(op === 'replace_section' || op === 'delete_section'
              ? rel.descendants.map(sectionRef)
              : []),
          ],
        });
      } else {
        await requireCoveringClaim(
          tc,
          { resourceKind: 'document', resourceRef: args.doc_id },
          {
            label: `整篇「${title}」`,
            suggestMode: op === 'append' || op === 'append_slides' ? 'shared' : 'exclusive',
          },
        );
      }

      // 4) 写入，返回改动附近的内容
      const res = await docs.applyEdit(tc.ctx, tc.actor, tc.project.id, args.doc_id, edit, {
        reason: args.reason,
        viewer,
      });
      const md = res.markdown;
      let around: string;
      switch (edit.op) {
        case 'append':
        case 'append_slides':
          around = md.length > EDIT_EXCERPT_CHARS ? `…${md.slice(-EDIT_EXCERPT_CHARS)}` : md;
          break;
        case 'replace_text': {
          const at = edit.replace ? md.indexOf(edit.replace) : -1;
          around = windowAround(md, Math.max(0, at));
          break;
        }
        case 'insert_after_heading':
        case 'replace_section': {
          const range = findSection(md, edit.heading);
          const at = range ? range.start : Math.max(0, md.indexOf(edit.markdown.slice(0, 80)));
          around = windowAround(md, at + EDIT_EXCERPT_CHARS / 3);
          break;
        }
        default:
          around = windowAround(md, 0);
      }
      // 带回最新大纲：下一次编辑直接用这里的标题原文，不用再猜
      const outline = [...md.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gmu)].map(
        (m) => `${m[1]} ${m[2]!.trim()}`,
      );
      return {
        ok: true,
        doc_id: args.doc_id,
        title: res.meta.title,
        excerpt: around,
        ...(kind === 'doc' || kind === 'latex' ? { outline: outline.slice(0, 80) } : {}),
        // 版本管理：改动存成了改动提案（正文未变），告诉模型
        ...(res.notice ? { notice: res.notice, proposal_id: res.proposalId } : {}),
      };
    },
  }),
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const boardTools = [
  defineTool({
    name: 'create_card',
    description:
      '在看板上建一张卡片（不需要认领）。不传 board_id / column_id 时放进默认看板的第一列。',
    roles: ALL_ROLES,
    enabled: has('boards'),
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(20_000).optional(),
      board_id: z.string().optional(),
      column_id: z.string().optional(),
      assignee_ids: z.array(z.string()).max(20).optional().describe('成员 user id'),
      labels: z.array(z.string().max(20)).max(10).optional(),
      due_at: DueAt,
    }),
    async run(tc, args) {
      const card = await port('boards').createCard(tc.ctx, tc.actor, tc.project.id, {
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.board_id ? { boardId: args.board_id } : {}),
        ...(args.column_id ? { columnId: args.column_id } : {}),
        ...(args.assignee_ids ? { assigneeIds: args.assignee_ids } : {}),
        ...(args.labels ? { labels: args.labels } : {}),
        ...(args.due_at !== undefined ? { dueAt: args.due_at } : {}),
      });
      return {
        ok: true,
        card_id: card.id,
        board_id: card.boardId,
        column_id: card.columnId,
        version: card.version,
        link: docLink(card.id, card.title),
      };
    },
  }),

  defineTool({
    name: 'update_card',
    description:
      '修改看板卡片（必须先认领 card，否则被拒）：标题、描述、移动到某列、指派人、标签、截止时间、关联线程。带 base_version（卡片的 version）。',
    roles: WORKER_ROLES,
    enabled: has('boards'),
    schema: z.object({
      card_id: z.string(),
      base_version: z.number().int(),
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(20_000).optional(),
      column_id: z.string().optional().describe('移到这一列'),
      assignee_ids: z.array(z.string()).max(20).optional(),
      labels: z.array(z.string().max(20)).max(10).optional(),
      due_at: DueAt,
    }),
    async run(tc, args) {
      await requireCoveringClaim(
        tc,
        { resourceKind: 'card', resourceRef: args.card_id },
        { label: `卡片 ${args.card_id}`, suggestMode: 'exclusive' },
      );
      const card = await port('boards').updateCard(tc.ctx, tc.actor, tc.project.id, args.card_id, {
        baseVersion: args.base_version,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.column_id !== undefined ? { columnId: args.column_id } : {}),
        ...(args.assignee_ids !== undefined ? { assigneeIds: args.assignee_ids } : {}),
        ...(args.labels !== undefined ? { labels: args.labels } : {}),
        ...(args.due_at !== undefined ? { dueAt: args.due_at } : {}),
        ...(tc.thread?.kind === 'project' ? { threadId: tc.thread.id } : {}),
      });
      return { ok: true, card_id: card.id, version: card.version, column_id: card.columnId };
    },
  }),
];

const todoTools = [
  defineTool({
    name: 'create_todo',
    description:
      '建一条待办（不需要认领）。指派给别人只在成员明确说了或 brief 写了时做。personal=true 为个人待办（个人会话里默认 true）。',
    roles: ALL_ROLES,
    enabled: has('todos'),
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      notes: z.string().max(5000).optional(),
      assignee_id: z.string().optional().describe('成员 user id'),
      priority: TodoPriority.optional(),
      due_at: DueAt,
      personal: z.boolean().optional(),
    }),
    async run(tc, args) {
      const personal = args.personal ?? tc.session.role === 'personal';
      const assigneeId =
        args.assignee_id ?? (personal ? tc.session.workingForUserId : null) ?? null;
      const todo = await port('todos').create(tc.ctx, tc.actor, tc.project.id, {
        title: args.title,
        personal,
        assigneeId,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.due_at !== undefined ? { dueAt: args.due_at } : {}),
      });
      return {
        ok: true,
        todo_id: todo.id,
        personal,
        assignee_id: todo.assigneeId,
        link: docLink(todo.id, todo.title),
      };
    },
  }),
];

// ---------------------------------------------------------------- 审阅与汇报

const reviewTools = [
  defineTool({
    name: 'request_review',
    description:
      '请求审阅。target_kind=plan 时 target_id 是承载计划的消息或文档 id。summary ≤ 5 行，能脱离聊天独立读懂。' +
      'reviewer_ids 是成员的 user id（导师见记忆或成员列表里的 advisor）。要求修改后重新提交 = 再调一次。',
    roles: ALL_ROLES,
    enabled: has('reviews'),
    schema: z.object({
      target_kind: ReviewTargetKind.exclude(['experiment']),
      target_id: z.string().min(1),
      title: z.string().trim().min(1).max(120),
      summary: z.string().max(10_000).optional(),
      reviewer_ids: z.array(z.string()).min(1).max(10),
    }),
    async run(tc, args) {
      const members = await tc.ctx.db.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, tc.project.id),
            inArray(projectMembers.userId, args.reviewer_ids),
          ),
        );
      const known = new Set(members.map((m) => m.userId));
      const unknown = args.reviewer_ids.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new ToolError(
          `这些 reviewer_ids 不是项目成员：${unknown.join(', ')}。先 list_members 查 user id`,
        );
      }
      const reviewsPort = port('reviews');
      // 同一对象上这个 agent 之前发起、还没结束的审阅：新一轮送审后关掉（验收：旧审阅一直开着，导师分不清）
      const previous = await tc.ctx.db.db
        .select({ id: reviews.id })
        .from(reviews)
        .where(
          and(
            eq(reviews.projectId, tc.project.id),
            eq(reviews.targetKind, args.target_kind),
            eq(reviews.targetId, args.target_id),
            inArray(reviews.status, ['open', 'changes_requested']),
            sql`${reviews.requestedBy}->>'id' = ${tc.session.id}`,
          ),
        );
      const review = await reviewsPort.create(tc.ctx, tc.actor, tc.project.id, {
        targetKind: args.target_kind,
        targetId: args.target_id,
        title: args.title,
        reviewerIds: args.reviewer_ids,
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...(tc.thread ? { threadId: tc.thread.id } : {}),
      });
      const superseded: string[] = [];
      if (reviewsPort.close) {
        for (const p of previous) {
          await reviewsPort
            .close(tc.ctx, tc.actor, tc.project.id, p.id)
            .then(() => superseded.push(p.id))
            .catch(() => undefined);
        }
      }
      return {
        ok: true,
        review_id: review.id,
        status: review.status,
        link: docLink(review.id, review.title),
        ...(superseded.length
          ? { superseded_reviews: superseded, note: '同一对象的旧审阅已关闭，以这一条为准' }
          : {}),
      };
    },
  }),

  defineTool({
    name: 'draft_report',
    description:
      '生成组会汇报草稿。服务器会把这段时间的时间线、线程、研究空间与实际运行、审阅、文档变更、待办整理好交给汇报生成器。' +
      'period_start / period_end 用 ISO 日期；instructions 只放成员对汇报的要求，没有就不传。返回 report_id。',
    roles: ['coordinator'],
    enabled: has('reports'),
    schema: z.object({
      period_start: z.string().describe('开始日期，如 2026-10-20'),
      period_end: z.string().describe('结束日期，如 2026-10-26'),
      title: z.string().trim().max(120).optional(),
      instructions: z.string().max(2000).optional(),
    }),
    async run(tc, args) {
      const start = Date.parse(args.period_start);
      const end = Date.parse(args.period_end);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new ToolError('period_start / period_end 要用 ISO 日期，例如 2026-10-20');
      }
      if (start > end) throw new ToolError('period_start 不能晚于 period_end');
      const report = await port('reports').draft(tc.ctx, tc.actor, tc.project.id, {
        periodStart: args.period_start,
        periodEnd: args.period_end,
        generate: true,
        ...(args.title ? { title: args.title } : {}),
        ...(args.instructions ? { instructions: args.instructions } : {}),
      });
      return {
        ok: true,
        report_id: report.id,
        status: report.status,
        title: report.title,
        link: docLink(report.id, report.title),
      };
    },
  }),
];

export const collabTools: ToolDef[] = [
  ...documentTools,
  ...boardTools,
  ...todoTools,
  ...reviewTools,
];
