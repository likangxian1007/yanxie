import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Plus, Send, Trash2 } from 'lucide-react';
import {
  NOTIFY_DEFAULT_EVENTS,
  NOTIFY_EVENTS,
  NOTIFY_PROVIDERS,
  type NotifyDelivery,
  type NotifyOverview,
  type NotifyProvider,
  type NotifySubscription,
} from '@srh/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Switch,
  toast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { useMe } from '@/lib/session';
import { errorMessage } from '../lib';
import {
  ConfirmDialog,
  ErrorCard,
  Field,
  InlineError,
  SectionSkeleton,
  SettingsCard,
} from './parts';
import { locale, tr } from '@/lib/i18n';

/**
 * 设置 → 通知：群机器人订阅（飞书 / 企业微信 / 钉钉）。
 *
 * 用户粘贴群机器人地址，项目里有事时平台推一条纯文本过去。
 * 地址里带密钥，所以列表只显示打码版（`urlHint`）；原文只在保存时用一次。
 */
const EVENT_LABEL: Record<string, string> = {
  'inbox.created': tr('有人 @ 我 / 请我审阅 / 决策卡 / 认领冲突'),
  'message.created': tr('有新消息'),
  'thread.updated': tr('线程有新进展'),
  'decision.updated': tr('决策卡状态变化'),
  'review.updated': tr('审阅状态变化'),
  'claim.conflict': tr('认领冲突'),
  'report.updated': tr('汇报更新'),
};

const PROVIDER_HINT: Record<NotifyProvider, string> = {
  feishu: tr('飞书群 → 设置 → 群机器人 → 添加 → 自定义机器人 → 复制它给的网址'),
  wecom: tr('群设置 → 群机器人 → 添加 → 复制它给的 Webhook 地址（qyapi.weixin.qq.com 开头）'),
  dingtalk: tr('群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制 Webhook 地址'),
};

export function NotifySection() {
  const qc = useQueryClient();
  const me = useMe();
  const overview = useQuery({
    queryKey: qk.notify,
    queryFn: ({ signal }) => api.get<NotifyOverview>('/auth/me/notify', { signal }),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<NotifySubscription | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<NotifySubscription | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/me/notify/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notify });
      setDeleting(null);
      toast.success(tr('已删除这个通知订阅'));
    },
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; message: string }>(`/auth/me/notify/${id}/test`),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.notify });
      if (res.ok) toast.success(tr('已发出'), res.message);
      else toast.error(tr('发送失败'), res.message);
    },
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api.patch(`/auth/me/notify/${v.id}`, { enabled: v.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notify }),
  });

  const enabled = overview.data?.enabled ?? false;

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard
        title={tr('群机器人通知')}
        description={tr(
          '把通知推到你自己的飞书 / 企业微信 / 钉钉群。只发事件说明和链接，不发正文——正文要登录才能看。',
        )}
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
            disabled={!enabled}
            onClick={() => setCreateOpen(true)}
          >
            {tr('新建订阅')}
          </Button>
        }
      >
        {!overview.isPending && !enabled && (
          <p className="mb-4 rounded-md border border-line bg-subtle p-3 text-small text-fg-muted">
            {tr('服务器还没打开这个功能：在部署的 ')}
            <code className="font-mono">.env</code>
            {tr(' 里设')} <code className="font-mono">NOTIFY_ENABLED=true</code>
            {tr(' 并重启后，才能新建订阅。')}
          </p>
        )}

        {overview.isPending ? (
          <SectionSkeleton rows={2} />
        ) : overview.isError ? (
          <ErrorCard error={overview.error} onRetry={() => void overview.refetch()} />
        ) : overview.data.subscriptions.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={tr('还没有通知订阅')}
            description={tr('建一个订阅，把群机器人地址填进来，项目里有事群里就会响。')}
            className="py-8"
          />
        ) : (
          <ul
            aria-label={tr('通知订阅列表')}
            className="-mx-4 flex flex-col divide-y divide-line border-t border-line"
          >
            {overview.data.subscriptions.map((s) => (
              <SubscriptionRow
                key={s.id}
                sub={s}
                onDelete={() => setDeleting(s)}
                onTest={() => test.mutate(s.id)}
                onToggle={(v) => toggle.mutate({ id: s.id, enabled: v })}
                onShowDeliveries={() => setDeliveriesFor(s)}
                testing={test.isPending && test.variables === s.id}
              />
            ))}
          </ul>
        )}
      </SettingsCard>

      <CreateSubscriptionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={me.data?.projects ?? []}
        onCreated={() => {
          setCreateOpen(false);
          void qc.invalidateQueries({ queryKey: qk.notify });
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={tr('删除这个通知订阅？')}
        description={
          deleting
            ? tr('「{name}」删掉后就不再往这个群推送了。', { name: deleting.name })
            : undefined
        }
        confirmLabel={tr('删除')}
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />

      <DeliveriesDialog sub={deliveriesFor} onClose={() => setDeliveriesFor(null)} />

      <NotifyHelp />
    </div>
  );
}

/**
 * 「如何配置」折叠说明。
 *
 * 按「平台 × 机器人类型」组织：自定义机器人（群 Webhook，本版支持）和应用机器人
 * （单聊/群聊按 open_id/chat_id，**本版未实现**）必须分开讲，不能共用"复制一个地址"的指引。
 * 安全设置那段是重点：我们没实现签名校验，用户开了会一直失败。
 */
function NotifyHelp() {
  return (
    <details className="group rounded-lg border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-body font-medium text-fg marker:hidden">
        <span className="transition-transform group-open:rotate-90" aria-hidden>
          ▸
        </span>
        {tr('如何配置')}
      </summary>
      <div className="flex flex-col gap-4 border-t border-line px-4 py-4 text-small text-fg-muted">
        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-fg">{tr('① 先确认要接哪种机器人')}</h3>
          <p>
            {tr('添加机器人需要你是')}
            <span className="text-fg">{tr('这个群的管理员')}</span>
            {tr(
              '（普通成员在群设置里看不到 「添加机器人」）。不需要在飞书管理后台建企业应用，也不需要开发者权限，群管理员身份就够了。',
            )}
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>
              <span className="text-fg">{tr('自定义机器人（群 Webhook）')}</span> ——{' '}
              <span className="text-success">{tr('本版支持')}</span>
              {tr('。只能往它所在的那一个群推送。')}
            </li>
            <li>
              <span className="text-fg">{tr('应用机器人（企业自建应用）')}</span> ——{' '}
              <span className="text-warning">{tr('本版未支持')}</span>
              {tr(
                '。它支持单聊、按群聊发，但需要 app_id / app_secret 换令牌，还要配接收目标（open_id / chat_id），按当前范围不做。',
              )}
            </li>
          </ul>
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-fg">{tr('② 三家平台的入口')}</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>
              <span className="text-fg">{tr('飞书')}</span>
              {tr('：群 → 右上角设置 → 群机器人 → 添加 →')}{' '}
              <span className="text-fg">{tr('自定义机器人')}</span>
              {tr(
                ' → 复制它给的 Webhook 地址。 看不到「自定义机器人」＝企业关了这个能力，找管理员开。',
              )}
            </li>
            <li>
              <span className="text-fg">{tr('企业微信')}</span>
              {tr('：群 → 右上角设置 → 群机器人 → 添加 → 复制 Webhook 地址。')}
            </li>
            <li>
              <span className="text-fg">{tr('钉钉')}</span>
              {tr('：群 → 设置 → 智能群助手 → 添加机器人 → 自定义 → 复制 Webhook 地址。')}
            </li>
          </ul>
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-fg">{tr('③ 安全设置怎么填（最容易踩坑的一步）')}</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>
              <span className="text-fg">{tr('自定义关键词')}</span>
              {tr('：填')} <code className="rounded bg-subtle px-1 font-mono">{tr('研协')}</code>
              {tr('。我们所有消息都以「【研协 Thinkloft】」开头，填别的关键词会导致全部发送失败。')}
            </li>
            <li>
              <span className="text-fg">{tr('IP 白名单')}</span>
              {tr('：填')}
              <span className="text-fg">{tr('服务器')}</span>
              {tr('的出站公网 IP（找管理员要），不是你自己的电脑 IP。')}
            </li>
            <li>
              <span className="text-fg">{tr('签名校验')}</span>
              {tr('：')} <span className="text-warning">{tr('本版没实现')}</span>
              {tr('，开了会一直发送失败。请改用关键词或 IP 白名单。')}
            </li>
          </ul>
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-fg">{tr('④ 配完怎么验')}</h3>
          <ol className="flex list-decimal flex-col gap-1 pl-5">
            <li>{tr('保存订阅（填地址时会校验域名，不是官方域名会被拒绝）')}</li>
            <li>{tr('点这行的「发测试」')}</li>
            <li>{tr('去群里确认收到「【研协 Thinkloft】这是一条测试消息…」')}</li>
            <li>
              {tr('回到这里点「投递记录」，看状态是 success 还是 failed（失败会写平台返回的原因）')}
            </li>
          </ol>
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-fg">{tr('⑤ 收不到时对照')}</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>{tr('关键词不匹配 → 检查是否填了「研协」（飞书返回 19024 一类错误码）')}</li>
            <li>{tr('开了签名校验 → 平台返回签名错误；本版不支持，关掉改用关键词')}</li>
            <li>{tr('IP 不在白名单 → 把服务器的出站公网 IP 加进去')}</li>
            <li>{tr('机器人被删/失效 → 平台提示 token 无效，重新添加机器人换地址')}</li>
            <li>
              {tr(
                '被限流 → 飞书 100 次/分钟、企业微信和钉钉 20 次/分钟；我们失败后会退避重试（1 分钟起）',
              )}
            </li>
          </ul>
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-fg">{tr('⑥ 你需要知道的边界')}</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>
              {tr('默认只推「收件箱」类事件（@ 我、请我审阅、决策卡、认领冲突），其它事件要手动勾')}
            </li>
            <li>
              <span className="text-fg">{tr('通知发到群里，群里所有人都能看到')}</span>
              {tr('；所以只发事件说明和链接，不带正文片段')}
            </li>
            <li>{tr('旁聊、个人线程、别人的收件箱永远不会外发；被移出项目后待发的也会终止')}</li>
            <li>{tr('「新建订阅」是灰的＝服务器没开这个功能，找管理员开 NOTIFY_ENABLED')}</li>
          </ul>
        </section>
      </div>
    </details>
  );
}

function SubscriptionRow({
  sub,
  onDelete,
  onTest,
  onToggle,
  onShowDeliveries,
  testing,
}: {
  sub: NotifySubscription;
  onDelete: () => void;
  onTest: () => void;
  onToggle: (v: boolean) => void;
  onShowDeliveries: () => void;
  testing: boolean;
}) {
  const providerLabel = NOTIFY_PROVIDERS[sub.provider].label;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-subtle text-fg-muted ring-1 ring-line">
        <Bell size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <div className="min-w-0 flex-1 basis-52">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-body font-medium text-fg">{sub.name}</span>
          <Badge tone="neutral">{providerLabel}</Badge>
          {!sub.enabled && <Badge tone="warning">{sub.disabledReason ?? tr('已停用')}</Badge>}
          {sub.failureStreak > 0 && sub.enabled && (
            <Badge tone="warning">
              {tr('连续失败 {failureStreak} 次', { failureStreak: sub.failureStreak })}
            </Badge>
          )}
        </div>
        <p className="truncate font-mono text-caption text-fg-subtle">{sub.urlHint}</p>
        <p className="truncate text-caption text-fg-subtle">
          {sub.eventTypes.map((e) => EVENT_LABEL[e] ?? e).join(tr('、'))}
          {sub.lastSuccessAt
            ? tr(' · 上次成功：{value}', {
                value: new Date(sub.lastSuccessAt).toLocaleString(locale()),
              })
            : tr(' · 还没成功过')}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="secondary" size="sm" loading={testing} onClick={onTest}>
          {tr('发测试')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onShowDeliveries}>
          {tr('记录')}
        </Button>
        <Switch checked={sub.enabled} onCheckedChange={onToggle} label={tr('启用')} />
        <IconButton label={tr('删除 {name}', { name: sub.name })} size="sm" onClick={onDelete}>
          <Trash2 strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>
    </li>
  );
}

function CreateSubscriptionDialog({
  open,
  onOpenChange,
  projects,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: { id: string; name: string }[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<NotifyProvider>('feishu');
  const [url, setUrl] = useState('');
  const [projectId, setProjectId] = useState('');
  const [events, setEvents] = useState<string[]>(NOTIFY_DEFAULT_EVENTS);
  const [touched, setTouched] = useState(false);

  const nameError = name.trim() ? undefined : tr('请给这个订阅起个名字，例如「实验室群」');
  const urlError = url.trim() ? undefined : tr('请粘贴群机器人地址');

  const create = useMutation({
    mutationFn: () =>
      api.post<NotifySubscription>('/auth/me/notify', {
        name: name.trim(),
        provider,
        url: url.trim(),
        projectId: projectId || null,
        eventTypes: events.length > 0 ? events : NOTIFY_DEFAULT_EVENTS,
      }),
    onSuccess: () => {
      onCreated();
      setName('');
      setUrl('');
      setProjectId('');
      setEvents(NOTIFY_DEFAULT_EVENTS);
      setTouched(false);
      toast.success(tr('订阅已创建'), tr('点「发测试」验证一下能不能收到'));
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr('新建通知订阅')}
      description={tr('粘贴群机器人的 Webhook 地址。地址里带密钥，保存后只显示打码版。')}
      size="md"
      footer={
        <>
          {create.isError && <InlineError>{errorMessage(create.error)}</InlineError>}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => {
              setTouched(true);
              if (!nameError && !urlError) create.mutate();
            }}
          >
            {tr('保存')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={tr('名字')} hint={tr('只给你自己看，用来区分不同的群')}>
          <Input
            value={name}
            maxLength={40}
            placeholder={tr('实验室通知群')}
            error={touched ? nameError : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field label={tr('平台')}>
          <Select
            value={provider}
            onChange={(e) => setProvider(e.target.value as NotifyProvider)}
            options={Object.entries(NOTIFY_PROVIDERS).map(([value, spec]) => ({
              value,
              label: spec.label,
            }))}
          />
        </Field>

        <Field label={tr('群机器人地址')} hint={PROVIDER_HINT[provider]}>
          <Input
            value={url}
            placeholder={`https://${NOTIFY_PROVIDERS[provider].host}${NOTIFY_PROVIDERS[provider].pathPrefix}…`}
            error={touched ? urlError : undefined}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>

        <Field label={tr('接收哪个项目')} hint={tr('留空 = 你参与的所有项目')}>
          <Select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            options={[
              { value: '', label: tr('所有我参与的项目') },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium text-fg">{tr('哪些事通知我')}</legend>
          {NOTIFY_EVENTS.map((e) => (
            <label key={e} className="flex min-h-9 items-center gap-2 text-small">
              <input
                type="checkbox"
                className="size-4"
                checked={events.includes(e)}
                onChange={(ev) =>
                  setEvents((prev) =>
                    ev.target.checked ? [...prev, e] : prev.filter((x) => x !== e),
                  )
                }
              />
              <span>{EVENT_LABEL[e] ?? e}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </Dialog>
  );
}

function DeliveriesDialog({
  sub,
  onClose,
}: {
  sub: NotifySubscription | null;
  onClose: () => void;
}) {
  const rows = useQuery({
    queryKey: qk.notifyDeliveries(sub?.id ?? ''),
    enabled: sub !== null,
    queryFn: ({ signal }) =>
      api.get<NotifyDelivery[]>(`/auth/me/notify/${sub!.id}/deliveries`, { signal }),
  });

  return (
    <Dialog
      open={sub !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tr('投递记录')}
      description={sub ? tr('「{name}」最近 50 次推送', { name: sub.name }) : undefined}
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {tr('关闭')}
        </Button>
      }
    >
      {rows.isPending ? (
        <SectionSkeleton rows={3} />
      ) : rows.isError ? (
        <ErrorCard error={rows.error} onRetry={() => void rows.refetch()} />
      ) : rows.data.length === 0 ? (
        <p className="py-6 text-center text-small text-fg-subtle">{tr('还没有推送记录')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {rows.data.map((d) => (
            <li key={d.id} className="flex flex-col gap-1 py-2">
              <div className="flex items-center gap-2">
                <Badge
                  tone={
                    d.status === 'success'
                      ? 'accent'
                      : d.status === 'pending'
                        ? 'neutral'
                        : 'warning'
                  }
                >
                  {d.status === 'success'
                    ? tr('成功')
                    : d.status === 'pending'
                      ? tr('待重试')
                      : d.status === 'dropped'
                        ? tr('已放弃')
                        : tr('失败')}
                </Badge>
                <span className="text-caption text-fg-subtle">
                  {tr('{value} · 第 {attempts} 次{value2}', {
                    value: new Date(d.createdAt).toLocaleString(locale()),
                    attempts: d.attempts,
                    value2: d.responseStatus ? ` · HTTP ${d.responseStatus}` : '',
                  })}
                </span>
              </div>
              <p className="truncate text-small text-fg-muted">{d.text}</p>
              {d.error && <p className="truncate text-caption text-danger">{d.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export { Send };
