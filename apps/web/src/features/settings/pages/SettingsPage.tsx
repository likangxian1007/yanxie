import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Page } from '@/components/layout/Page';
import { useIsMobile } from '@/lib/use-media-query';
import { projectPath } from '@/components/layout/nav-items';
import { SettingsNavigation } from '../components/SettingsNavigation';
import { useProjectId } from '@/lib/project';
import { AgentProfilesSection } from '../components/harness/AgentProfilesSection';
import { CommandsSection } from '../components/harness/CommandsSection';
import { McpSection } from '../components/harness/McpSection';
import { ModelsSection } from '../components/harness/ModelsSection';
import { SkillsSection } from '../components/harness/SkillsSection';
import { GeneralSection } from '../components/GeneralSection';
import { InstructionsSection } from '../components/InstructionsSection';
import { InvitesSection } from '../components/InvitesSection';
import { MembersSection } from '../components/MembersSection';
import { MemorySection } from '../components/MemorySection';
import { ProfileSection } from '../components/ProfileSection';
import { IntegrationsSection } from '../components/IntegrationsSection';
import { NotifySection } from '../components/NotifySection';
import { RoutinesSection } from '../components/RoutinesSection';
import { VersioningSection } from '@/features/versioning/components/VersioningSection';
import { parseSettingsTab, SETTINGS_TAB_LABEL, type SettingsTab } from '../lib';
import { tr } from '@/lib/i18n';

function renderSection(tab: SettingsTab, pid: string): ReactNode {
  switch (tab) {
    case 'general':
      return <GeneralSection pid={pid} />;
    case 'members':
      return <MembersSection pid={pid} />;
    case 'invites':
      return <InvitesSection pid={pid} />;
    case 'instructions':
      return <InstructionsSection pid={pid} />;
    case 'memory':
      return <MemorySection pid={pid} />;
    case 'routines':
      return <RoutinesSection pid={pid} />;
    case 'versioning':
      return <VersioningSection pid={pid} />;
    case 'models':
      return <ModelsSection pid={pid} />;
    case 'mcp':
      return <McpSection pid={pid} />;
    case 'skills':
      return <SkillsSection pid={pid} />;
    case 'commands':
      return <CommandsSection pid={pid} />;
    case 'agent-profiles':
      return <AgentProfilesSection pid={pid} />;
    case 'profile':
      return <ProfileSection pid={pid} />;
    case 'integrations':
      return <IntegrationsSection />;
    case 'notify':
      return <NotifySection />;
  }
}

/** 设置：项目信息、成员与邀请、协调者指令、项目记忆、定时任务、个人与外观。分区写在 ?tab= 里。 */
export function SettingsPage() {
  const pid = useProjectId();
  const [params] = useSearchParams();
  const tab = parseSettingsTab(params.get('tab'));
  const directory = !params.has('tab');
  const mobile = useIsMobile();

  if (mobile && directory) return <SettingsNavigation projectId={pid} />;
  return (
    <Page width="doc" className="pb-12 md:pt-9">
      <Link
        to={projectPath(pid, 'settings')}
        className="mb-5 inline-flex min-h-11 items-center gap-2 text-small text-fg-muted hover:text-fg md:hidden"
      >
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
        {tr('设置目录')}
      </Link>
      <section key={tab} aria-label={SETTINGS_TAB_LABEL[tab]} className="min-w-0">
        {renderSection(tab, pid)}
      </section>
    </Page>
  );
}
