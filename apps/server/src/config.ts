import { z } from 'zod';

/**
 * 环境变量的唯一读取点。其他模块只从 AppConfig 取值，不直接读 process.env。
 * 变量说明见仓库根目录 .env.example。
 */
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().default('dev-insecure-secret-change-me'),
  /** 空 = PGlite；`pglite:memory` = 内存 PGlite（测试）；`pglite:<dir>` = 指定目录 */
  DATABASE_URL: z.string().default(''),
  DB_AUTO_MIGRATE: bool.default(true),
  LLM_BASE_URL: z.string().default('https://api.deepseek.com'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('deepseek-chat'),
  LLM_MODEL_REASONING: z.string().default('deepseek-reasoner'),
  /**
   * 主 provider（上面 LLM_BASE_URL / LLM_API_KEY）提供的模型，逗号分隔；空 = 按接口自动推断
   * （DeepSeek 官方：deepseek-flash, deepseek-v4-pro；其他：LLM_MODEL 与 LLM_MODEL_REASONING）
   */
  LLM_MODELS: z.string().default(''),
  /** 额外 provider，JSON 数组（格式见 .env.example 与 ARCHITECTURE.md §7.6） */
  LLM_PROVIDERS: z.string().default(''),
  /** 新会话默认模型 `<provider>/<model>`；空 = 主 provider 的第一个模型 */
  LLM_DEFAULT_MODEL: z.string().default(''),
  /** 新会话默认推理强度 off / low / medium / high / max */
  LLM_DEFAULT_EFFORT: z.enum(['off', 'low', 'medium', 'high', 'max']).default('high'),
  /**
   * 混合 AI（agents/llm/hybrid.ts）：本机推理服务的 OpenAI 兼容地址，例如 OpenVINO Model Server
   * http://127.0.0.1:8000/v3 或 Ollama http://127.0.0.1:11434/v1。空 = 不启用，一切走云端。
   */
  LOCAL_LLM_BASE_URL: z.string().default(''),
  LOCAL_LLM_API_KEY: z.string().default(''),
  /** 本地模型名（OVMS 的 --model_name / Ollama 的模型 tag） */
  LOCAL_LLM_MODEL: z.string().default(''),
  /** 本地模型跑在什么硬件上（只用于展示），例如 Intel Arc GPU / Intel NPU */
  LOCAL_LLM_DEVICE: z.string().default(''),
  /** 本地模型一次能吃下的最大输入（字符），超过就交给云端 */
  LOCAL_LLM_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(24_000),
  /** 分流规则 JSON：{"doc-polish":"local","report":"cloud",...}；值 local / cloud / auto */
  HYBRID_ROUTES: z.string().default(''),
  /** 发往云端前先脱敏（数值、联系方式、编号、人名），回来后在本地还原 */
  HYBRID_REDACT: bool.default(true),
  /**
   * 整篇 PDF 保版式翻译服务（tools/pdf-translate，基于 AGPL 的 pdf2zh-next，独立进程）地址，
   * 例如 http://127.0.0.1:8090。空 = 不启用，界面不显示「翻译 PDF」。
   */
  PDF_TRANSLATE_URL: z.string().default(''),
  /** agent 上下文窗口（token，估算口径见 agents/runtime/budget.ts）；换更小窗口的模型时调小 */
  AGENT_CONTEXT_TOKENS: z.coerce.number().int().min(8_000).default(128_000),
  /** 窗口里给输出（含推理）预留的 token */
  AGENT_OUTPUT_RESERVE_TOKENS: z.coerce.number().int().min(1_000).default(16_000),
  /** 读图用的视觉模型 `<providerId>/<model>`（OpenAI 兼容、支持 image_url）；空 = 只做 OCR */
  VISION_MODEL: z.string().default(''),
  /** OCR 语言包缓存目录；空 = <STORAGE_DIR>/../ocr-lang */
  OCR_LANG_DIR: z.string().default(''),
  /** OCR 语言包下载地址（tesseract.js 的 langPath）；空 = tesseract.js 默认 CDN */
  OCR_LANG_URL: z.string().default(''),
  /** 允许配置 stdio MCP 服务器（会在服务器上起子进程；只给项目管理者开放） */
  MCP_ALLOW_STDIO: bool.default(false),
  STORAGE_DIR: z.string().default('.data/storage'),
  /** 生产环境前端构建产物目录（Node 同时托管静态文件）；空 = 不托管 */
  WEB_DIST_DIR: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** 本地开发：未实现登录前让 /ws 以匿名访客放行。生产环境忽略此项 */
  REALTIME_DEV_ANON: bool.default(false),
  /** 在反向代理（Caddy/Nginx）后面时开启，才信任 X-Forwarded-* 头 */
  TRUST_PROXY: bool.default(false),
  // ---- 接入：API 令牌（modules/integrations，API.md §2.21）----
  /** 允许用 API 令牌（Authorization: Bearer srh_pat_…）访问 REST 与实时通道。先建令牌后打开也有效 */
  API_TOKENS_ENABLED: bool.default(false),
  /** 每张令牌每分钟的调用上限（超了返回 429 + Retry-After） */
  API_TOKENS_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
  // ---- 接入：MCP 服务端（modules/mcp，API.md §2.22）----
  /** 允许外部 agent 用 MCP 接进来（POST /api/v1/mcp，Bearer srh_pat_…）。需要同时打开 API_TOKENS_ENABLED */
  MCP_ENABLED: bool.default(false),
  /** 每张令牌每天的「写操作」上限（发消息 / 建待办 / 标完成），防 agent 死循环刷屏；读操作不占额度 */
  MCP_WRITE_PER_DAY: z.coerce.number().int().min(1).max(10_000).default(200),
  // ---- 接入：通知订阅（modules/notify，只支持飞书/企业微信/钉钉群机器人）----
  /** 允许用户配置群机器人 webhook，项目里有事时推到群里。默认关 */
  NOTIFY_ENABLED: bool.default(false),
  /** 每人最多几个订阅 */
  NOTIFY_MAX_PER_USER: z.coerce.number().int().min(1).max(20).default(3),
  // ---- 反馈与运维后台（modules/feedback、modules/admin）----
  /** 站点管理员邮箱，逗号分隔；这些账号登录 / 注册 / 读会话时自动设为管理员（只升不降） */
  ADMIN_EMAILS: z.string().default(''),
  // ---- 邮件（src/mail，找回密码；不绑定服务商）----
  /** 发件人，例：研协 <no-reply@example.com> */
  MAIL_FROM: z.string().default('研协 <no-reply@example.com>'),
  /** 设置后走 Resend HTTP API（优先于 SMTP） */
  RESEND_API_KEY: z.string().default(''),
  /** SMTP 四项都填才启用（nodemailer） */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  /** 连接一开始就走 TLS（465 端口）。空 = 端口为 465 时自动开，其余端口关 */
  SMTP_SECURE: z.string().default(''),
  /** 非 TLS 直连时强制 STARTTLS 升级（587）；服务器不支持就报错不发。仅本地测试服务器才关 */
  SMTP_STARTTLS: bool.default(true),
  // ---- 联网搜索（src/websearch，ARCHITECTURE.md §12）----
  /** 允许 agent 联网：web_search 通用搜索、paper_search 学术检索、fetch_url 抓取正文（代码默认关闭，Compose 部署默认开启） */
  AGENT_WEB: bool.default(false),
  /** 旧名字，等同 AGENT_WEB（保留兼容） */
  AGENT_FETCH_URL: bool.default(false),
  /** 自托管 SearXNG 地址（Compose 内为 http://searxng:8080）；空 = 不用 SearXNG */
  SEARXNG_URL: z.string().default(''),
  /** SearXNG 不可用或没结果时的退路 */
  WEB_SEARCH_FALLBACK: z.enum(['duckduckgo', 'none']).default('duckduckgo'),
  /** 学术 API 的礼貌联系邮箱（OpenAlex / Crossref 的 polite pool，限流更宽松） */
  RESEARCH_CONTACT_EMAIL: z.string().default(''),
  /** Semantic Scholar API key（可选；没有时走公共限流，偶尔 429） */
  SEMANTIC_SCHOLAR_API_KEY: z.string().default(''),
  // ---- 联网搜索 end ----

  // ---- notebook 内核（见 deploy/kernel/README.md）
  /**
   * none = 不提供内核（notebook 只能编辑）；
   * gateway = 连一个现成的 Jupyter Kernel Gateway（本地开发，KERNEL_GATEWAY_URL）；
   * docker = 每个项目起一个隔离容器（生产，经 DOCKER_HOST 调 Docker Engine API）。
   */
  KERNEL_MODE: z.enum(['none', 'gateway', 'docker']).default('none'),
  KERNEL_GATEWAY_URL: z.string().default('http://127.0.0.1:8888'),
  KERNEL_GATEWAY_TOKEN: z.string().default(''),
  DOCKER_HOST: z.string().default('unix:///var/run/docker.sock'),
  KERNEL_IMAGE: z.string().default('srh-kernel:latest'),
  /** 内核容器所在的内部网络（app 也要接入）；internal 网络没有外网 */
  KERNEL_NETWORK: z.string().default('srh-kernels'),
  /** app 容器自己的名字（docker 模式下把它接入内核网络）；空 = 不自动接入 */
  KERNEL_APP_CONTAINER: z.string().default(''),
  /** 允许内核访问外网（pip install、下载数据集）；默认关闭 */
  KERNEL_ALLOW_INTERNET: bool.default(false),
  /** pip 白名单代理的容器名（deploy/pypi-proxy，只放行 PyPI）；留空 = 内核完全不能联网 */
  KERNEL_PIP_PROXY_CONTAINER: z.string().default(''),
  KERNEL_CPUS: z.coerce.number().positive().default(2),
  KERNEL_MEMORY_MB: z.coerce.number().int().positive().default(2048),
  /** 内核空闲多少分钟后停掉容器（变量会丢，文件留在项目数据卷里）；0 = 不停 */
  KERNEL_IDLE_MINUTES: z.coerce.number().int().nonnegative().default(60),
  /** 全服务器同时运行的内核上限；满了先休眠最久没用的，都在忙就提示资源不足。0 = 不限 */
  KERNEL_MAX_RUNNING: z.coerce.number().int().nonnegative().default(3),
  /** 导出 PDF 用的 Chromium；空 = 自动找（/usr/bin/chromium、Playwright 下载的） */
  PDF_CHROMIUM_PATH: z.string().default(''),
  // ---- 文献库（feat/paper-library，见 .env.example）----
  /** 论文解析器：grobid（默认，CPU 即可）| mineru（需自备 GPU 服务） */
  PAPER_PARSER: z.enum(['grobid', 'mineru']).default('grobid'),
  /** GROBID 服务地址；不可达时降级为逐页纯文本 */
  GROBID_URL: z.string().default('http://localhost:8070'),
  /** MinerU 服务地址（PAPER_PARSER=mineru 时用；仅预留，未验证） */
  MINERU_URL: z.string().default(''),
  /** 调 Crossref / OpenAlex / Semantic Scholar 时附带的联系邮箱（礼貌池）；空时用 RESEARCH_CONTACT_EMAIL */
  CROSSREF_MAILTO: z.string().default(''),
  /** 单篇 PDF 解析超时（秒） */
  PAPER_PARSE_TIMEOUT_SEC: z.coerce.number().int().min(10).max(1800).default(300),
  // ---- 多模型与计费（modules/billing，API.md §2.24）----
  /** OpenRouter key；设了就启用内置 provider `openrouter`（千问 / GLM / Kimi / Claude / GPT / Gemini） */
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  /** 按量计费总开关：关闭时不拦截、不扣费（用量照常记录） */
  BILLING_ENABLED: bool.default(false),
  /** 零售价 = 成本 × 倍率；1 积分 = 0.001 美元 */
  BILLING_MARKUP: z.coerce.number().min(1).max(100).default(1.6),
  /** 每个账号一次性赠送的积分（首次读余额时发放，幂等；调高后老用户补差一次）。2800 ≈ ¥20 */
  BILLING_SIGNUP_CREDITS: z.coerce.number().int().min(0).max(1_000_000).default(2800),
  /** KyrenPay 充值（没配 key 时充值入口自动隐藏） */
  KYREN_API_KEY: z.string().default(''),
  KYREN_WEBHOOK_SECRET: z.string().default(''),
  KYREN_MERCHANT_NAME: z.string().default('研协'),
  KYREN_BASE_URL: z.string().default('https://api.kyrenpay.com'),
});

const PLACEHOLDER_SECRETS = [
  'change-me',
  'change-me-to-a-long-random-string',
  'changeme',
  'secret',
];

export type AppConfig = z.infer<typeof EnvSchema> & {
  /** 是否配置了真实的 LLM key */
  llmConfigured: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // 空字符串视为未设置，方便 .env 里留空
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.parse(cleaned);
  if (parsed.NODE_ENV === 'production') {
    const s = parsed.SESSION_SECRET;
    if (s.startsWith('dev-insecure') || PLACEHOLDER_SECRETS.includes(s) || s.length < 32) {
      throw new Error('生产环境必须把 SESSION_SECRET 设为 32 位以上的随机串（不能用示例占位值）');
    }
  }
  return {
    ...parsed,
    llmConfigured: parsed.LLM_API_KEY.length > 0 && !parsed.LLM_API_KEY.includes('your-'),
  };
}
