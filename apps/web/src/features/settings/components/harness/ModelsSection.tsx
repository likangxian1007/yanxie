import { useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Cpu, KeyRound, MoreHorizontal, Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { EFFORT_LABEL, type LlmProvider } from '@srh/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Switch,
  toast,
} from '@/components/ui';
import {
  useDeleteProvider,
  useModelCatalog,
  useTestProvider,
  useUpdateProvider,
  type ProviderTestResult,
} from '@/lib/harness';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { errorMessage } from '../../lib';
import { ConfirmDialog, ErrorCard, ReadOnlyNote, SectionSkeleton, SettingsCard } from '../parts';
import { THINKING_FORMAT_LABEL, useHarnessPerm } from './perm';
import { ProviderDialog } from './ProviderDialog';
import { tr } from '@/lib/i18n';

interface EditorState {
  open: boolean;
  provider: LlmProvider | null;
  key: number;
}

function TestResult({ result }: { result: ProviderTestResult }) {
  return (
    <p
      role="status"
      className={cn(
        'rounded-md px-3 py-2 text-small',
        result.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
      )}
    >
      {result.ok
        ? tr('连接正常 · {latencyMs} ms', { latencyMs: result.latencyMs })
        : tr('连接失败')}
      {result.message && <span className="ml-1.5 text-fg-muted">{result.message}</span>}
    </p>
  );
}

/** 设置 → 模型：环境变量里的接口只读；项目可以接入 OpenAI 兼容的接口。 */
export function ModelsSection({ pid }: { pid: string }) {
  const catalog = useModelCatalog(pid);
  const perm = useHarnessPerm(pid);
  const { variants, stagger } = useMotionPreset();
  const update = useUpdateProvider(pid);
  const remove = useDeleteProvider(pid);
  const test = useTestProvider(pid);
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({});
  const [editor, setEditor] = useState<EditorState>({ open: false, provider: null, key: 0 });
  const [deleting, setDeleting] = useState<LlmProvider | null>(null);

  const openEditor = (provider: LlmProvider | null) =>
    setEditor((s) => ({ open: true, provider, key: s.key + 1 }));

  const runTest = (p: LlmProvider) =>
    test.mutate(p.id, {
      onSuccess: (r) => setResults((m) => ({ ...m, [p.id]: r })),
      onError: (e) => toast.error(tr('没能测试连接'), errorMessage(e)),
    });

  const allModels = catalog.data?.providers.flatMap((p) => p.models) ?? [];
  const defaultModel = allModels.find((m) => m.id === catalog.data?.defaultModel);

  let body: ReactNode;
  if (catalog.isPending) body = <SectionSkeleton rows={2} />;
  else if (catalog.isError)
    body = <ErrorCard error={catalog.error} onRetry={() => void catalog.refetch()} />;
  else if (catalog.data.providers.length === 0)
    body = (
      <EmptyState
        framed
        icon={Cpu}
        title={tr('还没有模型接口')}
        description={tr(
          '部署时可以在环境变量里配置 DeepSeek；也可以在这里接入任何 OpenAI 兼容的接口。',
        )}
      />
    );
  else
    body = (
      <motion.ul
        variants={stagger()}
        initial="hidden"
        animate="visible"
        aria-label={tr('模型接口')}
        className="flex flex-col gap-3"
      >
        {catalog.data.providers.map((p) => {
          const readOnly = p.source === 'env' || !perm.manage;
          return (
            <motion.li key={p.id} variants={variants.fadeUp}>
              <Card className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="min-w-0 truncate text-h3 text-fg">{p.name}</h3>
                      <Badge tone={p.source === 'env' ? 'neutral' : 'accent'}>
                        {p.source === 'env' ? tr('环境变量') : tr('项目')}
                      </Badge>
                      {!p.enabled && <Badge tone="warning">{tr('已停用')}</Badge>}
                    </div>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption font-normal text-fg-subtle">
                      <code className="font-mono break-all">{p.baseUrl}</code>
                      <span className="inline-flex items-center gap-1">
                        <KeyRound size={12} strokeWidth={1.75} aria-hidden />
                        {p.hasApiKey ? tr('已设置 key') : tr('未设置 key')}
                      </span>
                      <span>
                        {tr('推理参数：{value}', {
                          value: THINKING_FORMAT_LABEL[p.thinkingFormat],
                        })}
                      </span>
                    </p>
                  </div>
                  {p.source === 'project' && (
                    <Switch
                      label={
                        p.enabled
                          ? tr('停用「{name}」', { name: p.name })
                          : tr('启用「{name}」', { name: p.name })
                      }
                      checked={p.enabled}
                      disabled={!perm.manage || update.isPending}
                      onCheckedChange={(enabled) =>
                        update.mutate(
                          { id: p.id, patch: { enabled } },
                          { onError: (e) => toast.error(tr('没能切换'), errorMessage(e)) },
                        )
                      }
                      className="mt-0.5"
                    />
                  )}
                </div>

                <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                  {p.models.map((m) => (
                    <li
                      key={m.id}
                      className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-baseline gap-x-2 text-body text-fg">
                          {m.name}
                          <code className="font-mono text-caption font-normal text-fg-subtle">
                            {m.model}
                          </code>
                          {m.id === catalog.data.defaultModel && (
                            <Badge tone="accent">{tr('默认')}</Badge>
                          )}
                        </p>
                        {m.description && (
                          <p className="text-caption font-normal text-fg-muted">{m.description}</p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {m.efforts.map((e) => (
                          <span
                            key={e}
                            className={cn(
                              'rounded-xs px-1.5 text-caption',
                              e === m.defaultEffort
                                ? 'bg-accent-soft text-accent-text'
                                : 'bg-muted text-fg-muted',
                            )}
                            title={e === m.defaultEffort ? tr('默认强度') : undefined}
                          >
                            {EFFORT_LABEL[e]}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>

                {results[p.id] && <TestResult result={results[p.id] as ProviderTestResult} />}

                <div className="flex flex-wrap items-center gap-2">
                  {p.source === 'env' && (
                    <ReadOnlyNote>{tr('在部署的环境变量里配置，这里只读')}</ReadOnlyNote>
                  )}
                  {perm.manage && (
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Plug strokeWidth={1.75} aria-hidden />}
                        loading={test.isPending && test.variables === p.id}
                        onClick={() => runTest(p)}
                      >
                        {tr('测试连接')}
                      </Button>
                      {!readOnly && (
                        <Menu
                          align="end"
                          label={tr('{name} 的操作', { name: p.name })}
                          trigger={
                            <IconButton label={tr('更多操作')} size="sm">
                              <MoreHorizontal strokeWidth={1.75} aria-hidden />
                            </IconButton>
                          }
                        >
                          <MenuItem
                            icon={<Pencil strokeWidth={1.75} aria-hidden />}
                            onSelect={() => openEditor(p)}
                          >
                            {tr('编辑')}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            danger
                            icon={<Trash2 strokeWidth={1.75} aria-hidden />}
                            onSelect={() => {
                              remove.reset();
                              setDeleting(p);
                            }}
                          >
                            {tr('删除')}
                          </MenuItem>
                        </Menu>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            </motion.li>
          );
        })}
      </motion.ul>
    );

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={tr('模型')}
        description={
          <>
            {tr(
              'agent 调用的大模型接口。成员可以在输入框里用 /model、/effort 为会话切换模型和推理强度。',
            )}
            {defaultModel && (
              <>
                {tr('{value}新会话默认用 {name}{value2}。', {
                  value: ' ',
                  name: defaultModel.name,
                  value2: catalog.data ? ` · ${EFFORT_LABEL[catalog.data.defaultEffort]}` : '',
                })}
              </>
            )}
          </>
        }
        actions={
          perm.manage ? (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Plus strokeWidth={2} aria-hidden />}
              onClick={() => openEditor(null)}
            >
              {tr('添加接口')}
            </Button>
          ) : (
            <ReadOnlyNote />
          )
        }
      />
      {body}

      {perm.manage && (
        <ProviderDialog
          key={editor.key}
          pid={pid}
          provider={editor.provider}
          open={editor.open}
          onOpenChange={(v) => {
            if (!v) setEditor((s) => ({ ...s, open: false }));
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
        title={tr('删除接口「{value}」？', { value: deleting?.name ?? '' })}
        description={tr('用这些模型的会话会回到项目默认模型。')}
        confirmLabel={tr('删除接口')}
        loading={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onConfirm={() => {
          if (!deleting) return;
          const target = deleting;
          remove.mutate(target.id, {
            onSuccess: () => {
              toast.success(tr('已删除「{name}」', { name: target.name }));
              setDeleting(null);
            },
          });
        }}
      />
    </div>
  );
}
