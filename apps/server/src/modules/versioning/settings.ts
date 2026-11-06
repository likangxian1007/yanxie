import { eq } from 'drizzle-orm';
import {
  VersioningSettingsInput,
  type ActorRef,
  type VersioningSettings,
  type VersioningSettingsInput as SettingsIn,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { versioningSettings } from '../../db/schema';

/** 项目的版本设置（API.md §2.18.3）。没有行时用默认值：agent 走改动提案、不关联仓库。 */
type Row = typeof versioningSettings.$inferSelect;

function toDto(projectId: string, row: Row | undefined): VersioningSettings {
  return {
    projectId,
    agentDirectWrite: row?.agentDirectWrite ?? false,
    githubRepo: row?.githubRepo ?? null,
    githubBranch: row?.githubBranch ?? 'main',
    githubTokenSet: !!row?.githubToken,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export async function settingsRow(ctx: AppContext, projectId: string): Promise<Row | undefined> {
  const [row] = await ctx.db.db
    .select()
    .from(versioningSettings)
    .where(eq(versioningSettings.projectId, projectId));
  return row;
}

export async function getSettings(ctx: AppContext, projectId: string): Promise<VersioningSettings> {
  return toDto(projectId, await settingsRow(ctx, projectId));
}

export async function updateSettings(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  raw: SettingsIn,
): Promise<VersioningSettings> {
  const input = VersioningSettingsInput.parse(raw);
  const set: Partial<typeof versioningSettings.$inferInsert> = {
    updatedBy: actor,
    updatedAt: new Date(),
  };
  if (input.agentDirectWrite !== undefined) set.agentDirectWrite = input.agentDirectWrite;
  if (input.githubRepo !== undefined) set.githubRepo = input.githubRepo;
  if (input.githubBranch !== undefined) set.githubBranch = input.githubBranch;
  if (input.githubToken !== undefined) set.githubToken = input.githubToken;
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(versioningSettings)
      .values({ projectId, ...set })
      .onConflictDoUpdate({ target: versioningSettings.projectId, set })
      .returning();
    return ctx.bus.record(tx, {
      projectId,
      type: 'versioning.settings_updated',
      payload: toDto(projectId, row),
      actor,
    });
  });
  ctx.bus.emit(event);
  return event.payload;
}
