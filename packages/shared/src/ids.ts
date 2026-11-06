/**
 * ID 规则：`<前缀>_<26 位 ULID>`，按时间可排序，可直接用作分页游标。
 * 前缀让日志和链接一眼看出对象类型；数据库里统一用 text 存。
 */
export const ID_PREFIX = {
  user: 'usr',
  authSession: 'ses',
  project: 'prj',
  invite: 'inv',
  thread: 'thr',
  message: 'msg',
  agentSession: 'agt',
  agentStep: 'stp',
  decision: 'dec',
  output: 'out',
  memory: 'mem',
  claim: 'clm',
  routine: 'rtn',
  file: 'fil',
  document: 'doc',
  documentVersion: 'dv',
  board: 'brd',
  column: 'col',
  card: 'crd',
  todo: 'tdo',
  experiment: 'exp',
  experimentLog: 'elg',
  review: 'rev',
  reviewComment: 'rvc',
  report: 'rpt',
  inbox: 'ibx',
  notebook: 'nb',
  llmProvider: 'llm',
  mcpServer: 'mcp',
  skill: 'skl',
  slashCommand: 'cmd',
  agentProfile: 'prf',
  version: 'ver',
  proposal: 'cp',
  researchTemplate: 'rtpl',
  researchRecord: 'rrc',
  researchRevision: 'rrv',
  researchLog: 'rlg',
  researchSource: 'rsr',
  researchSnapshot: 'rss',
  researchExcerpt: 'rex',
  researchCode: 'rcd',
  researchCoding: 'rcg',
  researchFinding: 'rfd',
  apiToken: 'tok',
  apiOperationRequest: 'aor',
  apiOperationAudit: 'aua',
  notifySubscription: 'nsub',
  notifyDelivery: 'ndlv',
  // 反馈与运维（feat/feedback-center）
  ticket: 'tkt',
  ticketMessage: 'tkm',
  changelog: 'chg',
  opsEvent: 'ope',
  userNotification: 'unt',
  passwordReset: 'pwr',
  // 按量计费与充值（feat/models-billing）
  credit: 'cr',
  payOrder: 'po',
} as const;

export type IdKind = keyof typeof ID_PREFIX;
export type IdPrefix = (typeof ID_PREFIX)[IdKind];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let out = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CROCKFORD[b % 32];
  return out;
}

/** 生成一个 ULID（26 位 Crockford base32）。 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom(16);
}

/** 生成带前缀的 ID，例如 newId('project') → "prj_01JB…" */
export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIX[kind]}_${ulid(now)}`;
}

/** 判断一个字符串是否为某类 ID（只校验前缀与长度）。 */
export function isId(kind: IdKind, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(`${ID_PREFIX[kind]}_`) &&
    value.length === ID_PREFIX[kind].length + 27
  );
}
