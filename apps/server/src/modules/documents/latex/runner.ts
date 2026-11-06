import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { LatexOptions } from './config';

/**
 * 编译器进程的启动与限制（超时、输出大小、最小环境变量、可选 bubblewrap 沙箱）。
 * 只负责“在 dir 里把 main.tex 编成 main.pdf / main.log”，读结果、判定状态在 service.ts。
 * 测试里用 setLatexRunner 换成假的 runner，不需要真的装编译器。
 */
export type LatexEngine = 'tectonic' | 'latexmk';

export interface LatexRunInput {
  /** 工作目录（已写好 main.tex 等文件） */
  dir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LatexRunOutput {
  exitCode: number | null;
  timedOut: boolean;
  /** 编译器的标准输出 + 标准错误（截断） */
  output: string;
}

export type LatexProbe = { ok: true; version: string } | { ok: false; reason: string };

export interface LatexRunner {
  engine: LatexEngine;
  probe(): Promise<LatexProbe>;
  run(input: LatexRunInput): Promise<LatexRunOutput>;
}

const MAX_OUTPUT_CHARS = 256 * 1024;

/** 传给编译器的环境变量白名单（不能把服务端的密钥带进 TeX 进程） */
const ENV_PASSTHROUGH = [
  'PATH',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'TEXMFHOME',
  'TEXMFVAR',
  'TEXMFCONFIG',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
];

export function childEnv(opts: LatexOptions, dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const key of ENV_PASSTHROUGH) {
    // Windows 的环境变量名不区分大小写：同名只取一次
    const norm = process.platform === 'win32' ? key.toUpperCase() : key;
    if (seen.has(norm)) continue;
    const v = process.env[key];
    if (v !== undefined) {
      env[key] = v;
      seen.add(norm);
    }
  }
  // POSIX：HOME 指向工作目录（缓存目录另由 TECTONIC_CACHE_DIR 指定）。
  // Windows 上 tectonic 用系统 API 查“标准目录”，把 USERPROFILE / APPDATA 指到别处反而会失败，所以不设。
  if (process.platform !== 'win32') env.HOME = dir;
  env.TMPDIR = dir;
  env.TEMP = dir;
  env.TMP = dir;
  env.LANG = 'C.UTF-8';
  env.LC_ALL = 'C.UTF-8';
  env.NO_COLOR = '1';
  env.TECTONIC_CACHE_DIR = opts.cacheDir;
  // TeX Live（latexmk）：只允许读写工作目录内的文件（禁止绝对路径和 ..）
  env.openin_any = 'p';
  env.openout_any = 'p';
  env.shell_escape = 'f';
  return env;
}

interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  spawnError: NodeJS.ErrnoException | null;
}

/** 启动子进程，超时或取消时杀掉整个进程组；输出只保留前 MAX_OUTPUT_CHARS 个字符 */
export function execLimited(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolveExec) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const posix = process.platform !== 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX：独立进程组，超时时连同 bibtex / xdvipdfmx 子进程一起杀
        detached: posix,
      });
    } catch (err) {
      resolveExec({
        exitCode: null,
        timedOut: false,
        output: '',
        spawnError: err as NodeJS.ErrnoException,
      });
      return;
    }
    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // 已经退出
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const finish = (exitCode: number | null, spawnError: NodeJS.ErrnoException | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolveExec({
        exitCode,
        timedOut,
        output: output.slice(0, MAX_OUTPUT_CHARS),
        spawnError,
      });
    };
    child.on('error', (err) => finish(null, err as NodeJS.ErrnoException));
    child.on('close', (code) => finish(code, null));
  });
}

/** LATEX_SANDBOX=bwrap：只读挂载系统目录，只有工作目录和宏包缓存可写，看不到服务端的文件与进程 */
export function wrapSandbox(
  opts: LatexOptions,
  dir: string,
  cmd: string,
  args: string[],
): { cmd: string; args: string[] } {
  if (opts.sandbox !== 'bwrap') return { cmd, args };
  const ro = (p: string) => ['--ro-bind-try', p, p];
  const bin = isAbsolute(cmd) ? ro(dirname(cmd)) : [];
  return {
    cmd: 'bwrap',
    args: [
      '--die-with-parent',
      '--unshare-all',
      '--share-net',
      ...ro('/usr'),
      ...ro('/bin'),
      ...ro('/lib'),
      ...ro('/lib64'),
      ...ro('/etc/ssl'),
      ...ro('/etc/ca-certificates'),
      ...ro('/etc/resolv.conf'),
      ...ro('/etc/hosts'),
      ...ro('/etc/fonts'),
      ...ro('/etc/texmf'),
      ...bin,
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--bind',
      opts.cacheDir,
      opts.cacheDir,
      '--bind',
      dir,
      dir,
      '--chdir',
      dir,
      '--',
      cmd,
      ...args,
    ],
  };
}

function spawnFailure(cmd: string, err: NodeJS.ErrnoException): string {
  return err.code === 'ENOENT'
    ? `找不到编译器 ${cmd}（请安装，或用环境变量指定路径）`
    : `无法启动编译器 ${cmd}：${err.message}`;
}

async function probeVersion(cmd: string, args: string[], opts: LatexOptions): Promise<LatexProbe> {
  const r = await execLimited(cmd, args, {
    cwd: process.cwd(),
    env: childEnv(opts, process.cwd()),
    timeoutMs: 15_000,
  });
  if (r.spawnError) return { ok: false, reason: spawnFailure(cmd, r.spawnError) };
  if (r.timedOut) return { ok: false, reason: `${cmd} --version 超时` };
  if (r.exitCode !== 0) return { ok: false, reason: `${cmd} 无法运行（退出码 ${r.exitCode}）` };
  const line = r.output.split(/\r?\n/u).find((l) => l.trim()) ?? '';
  return { ok: true, version: line.trim().slice(0, 120) };
}

/**
 * Tectonic（XeTeX 内核，自带 TeX Live 宏包按需下载与缓存，自动跑 BibTeX 和多遍编译）：
 *   tectonic -X compile main.tex --keep-logs --untrusted -Z continue-on-errors
 * --untrusted 关闭 shell-escape 等不安全特性；continue-on-errors 让有错误时也尽量出 PDF（同 Overleaf）。
 */
export function tectonicRunner(opts: LatexOptions): LatexRunner {
  const cmd = opts.tectonicPath;
  return {
    engine: 'tectonic',
    probe: () => probeVersion(cmd, ['--version'], opts),
    async run({ dir, timeoutMs, signal }) {
      await mkdir(opts.cacheDir, { recursive: true });
      const args = [
        '-X',
        'compile',
        'main.tex',
        '--keep-logs',
        '--untrusted',
        '-Z',
        'continue-on-errors',
        ...(opts.offline ? ['--only-cached'] : []),
      ];
      const w = wrapSandbox(opts, dir, cmd, args);
      const r = await execLimited(w.cmd, w.args, {
        cwd: dir,
        env: childEnv(opts, dir),
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (r.spawnError) throw new Error(spawnFailure(w.cmd, r.spawnError));
      return { exitCode: r.exitCode, timedOut: r.timedOut, output: r.output };
    },
  };
}

/**
 * latexmk + XeLaTeX（需要完整 TeX Live：xelatex、bibtex、ctex 宏包）：
 *   latexmk -xelatex -bibtex -f -interaction=nonstopmode -file-line-error -no-shell-escape main.tex
 * 环境变量 openin_any=p / openout_any=p 禁止读写工作目录以外的文件。
 */
export function latexmkRunner(opts: LatexOptions): LatexRunner {
  const cmd = opts.latexmkPath;
  return {
    engine: 'latexmk',
    probe: () => probeVersion(cmd, ['-v'], opts),
    async run({ dir, timeoutMs, signal }) {
      const args = [
        '-xelatex',
        '-bibtex',
        '-f',
        '-interaction=nonstopmode',
        '-file-line-error',
        '-no-shell-escape',
        '-latexoption=-no-shell-escape',
        'main.tex',
      ];
      const w = wrapSandbox(opts, dir, cmd, args);
      const r = await execLimited(w.cmd, w.args, {
        cwd: dir,
        env: childEnv(opts, dir),
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (r.spawnError) throw new Error(spawnFailure(w.cmd, r.spawnError));
      return { exitCode: r.exitCode, timedOut: r.timedOut, output: r.output };
    },
  };
}
