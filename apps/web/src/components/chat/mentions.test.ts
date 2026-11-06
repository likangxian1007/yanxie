import { describe, expect, it } from 'vitest';
import { mentionQuery, rebaseMentions, trimmedMentions } from './mentions';
const m = { userId: 'usr_a', label: '张三', start: 0, end: 3 };
describe('成员提及范围', () => {
  it('只在光标处匹配，邮箱不触发，支持中文搜索', () => {
    expect(mentionQuery('给 @张', 4)).toEqual({ start: 2, end: 4, query: '张' });
    expect(mentionQuery('x@example.com', 13)).toBeNull();
    expect(mentionQuery('第一行\n@', 5)).toEqual({ start: 4, end: 5, query: '' });
  });
  it('跟随前方插入，修改名字取消提及，普通同名文字不变成提及', () => {
    expect(rebaseMentions('@张三 来看', '请 @张三 来看', [m])).toEqual([
      { ...m, start: 2, end: 5 },
    ]);
    expect(rebaseMentions('@张三', '@李四', [m])).toEqual([]);
    expect(rebaseMentions('', '@张三', [])).toEqual([]);
  });
  it('发送前裁剪空白同步范围，重复名字仍保留不同 ID', () => {
    expect(trimmedMentions('  @张三 ', [{ ...m, start: 2, end: 5 }])).toEqual([m]);
  });
});
