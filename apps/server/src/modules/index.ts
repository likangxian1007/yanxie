/**
 * 模块注册表：脚手架已登记全部模块，后续线程只改各自模块目录，不需要改这里。
 * 新增模块时再在此追加一行。
 */
import type { ModuleDef } from './types';
import { authModule } from './auth';
import { projectsModule } from './projects';
import { timelineModule } from './timeline';
import { threadsModule } from './threads';
import { agentsModule } from './agents';
import { memoryModule } from './memory';
import { claimsModule } from './claims';
import { routinesModule } from './routines';
import { filesModule } from './files';
import { inboxModule } from './inbox';
import { documentsModule } from './documents';
import { boardsModule } from './boards';
import { todosModule } from './todos';
import { reviewsModule } from './reviews';
import { reportsModule } from './reports';
import { notebooksModule } from './notebooks';
import { harnessModule } from './harness';
import { libraryModule } from './library';
import { prefsModule } from './prefs';
import { versioningModule } from './versioning';
import { researchModule } from './research';
import { sharingModule } from './sharing';
import { plansModule } from './plans';
import { integrationsModule } from './integrations';
import { mcpModule } from './mcp';
import { notifyModule } from './notify';
import { feedbackModule } from './feedback';
import { adminModule } from './admin';
import { billingModule } from './billing';
import { hybridModule } from './hybrid';
import { pdfTranslateModule } from './pdf-translate';

export { healthModule } from './health';

/** 挂在 /api/v1 下的业务模块 */
export const apiModules: ModuleDef[] = [
  authModule,
  projectsModule,
  timelineModule,
  threadsModule,
  agentsModule,
  memoryModule,
  claimsModule,
  routinesModule,
  filesModule,
  inboxModule,
  documentsModule,
  boardsModule,
  todosModule,
  reviewsModule,
  reportsModule,
  notebooksModule,
  harnessModule,
  libraryModule,
  prefsModule,
  hybridModule,
  pdfTranslateModule,
  versioningModule,
  researchModule,
  sharingModule,
  plansModule,
  integrationsModule,
  mcpModule,
  notifyModule,
  feedbackModule,
  adminModule,
  billingModule,
];
