import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNamedVolumeBind, DockerClient, demuxDockerStream } from '../src/sandbox/docker';
import { IdleReaper } from '../src/sandbox/idle';

function frame(type: number, text: string): Buffer {
  const data = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = type;
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data]);
}

describe('sandbox/docker', () => {
  it('demuxes attach streams', () => {
    const buf = Buffer.concat([frame(1, 'out1 '), frame(2, 'err'), frame(1, 'out2')]);
    expect(demuxDockerStream(buf)).toEqual({ stdout: 'out1 out2', stderr: 'err' });
    expect(demuxDockerStream(Buffer.from('tty'))).toEqual({ stdout: 'tty', stderr: '' });
  });

  it('rejects host-path binds', () => {
    expect(() => assertNamedVolumeBind('nbdata:/home/jovyan')).not.toThrow();
    for (const bad of ['/etc:/x', './a:/x', 'C:\\x:/x', ':/x']) {
      expect(() => assertNamedVolumeBind(bad)).toThrow();
    }
  });

  describe('against a fake engine', () => {
    let server: http.Server;
    let client: DockerClient;
    const seen: { method: string; url: string; body: unknown }[] = [];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          seen.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null });
          if (req.url!.startsWith('/v1.43/containers/create')) {
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ Id: 'abc' }));
          } else if (req.url!.includes('/stats')) {
            res.end(
              JSON.stringify({
                cpu_stats: {
                  cpu_usage: { total_usage: 300 },
                  system_cpu_usage: 2000,
                  online_cpus: 2,
                },
                precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
                memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 200 } },
                pids_stats: { current: 7 },
              }),
            );
          } else if (req.url!.includes('/missing/json')) {
            res.writeHead(404);
            res.end('{"message":"no such container"}');
          } else {
            res.writeHead(204);
            res.end();
          }
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as AddressInfo;
      client = new DockerClient({ host: `tcp://127.0.0.1:${port}` });
    });
    afterAll(() => server.close());

    it('creates containers with safe defaults', async () => {
      const id = await client.createContainer({
        name: 'k1',
        image: 'img',
        cpus: 1.5,
        memoryBytes: 1024,
        volumes: [{ name: 'v1', target: '/data', readOnly: true }],
        securityOpt: ['seccomp=default'],
      });
      expect(id).toBe('abc');
      const body = seen.at(-1)!.body as { HostConfig: Record<string, unknown> };
      expect(body.HostConfig).toMatchObject({
        NetworkMode: 'none',
        NanoCpus: 1.5e9,
        Memory: 1024,
        MemorySwap: 1024,
        CapDrop: ['ALL'],
        Binds: ['v1:/data:ro'],
        SecurityOpt: ['no-new-privileges:true', 'seccomp=default'],
      });
    });

    it('reads stats and treats 404 inspect as null', async () => {
      expect(await client.stats('k1')).toEqual({
        cpuPercent: 40,
        memoryBytes: 800,
        memoryLimitBytes: 4000,
        pids: 7,
      });
      expect(await client.inspect('missing')).toBeNull();
    });
  });
});

describe('sandbox/idle', () => {
  it('reaps idle keys but not busy ones', async () => {
    const reaped: string[] = [];
    const busy = new Set(['b']);
    const r = new IdleReaper(
      1000,
      (k) => void reaped.push(k),
      (k) => busy.has(k),
      1e9,
    );
    r.touch('a');
    r.touch('b');
    await r.sweep(Date.now() + 500);
    expect(reaped).toEqual([]);
    await r.sweep(Date.now() + 2000);
    expect(reaped).toEqual(['a']);
    r.stop();
  });
});
