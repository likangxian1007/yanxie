import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { motion } from 'motion/react';
import { CornerDownLeft } from 'lucide-react';
import type { SessionSettingsInput } from '@srh/shared';
import { Button, toast } from '@/components/ui';
import { PageTitle } from '@/components/layout/Page';
import { BackLink } from '@/components/layout/BackLink';
import { projectPath } from '@/components/layout/nav-items';
import { findProfile, HarnessComposer } from '@/features/harness';
import { useHarness } from '@/lib/harness';
import { useMotionPreset } from '@/lib/motion';
import { useCreatePersonalThread } from '../workspace-api';
import { tr, trServer } from '@/lib/i18n';

/** 示例：写成研究者真会说的话，点一下填进输入框（不直接发出） */
const EXAMPLES = [
  tr('梳理这个方向近三年的代表性工作，各自的数据集和局限'),
  tr('检查我的实验设计：对照组、变量和评价指标有没有漏洞'),
  tr('把这段摘要改成顶会论文的写法，保留原意'),
];

export interface NewSessionHeroProps {
  projectId: string;
  /** 进入时聚焦输入框（命令面板的 ?new=1） */
  autoFocus: boolean;
  /** 还没有任何会话：多一句工作区是什么的说明 */
  firstTime: boolean;
  /** 手机上从列表进来时显示返回 */
  showBack: boolean;
  writable: boolean;
}

/**
 * 工作区开始页：一行标题 + 一句说明 + 输入框 + 几条示例。
 * 发出第一句话就新建一个个人会话（POST /threads），成功后跳到会话页。
 */
export function NewSessionHero({
  projectId,
  autoFocus,
  firstTime,
  showBack,
  writable,
}: NewSessionHeroProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const listParams = new URLSearchParams(location.search);
  listParams.delete('new');
  const listHref = `${projectPath(projectId, 'workspace')}?${listParams}`;
  const { variants } = useMotionPreset();
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const create = useCreatePersonalThread(projectId);
  const harness = useHarness(projectId);
  const profiles = harness.data?.profiles ?? [];
  const [settings, setSettings] = useState<SessionSettingsInput>({});
  const profile = findProfile(profiles, settings.profile);
  // 选了带开场引导的 profile：示例换成它的 starters
  const examples: readonly string[] =
    profile && profile.starters.length > 0 ? profile.starters : EXAMPLES;

  // 每次带着 ?new=1 进来（包括已在本页时再点“新建会话”）都把焦点放进输入框
  useEffect(() => {
    if (autoFocus) composerRef.current?.focus();
  }, [autoFocus, location.key]);

  // 新建失败：输入框重新可用后把焦点还回去，方便直接再发
  useEffect(() => {
    if (create.isError) composerRef.current?.focus();
  }, [create.isError]);

  const pick = (text: string) => {
    setDraft(text);
    window.setTimeout(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    }, 0);
  };

  return (
    <div className="flex flex-1 flex-col px-4 pt-6 pb-10 md:px-6 md:pt-8 lg:px-8">
      {showBack && (
        <div className="lg:hidden">
          <BackLink to={listHref}>{tr('全部会话')}</BackLink>
        </div>
      )}
      <motion.div
        variants={variants.fadeIn}
        initial="hidden"
        animate="visible"
        className="mx-auto flex w-full max-w-(--feed-max) flex-1 flex-col justify-center py-6 md:pb-[12vh]"
      >
        <PageTitle>{firstTime || autoFocus ? tr('新会话') : tr('我的工作区')}</PageTitle>
        <p className="mt-1 max-w-[34rem] text-small text-pretty text-fg-muted">
          {tr('只有你能看到这段会话，需要时可以转给协调者。')}
        </p>

        <HarnessComposer
          ref={composerRef}
          projectId={projectId}
          threadId={null}
          agent={null}
          personal
          writable={writable}
          newSessionSettings={{ value: settings, onChange: setSettings }}
          inline
          className="mt-5 w-full text-left"
          value={draft}
          onChange={setDraft}
          label={tr('给个人 agent 的消息')}
          placeholder={writable ? tr('写下你想先自己理清的问题…') : tr('访客不能新建个人会话')}
          disabled={!writable || create.isPending}
          toolbar={
            create.isPending ? (
              <Button size="sm" variant="ghost" loading>
                {tr('正在新建会话')}
              </Button>
            ) : undefined
          }
          onSubmit={({ body }) => {
            // 所有明确选择都随会话一起创建，第一轮即生效。
            create.mutate(
              { body, ...settings },
              {
                onSuccess: (thread) => {
                  navigate(`${projectPath(projectId, `workspace/${thread.id}`)}?${listParams}`);
                },
                onError: (e) => {
                  toast.error(
                    tr('会话没开起来'),
                    tr('{message} 你的话还在输入框里，可以再发一次。', { message: e.message }),
                  );
                },
              },
            );
          }}
        />

        {writable && (
          <section aria-labelledby="new-session-examples" className="mt-6">
            <h2 id="new-session-examples" className="px-1 text-caption text-fg-subtle">
              {tr('例如')}
            </h2>
            <ul className="mt-1 flex flex-col">
              {examples.map((text) => (
                <li key={text} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => pick(text)}
                    disabled={create.isPending}
                    className="group flex w-full cursor-pointer items-center gap-3 rounded-sm px-1 py-2.5 text-left text-small text-fg-muted transition-colors duration-(--dur-fast) ease-(--ease-standard) hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1">{trServer(text)}</span>
                    <CornerDownLeft
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden
                      className="shrink-0 text-fg-subtle opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </motion.div>
    </div>
  );
}
