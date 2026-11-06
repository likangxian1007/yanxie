-- 删除实验专属 Notebook；研究空间当前内容及固定历史里引用的 Notebook 保留。
CREATE TEMP TABLE srh_retired_notebooks ON COMMIT DROP AS
SELECT n.id FROM notebooks n
WHERE n.experiment_id IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM research_entities r WHERE r.project_id=n.project_id AND jsonb_path_exists(r.data, '$.** ? (@ == $id)', jsonb_build_object('id', n.id)))
AND NOT EXISTS (SELECT 1 FROM research_revisions r WHERE r.project_id=n.project_id AND jsonb_path_exists(r.data, '$.** ? (@ == $id)', jsonb_build_object('id', n.id)))
AND NOT EXISTS (SELECT 1 FROM research_workspace_items r WHERE r.project_id=n.project_id AND jsonb_path_exists(jsonb_build_array(r.resource,r.action,r.payload,r.evidence_ref,r.origin), '$.** ? (@ == $id)', jsonb_build_object('id', n.id)))
AND NOT EXISTS (SELECT 1 FROM research_runs r WHERE r.project_id=n.project_id AND jsonb_path_exists(r.data, '$.** ? (@ == $id)', jsonb_build_object('id', n.id)))
AND NOT EXISTS (SELECT 1 FROM research_recipe_versions r WHERE r.project_id=n.project_id AND jsonb_path_exists(r.data, '$.** ? (@ == $id)', jsonb_build_object('id', n.id)));
--> statement-breakpoint
DELETE FROM versions WHERE target_kind='notebook' AND target_id IN (SELECT id FROM srh_retired_notebooks);
--> statement-breakpoint
DELETE FROM notebooks WHERE id IN (SELECT id FROM srh_retired_notebooks);
--> statement-breakpoint
DELETE FROM outputs WHERE kind='experiment' OR ref IN (SELECT id FROM srh_retired_notebooks);
--> statement-breakpoint
UPDATE work_claims SET status='released' WHERE resource_kind='experiment' AND status='active';
--> statement-breakpoint
UPDATE inbox_items SET done_at=now() WHERE done_at IS NULL AND (source_id IN (SELECT id FROM experiments UNION ALL SELECT id FROM experiment_logs) OR href LIKE '%/experiments%');
--> statement-breakpoint
UPDATE research_entities SET data=jsonb_set(data,'{resources}',COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(data->'resources') item WHERE item->>'kind'<>'experiment'),'[]'::jsonb))
WHERE jsonb_typeof(data->'resources')='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'resources') item WHERE item->>'kind'='experiment');
--> statement-breakpoint
UPDATE research_workspace_items SET resource=NULL, preview='内容已移除' WHERE resource->>'kind'='experiment';
