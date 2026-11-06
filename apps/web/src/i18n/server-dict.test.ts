/**
 * 服务端中文在英文界面下的渲染：用真实的服务端原文跑 trServer，确认没有中文漏出。
 */
import { registerDict, registerServerDict, setLang, trServer } from '@srh/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import server from './en/server.json';
import shared from './en/shared.json';
import web from './en/web.json';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

beforeAll(() => {
  registerDict({ ...web, ...shared });
  registerServerDict({ ...server, ...shared });
  setLang('en');
});
afterAll(() => setLang('zh'));

describe('trServer with real server output', () => {
  const why = '连续 3 轮都用满了步数（每轮 24 步）';
  const cases: [string, RegExp][] = [
    [
      `这项工作量比较大，${why}，先停下了。已完成的部分见进度清单和产出；点「继续」或在这里回一句，就会接着做剩下的。`,
      /3 rounds.*24 steps/,
    ],
    [
      `协调者：这项工作量比较大，${why}，先停下了。已完成的部分见进度清单和产出；点「继续」或在这里回一句，就会接着做剩下的。`,
      /^Coordinator: .*3 rounds.*24 steps/,
    ],
    [`${why}，先停下等成员`, /3 rounds.*24 steps/],
    [
      '这一轮出错停下了（模型接口或工具出错，详情在思路里）。点「继续」或在这里回一句，就会从停下的地方接着做。',
      /^This turn stopped/,
    ],
    ['这个 PDF 里没有可提取的文字（可能是扫描件），暂时无法解析', /no extractable text/],
    ['系统', /^System$/],
    ['研究看板', /^Research board$/],
    ['待审阅', /^In review$/],
    ['张三的 agent', /^张三's agent$/],
    ['论文不存在，可能已被删除', /^Paper not found/],
    ['研协支持把状态从「待处理」改为「处理中」', /^Thinkloft Support changed status/],
    ['研协支持回复了 YX-12：Export hangs', /^Thinkloft Support replied to YX-12: Export hangs$/],
    ['操作太频繁了，请 30 秒后再试', /^Too many requests\. Try again in 30 s$/],
    ['重置链接无效或已过期', /^This reset link is invalid or has expired$/],
    [
      '重置请求太频繁，请 15 分钟后再试',
      /^Too many reset requests\. Please try again in 15 min\.$/,
    ],
    ['重置请求太频繁，请 40 秒后再试', /^Too many reset requests\. Please try again in 40 s\.$/],
    ['余额不足，请先充值', /^Insufficient credits/],
  ];
  it.each(cases)('%s', (zh, expected) => {
    const en = trServer(zh);
    expect(en).toMatch(expected);
    if (!zh.startsWith('张三')) expect(en).not.toMatch(CJK);
  });

  it('leaves unknown text alone', () => {
    expect(trServer('我自己起的看板名')).toBe('我自己起的看板名');
  });
});
