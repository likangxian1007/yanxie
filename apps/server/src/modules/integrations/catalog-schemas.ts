import { z } from 'zod';
import {
  PageQuery,
  ReviewStatus,
  ReviewTargetKind,
  NotebookExportFormat,
  DocumentKind,
  SpaceFilter,
} from '@srh/shared';
// Shared schemas used directly by route handlers; missing schemas remain explicit null.
export const SHARED_INPUT_SCHEMAS: Record<string, { body?: string; query?: string }> = {
  'POST /projects/:projectId/research/records/:recordId/runs/:runId/steps/:stepId/answer': {
    body: 'ResearchRunAnswerInput',
  },
  'GET /inbox': { query: 'InboxQuery' },
  'GET /projects/:projectId/agents/:sessionId/steps': { query: 'AgentStepsQuery' },
  'GET /projects/:projectId/claims': { query: 'ClaimListQuery' },
  'GET /projects/:projectId/events': { query: 'EventsQuery' },
  'GET /projects/:projectId/files': { query: 'FileListQuery' },
  'GET /projects/:projectId/library/papers': { query: 'PaperListQuery' },
  'GET /projects/:projectId/library/search': { query: 'LibrarySearchQuery' },
  'GET /projects/:projectId/notebooks': { query: 'NotebookListQuery' },
  'GET /projects/:projectId/outputs': { query: 'OutputListQuery' },
  'GET /projects/:projectId/proposals': { query: 'ProposalListQuery' },
  'GET /projects/:projectId/research': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/codes': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/excerpts': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/findings': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/items': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/items/:itemId/artifacts': {
    query: 'PageQuery',
  },
  'GET /projects/:projectId/research/records/:recordId/logs': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/recipes': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/relations': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/revisions': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/runs': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/sources': { query: 'PageQuery' },
  'GET /projects/:projectId/research/records/:recordId/workspace': { query: 'PageQuery' },
  'GET /projects/:projectId/research/sources/:sourceId/snapshots': { query: 'PageQuery' },
  'GET /projects/:projectId/research/templates': { query: 'PageQuery' },
  'GET /projects/:projectId/threads': { query: 'ThreadListQuery' },
  'GET /projects/:projectId/threads/:threadId/messages': { query: 'MessageListQuery' },
  'GET /projects/:projectId/timeline': { query: 'MessageListQuery' },
  'GET /projects/:projectId/versions': { query: 'VersionTargetQuery' },
  'GET /projects/:projectId/versions/current': { query: 'VersionTargetQuery' },
  'PATCH /auth/me': { body: 'UpdateMeInput' },
  'PATCH /inbox/:itemId': { body: 'InboxUpdateInput' },
  'PATCH /projects/:projectId': { body: 'ProjectUpdateInput' },
  'PATCH /projects/:projectId/agents/:sessionId/settings': { body: 'SessionSettingsInput' },
  'PATCH /projects/:projectId/boards/:boardId': { body: 'BoardUpdateInput' },
  'PATCH /projects/:projectId/cards/:cardId': { body: 'CardUpdateInput' },
  'PATCH /projects/:projectId/commands/:id': { body: 'SlashCommandUpdateInput' },
  'PATCH /projects/:projectId/docs/:docId': { body: 'DocumentUpdateInput' },
  'PATCH /projects/:projectId/docs/:docId/comments/:commentId': { body: 'DocCommentUpdateInput' },
  'PATCH /projects/:projectId/library/papers/:paperId': { body: 'PaperUpdateInput' },
  'PATCH /projects/:projectId/mcp-servers/:id': { body: 'McpServerUpdateInput' },
  'PATCH /projects/:projectId/members/:userId': { body: 'MemberUpdateInput' },
  'PATCH /projects/:projectId/messages/:messageId': { body: 'MessageUpdateInput' },
  'PATCH /projects/:projectId/notebooks/:notebookId': { body: 'NotebookUpdateInput' },
  'PATCH /projects/:projectId/profiles/:id': { body: 'ProfileUpdateInput' },
  'PATCH /projects/:projectId/providers/:id': { body: 'ProviderUpdateInput' },
  'PATCH /projects/:projectId/reports/:reportId': { body: 'ReportUpdateInput' },
  'PATCH /projects/:projectId/research/codes/:codeId': { body: 'ResearchCodeUpdateInput' },
  'PATCH /projects/:projectId/research/findings/:findingId': { body: 'ResearchFindingUpdateInput' },
  'PATCH /projects/:projectId/research/records/:recordId': { body: 'ResearchRecordUpdateInput' },
  'PATCH /projects/:projectId/research/records/:recordId/items/:itemId': {
    body: 'ResearchItemUpdateInput',
  },
  'PATCH /projects/:projectId/research/records/:recordId/items/:itemId/position': {
    body: 'ResearchItemPositionInput',
  },
  'PATCH /projects/:projectId/research/records/:recordId/relations/:relationId': {
    body: 'ResearchRelationUpdateInput',
  },
  'PATCH /projects/:projectId/research/sources/:sourceId': { body: 'ResearchSourceUpdateInput' },
  'PATCH /projects/:projectId/reviews/:reviewId/comments/:commentId': {
    body: 'ReviewCommentUpdateInput',
  },
  'PATCH /projects/:projectId/routines/:routineId': { body: 'RoutineUpdateInput' },
  'PATCH /projects/:projectId/shares/:kind/:id/grants/:userId': { body: 'ShareGrantUpdateInput' },
  'PATCH /projects/:projectId/shares/:kind/:id/link': { body: 'ShareLinkUpdateInput' },
  'PATCH /projects/:projectId/skills/:id': { body: 'SkillUpdateInput' },
  'PATCH /projects/:projectId/threads/:threadId': { body: 'ThreadUpdateInput' },
  'PATCH /projects/:projectId/todos/:todoId': { body: 'TodoUpdateInput' },
  'PATCH /projects/:projectId/versioning/settings': { body: 'VersioningSettingsInput' },
  'POST /auth/login': { body: 'LoginInput' },
  'POST /auth/password/request-reset': { body: 'PasswordResetRequestInput' },
  'POST /auth/password/reset': { body: 'PasswordResetInput' },
  'POST /auth/register': { body: 'RegisterInput' },
  'POST /projects': { body: 'ProjectCreateInput' },
  'POST /projects/:projectId/boards': { body: 'BoardCreateInput' },
  'POST /projects/:projectId/boards/:boardId/cards': { body: 'CardCreateInput' },
  'POST /projects/:projectId/boards/:boardId/columns': { body: 'ColumnUpsertInput' },
  'POST /projects/:projectId/claims': { body: 'ClaimCreateInput' },
  'POST /projects/:projectId/claims/:claimId/renew': { body: 'ClaimRenewInput' },
  'POST /projects/:projectId/commands': { body: 'SlashCommandCreateInput' },
  'POST /projects/:projectId/commands/run': { body: 'CommandRunInput' },
  'POST /projects/:projectId/decisions/:decisionId/answer': { body: 'DecisionAnswerInput' },
  'POST /projects/:projectId/docs': { body: 'DocumentCreateInput' },
  'POST /projects/:projectId/docs/:docId/ai': { body: 'DocumentAiInput' },
  'POST /projects/:projectId/docs/:docId/comments': { body: 'DocCommentCreateInput' },
  'POST /projects/:projectId/docs/:docId/edit': { body: 'DocumentEdit' },
  'POST /projects/:projectId/docs/:docId/latex/compile': { body: 'LatexCompileInput' },
  'POST /projects/:projectId/docs/:docId/mentions': { body: 'DocMentionInput' },
  'POST /projects/:projectId/docs/:docId/move': { body: 'MoveSpaceInput' },
  'POST /projects/:projectId/docs/:docId/versions': { body: 'DocumentVersionCreateInput' },
  'POST /projects/:projectId/docs/import': { query: 'DocumentImportQuery' },
  'POST /projects/:projectId/invites': { body: 'InviteCreateInput' },
  'POST /projects/:projectId/library/bibtex': { body: 'LibraryBibtexInput' },
  'POST /projects/:projectId/library/cite': { body: 'LibraryCiteToDocInput' },
  'POST /projects/:projectId/library/papers': { body: 'PaperImportInput' },
  'POST /projects/:projectId/library/papers/:paperId/move': { body: 'MoveSpaceInput' },
  'POST /projects/:projectId/library/qa': { body: 'LibraryQaInput' },
  'POST /projects/:projectId/mcp-servers': { body: 'McpServerCreateInput' },
  'POST /projects/:projectId/notebooks': { body: 'NotebookCreateInput' },
  'POST /projects/:projectId/notebooks/:notebookId/execute': { body: 'NotebookExecuteInput' },
  'POST /projects/:projectId/notebooks/:notebookId/import': { body: 'NotebookImportInput' },
  'POST /projects/:projectId/notebooks/:notebookId/restart': { body: 'NotebookRestartInput' },
  'POST /projects/:projectId/profiles': { body: 'ProfileCreateInput' },
  'POST /projects/:projectId/providers': { body: 'ProviderCreateInput' },
  'POST /projects/:projectId/reports': { body: 'ReportCreateInput' },
  'POST /projects/:projectId/reports/:reportId/regenerate': { body: 'ReportRegenerateInput' },
  'POST /projects/:projectId/reports/:reportId/todos': { body: 'ReportTodosInput' },
  'POST /projects/:projectId/research/records': { body: 'ResearchRecordCreateInput' },
  'POST /projects/:projectId/research/records/:recordId/codes': { body: 'ResearchCodeCreateInput' },
  'POST /projects/:projectId/research/records/:recordId/codings': {
    body: 'ResearchCodingCreateInput',
  },
  'POST /projects/:projectId/research/records/:recordId/excerpts': {
    body: 'EvidenceExcerptCreateInput',
  },
  'POST /projects/:projectId/research/records/:recordId/findings': {
    body: 'ResearchFindingCreateInput',
  },
  'POST /projects/:projectId/research/records/:recordId/items': { body: 'ResearchItemCreateInput' },
  'POST /projects/:projectId/research/records/:recordId/logs': { body: 'ResearchLogCreateInput' },
  'POST /projects/:projectId/research/records/:recordId/recipes': {
    body: 'ResearchRecipePublishInput',
  },
  'POST /projects/:projectId/research/records/:recordId/recipes/:recipeId/instantiate': {
    body: 'ResearchRecipeInstantiateInput',
  },
  'POST /projects/:projectId/research/records/:recordId/relations': {
    body: 'ResearchRelationCreateInput',
  },
  'POST /projects/:projectId/research/records/:recordId/runs': { body: 'ResearchRunCreateInput' },
  'POST /projects/:projectId/research/records/:recordId/runs/:runId/steps/:stepId/confirm': {
    body: 'ResearchRunConfirmInput',
  },
  'POST /projects/:projectId/research/records/:recordId/sources': {
    body: 'ResearchSourceCreateInput',
  },
  'POST /projects/:projectId/research/sources': { body: 'ResearchSourceCreateInput' },
  'POST /projects/:projectId/research/sources/:sourceId/snapshots': {
    body: 'ResearchSnapshotCreateInput',
  },
  'POST /projects/:projectId/research/templates': { body: 'ResearchTemplatePublishInput' },
  'POST /projects/:projectId/research/workspaces': { body: 'ResearchWorkspaceCreateInput' },
  'POST /projects/:projectId/reviews': { body: 'ReviewCreateInput' },
  'POST /projects/:projectId/reviews/:reviewId/comments': { body: 'ReviewCommentCreateInput' },
  'POST /projects/:projectId/reviews/:reviewId/verdict': { body: 'ReviewVerdictInput' },
  'POST /projects/:projectId/routines': { body: 'RoutineCreateInput' },
  'POST /projects/:projectId/shares/:kind/:id/grants': { body: 'ShareGrantInput' },
  'POST /projects/:projectId/skills': { body: 'SkillCreateInput' },
  'POST /projects/:projectId/skills/import': { body: 'SkillImportInput' },
  'POST /projects/:projectId/threads': { body: 'PersonalThreadCreateInput' },
  'POST /projects/:projectId/threads/:threadId/forward': { body: 'ThreadForwardInput' },
  'POST /projects/:projectId/threads/:threadId/messages': { body: 'MessageCreateInput' },
  'POST /projects/:projectId/timeline': { body: 'MessageCreateInput' },
  'POST /projects/:projectId/todos': { body: 'TodoCreateInput' },
  'POST /projects/:projectId/versions': { body: 'VersionCreateInput' },
  'PUT /auth/me/pins/:projectId': { body: 'PinsUpdateInput' },
  'PUT /projects/:projectId/memory': { body: 'MemoryWriteInput' },
  'PUT /projects/:projectId/messages/:messageId/reactions': { body: 'ReactionInput' },
};

export const TRANSFER_SCHEMAS: Record<
  string,
  { body?: unknown; query?: unknown; response: unknown }
> = {
  'POST /integrations/transfers': {
    body: {
      type: 'object',
      required: ['projectId', 'path', 'size', 'sha256'],
      properties: {
        projectId: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
        size: { type: 'integer', minimum: 0, maximum: 20971520 },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
    response: {
      type: 'object',
      properties: {
        transferId: { type: 'string' },
        chunkSize: { type: 'integer' },
        expiresInSeconds: { type: 'integer' },
      },
    },
  },
  'PUT /integrations/transfers/:transferId/chunks': {
    body: {
      type: 'object',
      required: ['offset', 'base64'],
      properties: { offset: { type: 'integer', minimum: 0 }, base64: { type: 'string' } },
    },
    response: { type: 'object', properties: { nextOffset: { type: 'integer' } } },
  },
  'GET /projects/:projectId/files/:fileId/chunks': {
    query: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 262144 },
      },
    },
    response: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        size: { type: 'integer' },
        sha256: { type: 'string' },
        offset: { type: 'integer' },
        base64: { type: 'string' },
        nextOffset: { type: ['integer', 'null'] },
      },
    },
  },
};

// Route-local schemas that are not exported from shared packages.
export const LOCAL_INPUT_SCHEMAS: Record<string, { body?: unknown; query?: unknown }> = {
  'GET /projects/:projectId/todos': {
    query: {
      type: 'object',
      properties: {
        scope: { enum: ['project', 'mine'] },
        done: { enum: ['true', 'false'] },
      },
    },
  },
  'GET /projects/:projectId/plans/proposals': {
    query: {
      type: 'object',
      properties: {
        status: { enum: ['draft', 'submitted', 'accepted', 'rejected', 'withdrawn'] },
      },
    },
  },
  'GET /projects/:projectId/plans/memory': {
    query: { type: 'object', properties: { userId: { type: 'string', minLength: 1 } } },
  },
  'GET /projects/:projectId/plans/basis': {
    query: {
      type: 'object',
      properties: {
        status: { enum: ['active', 'needs_review', 'superseded', 'retired'] },
      },
    },
  },
  'POST /projects/:projectId/notebooks/:notebookId/complete': {
    body: {
      type: 'object',
      required: ['code', 'cursorPos'],
      properties: {
        code: { type: 'string', maxLength: 200000 },
        cursorPos: { type: 'integer', minimum: 0 },
      },
    },
  },
  'POST /projects/:projectId/notebooks/:notebookId/inspect': {
    body: {
      type: 'object',
      required: ['code', 'cursorPos'],
      properties: {
        code: { type: 'string', maxLength: 200000 },
        cursorPos: { type: 'integer', minimum: 0 },
      },
    },
  },
};

export const SHARED_RESPONSES: Record<string, string> = {
  'POST /projects/:projectId/research/records/:recordId/runs/:runId/steps/:stepId/answer':
    'ResearchRun',
  'POST /projects': 'Project',
  'GET /projects/:projectId': 'Project',
  'PATCH /projects/:projectId': 'Project',
  'POST /projects/:projectId/todos': 'Todo',
  'PATCH /projects/:projectId/todos/:todoId': 'Todo',
  'POST /projects/:projectId/timeline': 'Message',
  'POST /projects/:projectId/threads/:threadId/messages': 'Message',
  'POST /projects/:projectId/notebooks': 'Notebook',
  'PATCH /projects/:projectId/notebooks/:notebookId': 'Notebook',
  'POST /integrations/transfers/:transferId/complete': 'FileObject',
};

// The schemas below mirror the exported Notebook and result transfer inputs.
const notebookChunkQuery = {
  type: 'object',
  properties: {
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100000, default: 20000 },
    contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
};
const notebookChunkResponse = {
  type: 'object',
  required: ['contentHash', 'offset', 'endOffset', 'totalLength', 'nextOffset', 'json'],
  properties: {
    contentHash: { type: 'string' },
    offset: { type: 'integer' },
    endOffset: { type: 'integer' },
    totalLength: { type: 'integer' },
    nextOffset: { type: ['integer', 'null'] },
    json: { type: 'string', description: 'A UTF-16 slice of the JSON snapshot.' },
  },
};
LOCAL_INPUT_SCHEMAS['GET /projects/:projectId/notebooks/:notebookId/contents'] = {
  query: notebookChunkQuery,
};
LOCAL_INPUT_SCHEMAS['GET /projects/:projectId/notebooks/:notebookId/execution'] = {
  query: notebookChunkQuery,
};
LOCAL_INPUT_SCHEMAS['POST /projects/:projectId/notebooks/:notebookId/cells'] = {
  body: {
    type: 'object',
    required: ['contentHash', 'operations'],
    properties: {
      contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          oneOf: [
            {
              type: 'object',
              required: ['op', 'type', 'source'],
              properties: {
                op: { const: 'insert' },
                type: { enum: ['code', 'markdown', 'raw'] },
                source: { type: 'string', maxLength: 200000 },
                afterCellId: { type: 'string', minLength: 1 },
              },
            },
            {
              type: 'object',
              required: ['op', 'cellId', 'source'],
              properties: {
                op: { const: 'replace' },
                cellId: { type: 'string', minLength: 1 },
                source: { type: 'string', maxLength: 200000 },
              },
            },
            {
              type: 'object',
              required: ['op', 'cellId'],
              properties: { op: { const: 'delete' }, cellId: { type: 'string', minLength: 1 } },
            },
          ],
        },
      },
    },
  },
};
LOCAL_INPUT_SCHEMAS['GET /integrations/results/:resultId/chunks'] = {
  query: {
    type: 'object',
    properties: {
      offset: { type: 'integer', minimum: 0, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 262144, default: 16384 },
    },
  },
};
export const LOCAL_RESPONSES: Record<string, unknown> = {
  'GET /projects/:projectId/notebooks/:notebookId/contents': notebookChunkResponse,
  'GET /projects/:projectId/notebooks/:notebookId/execution': notebookChunkResponse,
  'POST /projects/:projectId/notebooks/:notebookId/cells': {
    type: 'object',
    properties: {
      contentHash: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: { op: { enum: ['insert', 'replace', 'delete'] }, cellId: { type: 'string' } },
        },
      },
    },
  },
  'GET /integrations/results/:resultId/chunks': {
    type: 'object',
    properties: {
      resultId: { type: 'string' },
      mimeType: { type: 'string' },
      encoding: { const: 'base64' },
      size: { type: 'integer' },
      offset: { type: 'integer' },
      base64: { type: 'string' },
      nextOffset: { type: ['integer', 'null'] },
      expiresAt: { type: 'string', format: 'date-time' },
    },
  },
};

Object.assign(SHARED_INPUT_SCHEMAS, {
  'POST /projects/:projectId/plans/official': { body: 'OfficialPlanInit' },
  'POST /projects/:projectId/plans/explorations': { body: 'ExplorationCreate' },
  'PATCH /projects/:projectId/plans/:planId': { body: 'ExplorationPatch' },
  'PUT /projects/:projectId/plans/:planId/content': { body: 'PlanContentInput' },
  'POST /projects/:projectId/plans/proposals': { body: 'BasisProposalCreate' },
  'PATCH /projects/:projectId/plans/proposals/:proposalId': { body: 'BasisProposalPatch' },
  'POST /projects/:projectId/plans/proposals/:proposalId/decide': { body: 'BasisProposalDecision' },
  'POST /projects/:projectId/plans/memory': { body: 'PersonalMemoryInput' },
  'PUT /projects/:projectId/plans/memory/:memoryId': { body: 'PersonalMemoryInput' },
  'POST /projects/:projectId/plans/basis/:basisId/review': { body: 'TeamBasisReview' },
  'PATCH /projects/:projectId/research/records/:recordId/layout': {
    body: 'ResearchLayoutUpdateInput',
  },
});
const noBody = { type: 'null', description: 'No request body.' };
for (const operation of [
  'POST /projects/:projectId/agents/:sessionId/resume',
  'POST /projects/:projectId/agents/:sessionId/stop',
  'POST /projects/:projectId/docs/:docId/versions/:versionId/restore',
  'POST /projects/:projectId/library/papers/:paperId/reparse',
  'POST /projects/:projectId/notebooks/:notebookId/interrupt',
  'POST /projects/:projectId/notebooks/:notebookId/shutdown',
  'POST /projects/:projectId/plans/:planId/archive',
  'POST /projects/:projectId/plans/proposals/:proposalId/submit',
  'POST /projects/:projectId/plans/proposals/:proposalId/withdraw',
  'POST /projects/:projectId/reports/:reportId/document',
  'POST /projects/:projectId/research/records/:recordId/runs/:runId/cancel',
  'POST /projects/:projectId/research/records/:recordId/runs/:runId/retry',
  'POST /projects/:projectId/routines/:routineId/run',
  'POST /projects/:projectId/shares/:kind/:id/link/reset',
  'POST /projects/:projectId/versions/:versionId/restore',
  'POST /integrations/transfers/:transferId/complete',
  'POST /share/:token',
])
  LOCAL_INPUT_SCHEMAS[operation] = { ...LOCAL_INPUT_SCHEMAS[operation], body: noBody };
LOCAL_INPUT_SCHEMAS['DELETE /projects/:projectId/columns/:columnId'] = {
  query: { type: 'object', properties: { moveTo: { type: 'string', minLength: 1 } } },
};

const jsonInput = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
const querySchemas: Record<string, z.ZodType> = {
  'GET /projects/:projectId/files/:fileId': z.object({
    download: z.enum(['1', '0', 'true', 'false']).optional(),
  }),
  'GET /projects/:projectId/docs/:docId/latex/pdf/:pdfId': z.object({
    download: z.enum(['1', '0', 'true', 'false']).optional(),
  }),
  'DELETE /projects/:projectId/memory/*': z.object({ baseVersion: z.coerce.number().int().min(0) }),
  'GET /projects/:projectId/notebooks/:notebookId/export': z.object({
    format: NotebookExportFormat.default('ipynb'),
  }),
  'GET /projects/:projectId/reviews': z.object({
    status: ReviewStatus.optional(),
    mine: z.string().optional(),
    targetKind: ReviewTargetKind.optional(),
    targetId: z.string().min(1).optional(),
  }),
  'GET /projects/:projectId/docs': z.object({
    archived: z.enum(['true', 'false', '1', '0']).optional(),
    kind: DocumentKind.optional(),
    parentId: z.string().optional(),
    space: SpaceFilter.optional(),
  }),
  'GET /projects/:projectId/docs/search': z.object({ q: z.string().max(200).default('') }),
  'GET /projects/:projectId/research/search': PageQuery.extend({
    q: z.string().trim().min(1).max(200),
  }),
  'GET /projects/:projectId/research/records': PageQuery.extend({
    method: z.string().optional(),
    status: z.string().optional(),
  }),
  'GET /projects/:projectId/research/sources': PageQuery.extend({
    recordId: z.string().optional(),
  }),
  'GET /projects/:projectId/research/records/:recordId/codings': PageQuery.extend({
    caseId: z.string().optional(),
  }),
  'GET /projects/:projectId/research/records/:recordId/export': z.object({
    format: z.enum(['json', 'markdown', 'csv']).default('json'),
  }),
  'GET /projects/:projectId/research/artifacts/:artifactId/download': z.object({
    inline: z.string().optional(),
  }),
  'GET /projects/:projectId/research/records/:recordId/items/:itemId/content': z.object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50000).default(20000),
  }),
  'GET /projects/:projectId/research/records/:recordId/items/:itemId/table': z.object({
    sheetId: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  }),
  'GET /projects/:projectId/research/records/:recordId/items/:itemId/table/export': z.object({
    sheetId: z.string().min(1).optional(),
  }),
  'DELETE /projects/:projectId/research/records/:recordId/items/:itemId': z.object({
    baseVersion: z.coerce.number().int().positive(),
  }),
  'DELETE /projects/:projectId/research/records/:recordId/relations/:relationId': z.object({
    baseVersion: z.coerce.number().int().positive(),
  }),
};
for (const [operation, schema] of Object.entries(querySchemas))
  LOCAL_INPUT_SCHEMAS[operation] = { ...LOCAL_INPUT_SCHEMAS[operation], query: jsonInput(schema) };

LOCAL_INPUT_SCHEMAS['POST /projects/:projectId/docs/import'] = {
  body: {
    type: 'string',
    contentEncoding: 'base64',
    contentMediaType: 'application/octet-stream',
    description: 'Encoded Yjs document update, supplied through MCP transfer.',
  },
};
LOCAL_INPUT_SCHEMAS['POST /projects/:projectId/files'] = {
  body: {
    type: 'object',
    required: ['file'],
    properties: {
      file: {
        type: 'string',
        contentEncoding: 'base64',
        description: 'File part supplied through MCP transfer.',
      },
      path: { type: 'string', description: 'Optional target path.' },
    },
  },
};
LOCAL_INPUT_SCHEMAS['POST /projects/:projectId/library/papers/:paperId/pdf'] = {
  body: {
    type: 'object',
    required: ['file'],
    properties: {
      file: {
        type: 'string',
        contentEncoding: 'base64',
        contentMediaType: 'application/pdf',
        description: 'PDF part supplied through MCP transfer.',
      },
    },
  },
};

Object.assign(SHARED_RESPONSES, {
  'GET /projects/:projectId/plans': 'PlansOverview',
  'GET /projects/:projectId/plans/:planId': 'Plan',
  'PATCH /projects/:projectId/plans/:planId': 'Plan',
  'POST /projects/:projectId/plans/:planId/archive': 'Plan',
  'PUT /projects/:projectId/plans/:planId/content': 'Plan',
  'POST /projects/:projectId/plans/explorations': 'Plan',
  'GET /projects/:projectId/plans/:planId/versions/:version': 'PlanVersion',
  'GET /projects/:projectId/plans/proposals/:proposalId': 'BasisProposal',
  'POST /projects/:projectId/plans/proposals': 'BasisProposal',
  'PATCH /projects/:projectId/plans/proposals/:proposalId': 'BasisProposal',
  'POST /projects/:projectId/plans/proposals/:proposalId/submit': 'BasisProposal',
  'POST /projects/:projectId/plans/proposals/:proposalId/withdraw': 'BasisProposal',
  'POST /projects/:projectId/plans/memory': 'PersonalMemory',
  'PUT /projects/:projectId/plans/memory/:memoryId': 'PersonalMemory',
  'GET /projects/:projectId/plans/basis/:basisId': 'TeamBasis',
  'POST /projects/:projectId/boards': 'Board',
  'PATCH /projects/:projectId/boards/:boardId': 'Board',
  'POST /projects/:projectId/boards/:boardId/columns': 'BoardColumn',
  'PATCH /projects/:projectId/columns/:columnId': 'BoardColumn',
  'POST /projects/:projectId/boards/:boardId/cards': 'Card',
  'PATCH /projects/:projectId/cards/:cardId': 'Card',
  'POST /projects/:projectId/docs/import': 'DocumentMeta',
  'GET /projects/:projectId/docs/:docId': 'DocumentMeta',
  'POST /projects/:projectId/docs': 'DocumentMeta',
  'PATCH /projects/:projectId/docs/:docId': 'DocumentMeta',
  'POST /projects/:projectId/docs/:docId/versions/:versionId/restore': 'DocumentMeta',
  'POST /projects/:projectId/routines': 'Routine',
  'PATCH /projects/:projectId/routines/:routineId': 'Routine',
  'POST /projects/:projectId/agents/:sessionId/resume': 'AgentSession',
  'GET /projects/:projectId/agents/:sessionId': 'AgentSession',
  'POST /projects/:projectId/reviews': 'Review',
  'GET /projects/:projectId/reviews/:reviewId': 'Review',
  'POST /projects/:projectId/reviews/:reviewId/comments': 'ReviewComment',
  'PATCH /projects/:projectId/reviews/:reviewId/comments/:commentId': 'ReviewComment',
  'GET /projects/:projectId/reports/:reportId': 'Report',
  'POST /projects/:projectId/reports': 'Report',
  'PATCH /projects/:projectId/reports/:reportId': 'Report',
  'POST /projects/:projectId/library/papers/:paperId/reparse': 'Paper',
  'PATCH /projects/:projectId/library/papers/:paperId': 'Paper',
});

Object.assign(LOCAL_RESPONSES, {
  'GET /projects/:projectId/files/:fileId': {
    type: 'string',
    format: 'binary',
    description: 'File bytes; Content-Type is determined by the stored file.',
  },
  'GET /projects/:projectId/library/papers/:paperId/pdf': {
    type: 'string',
    format: 'binary',
    contentMediaType: 'application/pdf',
  },
  'GET /projects/:projectId/docs/:docId/latex/pdf/:pdfId': {
    type: 'string',
    format: 'binary',
    contentMediaType: 'application/pdf',
  },
  'GET /projects/:projectId/library/papers/:paperId/bibtex': {
    type: 'string',
    contentMediaType: 'text/x-bibtex',
  },
  'GET /projects/:projectId/research/records/:recordId/items/:itemId/table/export': {
    type: 'string',
    contentMediaType: 'text/csv',
  },
  'GET /projects/:projectId/research/artifacts/:artifactId/download': {
    type: 'string',
    format: 'binary',
    description: 'Artifact bytes; Content-Type is the stored artifact MIME type.',
  },
  'GET /projects/:projectId/research/snapshots/:snapshotId/download': {
    type: 'string',
    format: 'binary',
    description: 'Snapshot bytes; Content-Type is the stored snapshot MIME type.',
  },
});

export const SHARED_ARRAY_RESPONSES: Record<string, string> = {
  'GET /projects/:projectId/boards': 'Board',
  'GET /projects/:projectId/todos': 'Todo',
  'GET /projects/:projectId/docs': 'DocumentMeta',
  'GET /projects/:projectId/notebooks': 'Notebook',
  'GET /projects/:projectId/reviews': 'Review',
  'GET /projects/:projectId/reports': 'Report',
  'GET /projects/:projectId/plans/:planId/versions': 'PlanVersion',
  'GET /projects/:projectId/plans/proposals': 'BasisProposal',
  'GET /projects/:projectId/plans/memory': 'PersonalMemory',
  'GET /projects/:projectId/plans/basis': 'TeamBasis',
};
export const SHARED_PAGE_RESPONSES: Record<string, string> = {
  'GET /projects/:projectId/timeline': 'Message',
  'GET /projects/:projectId/threads/:threadId/messages': 'Message',
  'GET /projects/:projectId/threads': 'Thread',
};

Object.assign(SHARED_RESPONSES, {
  'GET /projects/:projectId/research/records/:recordId': 'ResearchRecordDetail',
  'POST /projects/:projectId/research/records': 'ResearchRecord',
  'PATCH /projects/:projectId/research/records/:recordId': 'ResearchRecord',
  'GET /projects/:projectId/research/items/:itemId': 'ResearchItem',
  'GET /projects/:projectId/research/records/:recordId/items/:itemId': 'ResearchItem',
  'POST /projects/:projectId/research/records/:recordId/items': 'ResearchItem',
  'PATCH /projects/:projectId/research/records/:recordId/items/:itemId': 'ResearchItem',
  'PATCH /projects/:projectId/research/records/:recordId/items/:itemId/position': 'ResearchItem',
  'GET /projects/:projectId/research/records/:recordId/items/:itemId/content':
    'ResearchItemContent',
  'GET /projects/:projectId/research/sources/:sourceId/availability': 'ResearchSourceAvailability',
  'POST /projects/:projectId/research/sources': 'ResearchSource',
  'POST /projects/:projectId/research/records/:recordId/sources': 'ResearchSource',
  'PATCH /projects/:projectId/research/sources/:sourceId': 'ResearchSource',
  'GET /projects/:projectId/research/snapshots/:snapshotId': 'ResearchSnapshot',
  'POST /projects/:projectId/research/sources/:sourceId/snapshots': 'ResearchSnapshot',
  'GET /projects/:projectId/research/findings/:findingId': 'ResearchFinding',
  'POST /projects/:projectId/research/records/:recordId/findings': 'ResearchFinding',
  'PATCH /projects/:projectId/research/findings/:findingId': 'ResearchFinding',
  'POST /projects/:projectId/research/records/:recordId/codes': 'ResearchCode',
  'PATCH /projects/:projectId/research/codes/:codeId': 'ResearchCode',
  'POST /projects/:projectId/research/records/:recordId/codings': 'ResearchCoding',
  'POST /projects/:projectId/research/records/:recordId/logs': 'ResearchLog',
  'GET /projects/:projectId/research/templates/:templateId/versions/:version': 'ResearchTemplate',
  'POST /projects/:projectId/research/templates': 'ResearchTemplate',
  'GET /projects/:projectId/research/records/:recordId/runs/:runId': 'ResearchRun',
  'GET /projects/:projectId/research/records/:recordId/runs/:runId/staleness':
    'ResearchRunStaleness',
  'POST /projects/:projectId/research/records/:recordId/runs': 'ResearchRun',
  'POST /projects/:projectId/research/records/:recordId/runs/:runId/cancel': 'ResearchRun',
  'POST /projects/:projectId/research/records/:recordId/runs/:runId/retry': 'ResearchRun',
  'GET /projects/:projectId/research/records/:recordId/recipes/:recipeId/versions/:version':
    'ResearchRecipe',
  'POST /projects/:projectId/research/records/:recordId/recipes': 'ResearchRecipe',
  'POST /projects/:projectId/research/records/:recordId/recipes/:recipeId/instantiate':
    'ResearchRun',
  'GET /projects/:projectId/messages/:messageId': 'Message',
  'PATCH /projects/:projectId/messages/:messageId': 'Message',
  'PATCH /auth/me': 'User',
  'PATCH /inbox/:itemId': 'InboxItem',
  'GET /projects/:projectId/shares/:kind/:id': 'ShareSettings',
  'PATCH /projects/:projectId/shares/:kind/:id/link': 'ShareSettings',
  'POST /projects/:projectId/shares/:kind/:id/link/reset': 'ShareSettings',
  'POST /share/:token': 'ShareResolveResult',
  'GET /projects/:projectId/library/papers/:paperId': 'PaperDetail',
  'POST /projects/:projectId/docs/:docId/move': 'DocumentMeta',
  'GET /projects/:projectId/threads/:threadId': 'Thread',
  'PATCH /projects/:projectId/threads/:threadId': 'Thread',
  'GET /projects/:projectId/research/artifacts/:artifactId': 'ResearchArtifactVersion',
});
Object.assign(SHARED_PAGE_RESPONSES, {
  'GET /projects/:projectId/research/records': 'ResearchRecord',
  'GET /projects/:projectId/research/records/:recordId/revisions': 'ResearchRecordRevision',
  'GET /projects/:projectId/research/records/:recordId/logs': 'ResearchLog',
  'GET /projects/:projectId/research/sources': 'ResearchSource',
  'GET /projects/:projectId/research/records/:recordId/sources': 'ResearchSource',
  'GET /projects/:projectId/research/sources/:sourceId/snapshots': 'ResearchSnapshot',
  'GET /projects/:projectId/research/records/:recordId/codes': 'ResearchCode',
  'GET /projects/:projectId/research/records/:recordId/codings': 'ResearchCoding',
  'GET /projects/:projectId/research/records/:recordId/findings': 'ResearchFinding',
  'GET /projects/:projectId/research/templates': 'ResearchTemplate',
  'GET /projects/:projectId/research/records/:recordId/items': 'ResearchItemSummary',
  'GET /projects/:projectId/research/records/:recordId/relations': 'ResearchRelation',
  'GET /projects/:projectId/research/records/:recordId/runs': 'ResearchRun',
  'GET /projects/:projectId/research/records/:recordId/recipes': 'ResearchRecipe',
});
Object.assign(SHARED_ARRAY_RESPONSES, {
  'GET /projects/:projectId/docs/:docId/comments': 'DocComment',
  'GET /projects/:projectId/docs/:docId/versions': 'DocumentVersion',
  'GET /projects/:projectId/routines': 'Routine',
  'GET /projects/:projectId/skills': 'Skill',
  'GET /projects/:projectId/commands': 'SlashCommand',
  'GET /projects/:projectId/profiles': 'AgentProfile',
  'GET /projects/:projectId/mcp-servers': 'McpServer',
});

Object.assign(SHARED_RESPONSES, {
  'GET /projects/:projectId/docs/:docId/markdown': 'DocumentContent',
  'POST /projects/:projectId/docs/:docId/comments': 'DocComment',
  'PATCH /projects/:projectId/docs/:docId/comments/:commentId': 'DocComment',
  'POST /projects/:projectId/docs/:docId/versions': 'DocumentVersion',
  'GET /projects/:projectId/versioning/settings': 'VersioningSettings',
  'GET /projects/:projectId/versions/:versionId': 'VersionDetail',
  'GET /projects/:projectId/proposals/:proposalId': 'ChangeProposal',
  'POST /projects/:projectId/research/records/:recordId/relations': 'ResearchRelation',
  'PATCH /projects/:projectId/research/records/:recordId/relations/:relationId': 'ResearchRelation',
  'PATCH /projects/:projectId/shares/:kind/:id/grants/:userId': 'ShareSettings',
  'DELETE /projects/:projectId/shares/:kind/:id/grants/:userId': 'ShareSettings',
  'POST /projects/:projectId/shares/:kind/:id/grants': 'ShareSettings',
  'POST /projects/:projectId/commands': 'SlashCommand',
  'PATCH /projects/:projectId/commands/:id': 'SlashCommand',
  'POST /projects/:projectId/profiles': 'AgentProfile',
  'PATCH /projects/:projectId/profiles/:id': 'AgentProfile',
  'POST /projects/:projectId/skills': 'Skill',
  'PATCH /projects/:projectId/skills/:id': 'Skill',
  'PATCH /projects/:projectId/agents/:sessionId/settings': 'AgentSession',
  'POST /projects/:projectId/reports/:reportId/regenerate': 'Report',
});
Object.assign(SHARED_PAGE_RESPONSES, {
  'GET /projects/:projectId/agents/:sessionId/steps': 'AgentStep',
  'GET /projects/:projectId/research/records/:recordId/items/:itemId/artifacts':
    'ResearchArtifactVersion',
});
Object.assign(SHARED_ARRAY_RESPONSES, {
  'GET /projects/:projectId/docs/search': 'DocumentSearchHit',
  'POST /projects/:projectId/reports/:reportId/todos': 'Todo',
});
Object.assign(SHARED_RESPONSES, {
  'POST /projects/:projectId/files': 'FileObject',
  'POST /projects/:projectId/library/papers/:paperId/pdf': 'Paper',
});
Object.assign(SHARED_ARRAY_RESPONSES, {
  'GET /projects/:projectId/files': 'FileObject',
});
Object.assign(SHARED_ARRAY_RESPONSES, {
  'GET /projects/:projectId/agents': 'AgentSession',
  'GET /projects/:projectId/library/papers': 'Paper',
  'GET /projects/:projectId/proposals': 'ChangeProposal',
  'GET /projects/:projectId/versions': 'Version',
});

const okResult = { type: 'object', required: ['ok'], properties: { ok: { const: true } } };
Object.assign(LOCAL_RESPONSES, {
  'POST /projects/:projectId/notebooks/:notebookId/interrupt': okResult,
  'POST /projects/:projectId/notebooks/:notebookId/shutdown': okResult,
  'POST /projects/:projectId/library/bibtex': { type: 'string', contentMediaType: 'text/x-bibtex' },
  'POST /projects/:projectId/docs/:docId/ai': {
    type: 'string',
    contentMediaType: 'text/plain',
    description: 'Streamed response body.',
  },
  'POST /projects/:projectId/library/qa': {
    type: 'string',
    contentMediaType: 'application/x-ndjson',
    description: 'Newline-delimited stream of answer events.',
  },
  'GET /projects/:projectId/notebooks/:notebookId/export': {
    type: 'string',
    format: 'binary',
    description: 'Export bytes and MIME type depend on requested format.',
  },
});
Object.assign(SHARED_RESPONSES, {
  'GET /projects/:projectId/decisions/:decisionId': 'Decision',
  'GET /projects/:projectId/docs/latex/capability': 'LatexCapability',
  'POST /projects/:projectId/docs/:docId/latex/compile': 'LatexCompileResult',
  'GET /projects/:projectId/library/status': 'LibraryStatus',
  'GET /projects/:projectId/memory/*': 'MemoryFile',
  'PUT /projects/:projectId/memory': 'MemoryFile',
  'POST /projects/:projectId/claims': 'WorkClaim',
  'POST /projects/:projectId/claims/:claimId/renew': 'WorkClaim',
  'POST /projects/:projectId/threads/:threadId/forward': 'Message',
  'PUT /projects/:projectId/messages/:messageId/reactions': 'Message',
  'DELETE /projects/:projectId/messages/:messageId/reactions/:emoji': 'Message',
  'GET /projects/:projectId/research/records/:recordId/items/:itemId/table':
    'ResearchStructuredTable',
  'POST /projects/:projectId/research/records/:recordId/excerpts': 'EvidenceExcerpt',
});
Object.assign(SHARED_ARRAY_RESPONSES, {
  'GET /projects/:projectId/claims': 'WorkClaim',
  'GET /projects/:projectId/members': 'ProjectMember',
  'GET /projects/:projectId/library/search': 'LibraryHit',
});
Object.assign(SHARED_PAGE_RESPONSES, {
  'GET /projects/:projectId/research': 'ResearchListItem',
  'GET /projects/:projectId/research/search': 'ResearchUnifiedSearchHit',
  'GET /projects/:projectId/research/records/:recordId/excerpts': 'EvidenceExcerpt',
});
Object.assign(LOCAL_RESPONSES, {
  'GET /auth/me/pins': {
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: '每个项目的置顶 ID 列表。',
  },
  'PUT /auth/me/pins/:projectId': {
    type: 'object',
    required: ['projectId', 'ids'],
    properties: {
      projectId: { type: 'string' },
      ids: { type: 'array', items: { type: 'string' } },
    },
  },
  'POST /projects/:projectId/docs/:docId/mentions': {
    type: 'object',
    required: ['notified'],
    properties: { notified: { type: 'array', items: { type: 'string' } } },
  },
  'GET /projects/:projectId/reports/:reportId/plan-items': {
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: { type: 'string' } } },
  },
});

Object.assign(SHARED_RESPONSES, {
  'GET /projects/:projectId/versions/current': 'VersionContent',
  'POST /projects/:projectId/versions': 'Version',
  'POST /projects/:projectId/versions/:versionId/restore': 'VersionRestoreResult',
});
Object.assign(SHARED_RESPONSES, {
  'POST /projects/:projectId/threads': 'Thread',
  'POST /projects/:projectId/notebooks/:notebookId/import': 'Notebook',
});
Object.assign(LOCAL_RESPONSES, {
  'GET /projects/:projectId/thread-summaries': {
    type: 'array',
    items: {
      type: 'object',
      required: ['threadId', 'outputs', 'openDecisions', 'waitingOn'],
      properties: {
        threadId: { type: 'string' },
        outputs: { type: 'number' },
        openDecisions: { type: 'number' },
        waitingOn: {
          type: 'array',
          items: {
            type: 'object',
            required: ['userId', 'kind', 'since'],
            properties: {
              userId: { type: 'string' },
              kind: { enum: ['decision', 'review', 'mention', 'conflict'] },
              since: { type: 'string' },
            },
          },
        },
      },
    },
  },
  'GET /integrations/operations': {
    type: 'object',
    required: ['items', 'coverage'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'id',
            'method',
            'path',
            'domain',
            'access',
            'effect',
            'description',
            'input',
            'response',
            'pagination',
            'conditions',
          ],
          properties: {
            id: { type: 'string' },
            method: { type: 'string' },
            path: { type: 'string' },
            domain: { type: 'string' },
            access: { enum: ['open'] },
            effect: { enum: ['read', 'write', 'execute'] },
            description: { type: 'string' },
            input: { type: 'object', description: '参数、查询和请求体 JSON Schema。' },
            response: { description: '响应 JSON Schema 或尚未登记时为 null。' },
            pagination: { type: 'string' },
            conditions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      coverage: {
        type: 'object',
        required: ['unclassified', 'registered', 'missingInput', 'missingResponse'],
        properties: {
          registered: { type: 'integer' },
          unclassified: { type: 'array', items: { type: 'string' } },
          missingInput: { type: 'array', items: { type: 'string' } },
          missingResponse: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
});
Object.assign(SHARED_RESPONSES, {
  'POST /projects/:projectId/research/workspaces': 'ResearchRecord',
  'GET /projects/:projectId/research/records/:recordId/workspace': 'ResearchWorkspace',
});
Object.assign(LOCAL_RESPONSES, {
  'POST /projects/:projectId/notebooks/:notebookId/complete': {
    type: 'object',
    required: ['matches', 'cursor_start', 'cursor_end'],
    properties: {
      matches: { type: 'array', items: { type: 'string' } },
      cursor_start: { type: 'integer' },
      cursor_end: { type: 'integer' },
      metadata: { type: 'object', description: 'Jupyter 内核返回的补全元数据。' },
    },
  },
  'POST /projects/:projectId/notebooks/:notebookId/inspect': {
    type: 'object',
    required: ['found', 'data'],
    properties: {
      found: { type: 'boolean' },
      data: { type: 'object', description: 'Jupyter MIME 类型与对应展示内容。' },
    },
  },
});

Object.assign(SHARED_RESPONSES, {
  'POST /projects/:projectId/library/papers/:paperId/move': 'Paper',
  'POST /projects/:projectId/skills/import': 'Skill',
});
Object.assign(LOCAL_RESPONSES, {
  'POST /projects/:projectId/routines/:routineId/run': {
    type: 'object',
    required: ['accepted'],
    properties: { accepted: { const: true } },
  },
  'POST /projects/:projectId/commands/run': {
    type: 'object',
    required: ['ok', 'text', 'messageId'],
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
      messageId: { type: ['string', 'null'] },
    },
  },
  'POST /projects/:projectId/library/cite': {
    type: 'object',
    required: ['docId', 'bibFile', 'keys', 'added', 'cite'],
    properties: {
      docId: { type: 'string' },
      bibFile: { type: 'string' },
      keys: { type: 'array', items: { type: 'string' } },
      added: { type: 'integer' },
      cite: { type: 'string' },
    },
  },
});
Object.assign(LOCAL_RESPONSES, {
  'GET /projects/:projectId/research/records/:recordId/export': {
    oneOf: [
      { type: 'string', description: 'Markdown 或 CSV 格式的研究导出。' },
      {
        type: 'object',
        required: [
          'exportedAt',
          'projectId',
          'record',
          'template',
          'revisions',
          'logs',
          'sources',
          'snapshots',
          'snapshotDownloads',
          'excerpts',
          'codes',
          'codings',
          'findings',
          'workspace',
        ],
        properties: {
          exportedAt: { type: 'string', format: 'date-time' },
          projectId: { type: 'string' },
          record: { type: 'object', description: 'ResearchRecord' },
          template: { type: 'object', description: 'ResearchTemplate' },
          revisions: { type: 'array', description: 'ResearchRecordRevision 列表' },
          logs: { type: 'array', description: 'ResearchLog 列表' },
          sources: { type: 'array', description: 'ResearchSource 列表' },
          snapshots: { type: 'array', description: 'ResearchSnapshot 列表' },
          snapshotDownloads: {
            type: 'array',
            description: '可下载快照的 ID、URL、覆盖类型和 SHA-256',
          },
          excerpts: { type: 'array', description: 'EvidenceExcerpt 列表' },
          codes: { type: 'array', description: 'ResearchCode 列表' },
          codings: { type: 'array', description: 'ResearchCoding 列表' },
          findings: { type: 'array', description: 'ResearchFinding 列表' },
          workspace: { type: 'object', description: '研究工作区归档。' },
        },
      },
    ],
  },
  'GET /projects/:projectId/events': {
    type: 'array',
    items: {
      type: 'object',
      required: ['seq', 'projectId', 'threadId', 'type', 'payload', 'actor', 'createdAt'],
      properties: {
        seq: { type: 'integer' },
        projectId: { type: 'string' },
        threadId: { type: ['string', 'null'] },
        type: { type: 'string', description: '事件类型。' },
        payload: { type: 'object', description: '字段取决于 type；参见项目事件契约。' },
        actor: {
          type: 'object',
          required: ['kind', 'id', 'name'],
          properties: {
            kind: { enum: ['user', 'agent', 'system'] },
            id: { type: ['string', 'null'] },
            name: { type: 'string' },
          },
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
});
