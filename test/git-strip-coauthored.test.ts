import { describe, expect, it } from 'vitest';
import { composeMirrorCommitMessage, stripCoAuthoredBy } from '../src/session-manager.js';

/**
 * 镜像提交信息里的 Co-Authored-By 剔除(目录级开关 gitStripCoAuthored):
 * stripCoAuthoredBy 是纯函数;composeMirrorCommitMessage 组装出的最终消息在调用点
 * 按开关决定是否过 strip。开关关闭时行为必须与改动前完全一致(缺省 false = 不变)。
 */
describe('stripCoAuthoredBy(镜像提交尾注剔除)', () => {
  it('剔除末尾单条尾注,且不留尾巴空行', () => {
    expect(stripCoAuthoredBy('fix: 顶栏图标\n\n- 细节一\n- 细节二\n\nCo-Authored-By: MOSS')).toBe(
      'fix: 顶栏图标\n\n- 细节一\n- 细节二',
    );
  });

  it('没有尾注时原样返回,不做任何改写', () => {
    const msg = 'fix: 普通提交\n\n正文段落\n\n再一段';
    expect(stripCoAuthoredBy(msg)).toBe(msg);
  });

  it('大小写与连字符变体都命中(Co-authored-by / CO-AUTHORED-BY / coauthored-by)', () => {
    expect(stripCoAuthoredBy('s\n\nCo-authored-by: A <a@b>')).toBe('s');
    expect(stripCoAuthoredBy('s\n\nCO-AUTHORED-BY: A <a@b>')).toBe('s');
    expect(stripCoAuthoredBy('s\n\ncoauthored-by: A <a@b>')).toBe('s');
  });

  it('多条尾注(不只首行)全部剔除,中间空行不残留', () => {
    expect(
      stripCoAuthoredBy('s\n\nbody\n\nCo-Authored-By: A <a@b>\n\nCo-authored-by: B <b@c>'),
    ).toBe('s\n\nbody');
  });

  it('尾注在正文中段时剔除该行与紧随空行,后续正文保留', () => {
    expect(stripCoAuthoredBy('s\n\nCo-Authored-By: A <a@b>\n\nmore body')).toBe('s\n\nmore body');
  });

  it('剔除后不产生连续空行(正文里的既有空行不受牵连)', () => {
    // 「正文 + 空行 + 尾注 + 空行 + 正文」:剔除尾注与其紧随空行,段落间距保持原样
    expect(stripCoAuthoredBy('s\n\nCo-Authored-By: A <a@b>\n\n\nmore body')).toBe('s\n\nmore body');
  });

  it('消息只有尾注时剔成空串', () => {
    expect(stripCoAuthoredBy('Co-Authored-By: MOSS')).toBe('');
  });
});

describe('composeMirrorCommitMessage 与 strip 的组合(调用点口径)', () => {
  const notify = (commitMessage: string, commitSubjects?: string[]) => ({
    kind: 'git-commit-notify' as const,
    fromDeviceId: 'DEV-A',
    folderId: 'f1',
    commitHash: 'h1',
    commitMessage,
    changedFiles: ['a.txt'],
    ...(commitSubjects ? { commitSubjects } : {}),
    parentHash: 'h0',
  });

  it('单笔提交:组装结果即原消息,strip 后尾注消失', () => {
    const composed = composeMirrorCommitMessage(notify('fix: a\n\nCo-Authored-By: MOSS'));
    expect(composed).toBe('fix: a\n\nCo-Authored-By: MOSS');
    expect(stripCoAuthoredBy(composed)).toBe('fix: a');
  });

  it('多笔提交:subject 附加段与原消息里的尾注共存,strip 一并清掉尾注', () => {
    // commitMessage 是本批最后一笔的完整消息;更早的 subject(旧→新,去掉最后一笔)附在 body
    const composed = composeMirrorCommitMessage(
      notify('fix: b\n\nCo-Authored-By: MOSS', ['fix: a', 'fix: b']),
    );
    expect(composed).toBe('fix: b\n\nCo-Authored-By: MOSS\n\nfix: a');
    expect(stripCoAuthoredBy(composed)).toBe('fix: b\n\nfix: a');
  });

  it('旧版对端缺 commitSubjects:组装结果与原消息一致,strip 不误伤正文', () => {
    const composed = composeMirrorCommitMessage(notify('fix: a\n\nbody'));
    expect(composed).toBe('fix: a\n\nbody');
    expect(stripCoAuthoredBy(composed)).toBe('fix: a\n\nbody');
  });
});
