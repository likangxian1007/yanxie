import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { mailProvider, sendMail, smtpTransportOptions, type MailLogger } from '../src/mail';

/** 邮件模块：选择发信方式、SMTP 的 TLS 参数，并用一个最小 SMTP 服务器走一遍真实 nodemailer 发送 */
const silent: MailLogger = { info: () => {}, warn: () => {} };
const msg = {
  to: 'user@example.com',
  subject: '重置你的研协密码 / Reset your Thinkloft password',
  text: '中文正文\n\nEnglish body https://co.example.io/app/reset-password?token=abc',
  html: '<p>中文正文</p><p>English body</p>',
};
const smtpEnv = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'u@example.com',
  SMTP_PASS: 'not-a-real-secret',
};

describe('mailProvider', () => {
  it('RESEND_API_KEY 优先，其次 SMTP 齐全，否则只写日志', () => {
    expect(mailProvider(loadConfig({}))).toBe('log');
    expect(mailProvider(loadConfig({ SMTP_HOST: 'h', SMTP_USER: 'u' }))).toBe('log');
    expect(mailProvider(loadConfig(smtpEnv))).toBe('smtp');
    expect(mailProvider(loadConfig({ ...smtpEnv, RESEND_API_KEY: 're_x' }))).toBe('resend');
  });

  it('未配置时只写日志、带上链接，并返回成功', async () => {
    const logged: unknown[] = [];
    const res = await sendMail(loadConfig({}), msg, {
      info: (o) => logged.push(o),
      warn: () => {},
    });
    expect(res).toEqual({ provider: 'log', ok: true });
    expect(JSON.stringify(logged)).toContain('/reset-password?token=abc');
  });
});

describe('smtpTransportOptions', () => {
  it('SMTP 587：默认强制 STARTTLS', () => {
    const o = smtpTransportOptions(loadConfig({ ...smtpEnv, SMTP_PORT: '587' }));
    expect(o).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      auth: { user: 'u@example.com', pass: 'not-a-real-secret' },
    });
  });

  it('465 默认直连 TLS', () => {
    const o = smtpTransportOptions(loadConfig({ ...smtpEnv, SMTP_PORT: '465' }));
    expect(o).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
  });

  it('SMTP_SECURE 显式覆盖端口推断', () => {
    expect(
      smtpTransportOptions(loadConfig({ ...smtpEnv, SMTP_SECURE: 'false', SMTP_PORT: '465' }))
        .secure,
    ).toBe(false);
    expect(
      smtpTransportOptions(loadConfig({ ...smtpEnv, SMTP_SECURE: 'true', SMTP_PORT: '2465' }))
        .secure,
    ).toBe(true);
  });

  it('SMTP_STARTTLS=false 时不升级 TLS（仅内网中继用）', () => {
    const o = smtpTransportOptions(loadConfig({ ...smtpEnv, SMTP_STARTTLS: 'false' }));
    expect(o).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
  });
});

/** 极简 SMTP 服务器：不支持 STARTTLS，记录收到的命令和正文 */
function fakeSmtp() {
  const commands: string[] = [];
  let data = '';
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    let inData = false;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        commands.push(line);
        const cmd = line.split(' ')[0]!.toUpperCase();
        if (cmd === 'EHLO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') sock.write('235 ok\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return {
    commands,
    data: () => data,
    listen: () =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
      ),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('SMTP 发送（真实 nodemailer）', () => {
  let srv: ReturnType<typeof fakeSmtp> | null = null;
  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  it('关闭 STARTTLS 时能完成 AUTH 并发出中英双语、HTML+纯文本邮件，发件人用 MAIL_FROM', async () => {
    srv = fakeSmtp();
    const port = await srv.listen();
    const config = loadConfig({
      ...smtpEnv,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_STARTTLS: 'false',
      MAIL_FROM: '研协 <no-reply@example.com>',
    });
    const res = await sendMail(config, msg, silent);
    expect(res).toEqual({ provider: 'smtp', ok: true });
    expect(srv.commands.some((c) => c.startsWith('AUTH'))).toBe(true);
    expect(srv.commands).toContain('MAIL FROM:<no-reply@example.com>');
    expect(srv.commands).toContain('RCPT TO:<user@example.com>');
    const raw = srv.data();
    expect(raw).toMatch(/multipart\/alternative/u);
    expect(raw).toMatch(/text\/plain/u);
    expect(raw).toMatch(/text\/html/u);
  });

  it('要求 STARTTLS 而服务器不支持时拒绝明文发送，返回失败但不抛错', async () => {
    srv = fakeSmtp();
    const port = await srv.listen();
    const warned: unknown[] = [];
    const res = await sendMail(
      loadConfig({ ...smtpEnv, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port) }),
      msg,
      { info: () => {}, warn: (o) => warned.push(o) },
    );
    expect(res.provider).toBe('smtp');
    expect(res.ok).toBe(false);
    expect(warned).toHaveLength(1);
    expect(srv.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
    expect(srv.commands.some((c) => c.startsWith('MAIL FROM'))).toBe(false);
  }, 20_000);
});
