import OpenAI from 'openai';
import type { AppConfig } from '../../config';

/**
 * LLM 客户端：DeepSeek 的 OpenAI 兼容接口（base URL https://api.deepseek.com）。
 * 后端线程在此基础上实现：流式输出 → bus.ephemeral('agent.delta')，tool calling，
 * token 计数写 agent_sessions.token_usage，429/5xx 指数退避重试。
 */
export interface LlmClient {
  client: OpenAI;
  model: string;
  reasoningModel: string;
}

export function createLlmClient(config: AppConfig): LlmClient | null {
  if (!config.llmConfigured) return null;
  return {
    client: new OpenAI({ apiKey: config.LLM_API_KEY, baseURL: config.LLM_BASE_URL, maxRetries: 2 }),
    model: config.LLM_MODEL,
    reasoningModel: config.LLM_MODEL_REASONING,
  };
}
