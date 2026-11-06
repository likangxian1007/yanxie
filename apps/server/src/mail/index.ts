import type { AppConfig } from '../config';

/**
 * 发邮件（不绑定服务商，只看环境变量）：
 * - RESEND_API_KEY 有值 → Resend HTTP API（POST https://api.resend.com/emails）
 * - SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS 都有值 → nodemailer 走 SMTP
 * - 都没有 → 不发，只把内容写进日志（本地开发从日志里点链接）
 * 发件人是 MAIL_FROM。调用方不应 await 到响应路径里（避免按耗时探测账号），失败只记日志。
 */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export type MailProvider = 'resend' | 'smtp' | 'log';

export interface MailResult {
  provider: MailProvider;
  ok: boolean;
  error?: string;
}

const RESEND_URL = 'https://api.resend.com/emails';
const MAIL_TIMEOUT_MS = 15_000;

/** 当前配置用哪种方式发信 */
export function mailProvider(config: AppConfig): MailProvider {
  if (config.RESEND_API_KEY) return 'resend';
  if (config.SMTP_HOST && config.SMTP_PORT && config.SMTP_USER && config.SMTP_PASS) return 'smtp';
  return 'log';
}

/** 仅测试用：拦截发出的邮件（null 恢复真实发送） */
let senderOverride: ((msg: MailMessage) => void | Promise<void>) | null = null;
export function setMailSenderForTests(fn: ((msg: MailMessage) => void | Promise<void>) | null) {
  senderOverride = fn;
}

async function sendViaResend(config: AppConfig, msg: MailMessage): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.MAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Resend 返回 ${res.status}：${body}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** SMTP 连接参数：465 直连 TLS；其他端口默认强制 STARTTLS（SMTP_STARTTLS=false 时才允许明文） */
export function smtpTransportOptions(config: AppConfig) {
  const secure = config.SMTP_SECURE
    ? ['1', 'true', 'yes', 'on'].includes(config.SMTP_SECURE.toLowerCase())
    : config.SMTP_PORT === 465;
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure,
    requireTLS: !secure && config.SMTP_STARTTLS,
    ignoreTLS: !secure && !config.SMTP_STARTTLS,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  };
}

async function sendViaSmtp(config: AppConfig, msg: MailMessage): Promise<void> {
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    ...smtpTransportOptions(config),
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  });
  try {
    await transport.sendMail({
      from: config.MAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
  } finally {
    transport.close();
  }
}

/** 发一封邮件；不抛错，结果写日志并返回 */
export async function sendMail(
  config: AppConfig,
  msg: MailMessage,
  log: MailLogger,
): Promise<MailResult> {
  const provider = mailProvider(config);
  try {
    if (senderOverride) {
      await senderOverride(msg);
      return { provider, ok: true };
    }
    if (provider === 'resend') await sendViaResend(config, msg);
    else if (provider === 'smtp') await sendViaSmtp(config, msg);
    else {
      log.info(
        { to: msg.to, subject: msg.subject, text: msg.text },
        '[mail] 未配置发信服务，邮件只写日志',
      );
      return { provider, ok: true };
    }
    log.info({ to: msg.to, provider }, '[mail] 已发送');
    return { provider, ok: true };
  } catch (err) {
    const error = (err as Error).message;
    log.warn({ to: msg.to, provider, error }, '[mail] 发送失败');
    return { provider, ok: false, error };
  }
}
