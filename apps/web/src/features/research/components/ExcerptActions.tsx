import { clientId } from '@/lib/client-id';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { researchApi, researchKey } from '../data';
import { tr } from '@/lib/i18n';

type Role = 'supportingExcerptIds' | 'counterExcerptIds' | 'contextExcerptIds';
const roles: Record<Role, string> = {
  supportingExcerptIds: tr('支持依据'),
  counterExcerptIds: tr('反例依据'),
  contextExcerptIds: tr('背景依据'),
};

/** 工作区摘录引用同一份固定证据；结论与编码沿用既有研究空间契约。 */
export function ExcerptActions({
  pid,
  recordId,
  excerptId,
  writable,
}: {
  pid: string;
  recordId: string;
  excerptId: string;
  writable: boolean;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'finding' | 'coding' | null>(null);
  const [findingId, setFindingId] = useState('');
  const [statement, setStatement] = useState('');
  const [role, setRole] = useState<Role>('supportingExcerptIds');
  const [codeId, setCodeId] = useState('');
  const [codeName, setCodeName] = useState('');
  const [caseId, setCaseId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [findingKey, setFindingKey] = useState(() => clientId());
  const [codingKey, setCodingKey] = useState(() => clientId());
  const [codeKey, setCodeKey] = useState(() => clientId());
  const findings = useQuery({
    queryKey: researchKey(pid, 'record', recordId, 'findings'),
    queryFn: ({ signal }) => researchApi.findings(pid, recordId, signal),
    enabled: mode === 'finding',
  });
  const codes = useQuery({
    queryKey: researchKey(pid, 'record', recordId, 'codes'),
    queryFn: ({ signal }) => researchApi.codes(pid, recordId, signal),
    enabled: mode === 'coding',
  });
  const saveFinding = async () => {
    if (!findingId && !statement.trim()) {
      setError(tr('请写下结论陈述。'));
      return;
    }
    const finding = findings.data?.find((entry) => entry.id === findingId);
    if (findingId && !finding) {
      setError(tr('结论已不可用，请重新选择。'));
      return;
    }
    setPending(true);
    setError('');
    setMessage('');
    try {
      if (finding)
        await researchApi.updateFinding(pid, finding.id, {
          baseVersion: finding.version,
          [role]: [...new Set([...finding[role], excerptId])],
        });
      else
        await researchApi.createFinding(pid, recordId, {
          statement: statement.trim(),
          [role]: [excerptId],
          humanConfirmed: false,
          idempotencyKey: findingKey,
        });
      await qc.invalidateQueries({ queryKey: researchKey(pid, 'record', recordId) });
      setMessage(tr('已加入结论依据；结论仍需人工判断。'));
      setMode(null);
      setStatement('');
      setFindingId('');
      setFindingKey(clientId());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('结论没有保存，请重试。'));
    } finally {
      setPending(false);
    }
  };
  const saveCoding = async () => {
    if (!codeId && !codeName.trim()) {
      setError(tr('请选择或填写编码主题。'));
      return;
    }
    setPending(true);
    setError('');
    setMessage('');
    try {
      const code = codeId
        ? { id: codeId }
        : await researchApi.createCode(pid, recordId, {
            name: codeName.trim(),
            idempotencyKey: codeKey,
          });
      // 若关联失败，保留已经创建的主题，重试不会创建第二份。
      setCodeId(code.id);
      await researchApi.createCoding(pid, recordId, {
        excerptId,
        codeId: code.id,
        caseId: caseId.trim() || null,
        idempotencyKey: codingKey,
      });
      await qc.invalidateQueries({ queryKey: researchKey(pid, 'record', recordId) });
      setMessage(tr('已添加摘录编码。'));
      setMode(null);
      setCodeName('');
      setCodeId('');
      setCaseId('');
      setCodeKey(clientId());
      setCodingKey(clientId());
    } catch (cause) {
      await qc.invalidateQueries({ queryKey: researchKey(pid, 'record', recordId, 'codes') });
      setError(cause instanceof Error ? cause.message : tr('编码没有保存，请重试。'));
    } finally {
      setPending(false);
    }
  };
  if (!writable) return null;
  return (
    <section className="space-y-3 border-t border-line pt-4" aria-label={tr('摘录应用')}>
      <p className="text-caption text-fg-muted">
        {tr('引用的摘录与来源版本已固定；笔记正文可以继续编辑。')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => {
            setMode(mode === 'finding' ? null : 'finding');
            setError('');
            setMessage('');
          }}
        >
          {tr('用于结论')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setMode(mode === 'coding' ? null : 'coding');
            setError('');
            setMessage('');
          }}
        >
          {tr('添加编码')}
        </Button>
      </div>
      {mode === 'finding' && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <h3 className="text-small font-medium">{tr('加入结论依据')}</h3>
          {findings.isPending ? (
            <Skeleton className="h-16" />
          ) : findings.isError ? (
            <p role="alert" className="text-small text-danger">
              {tr('结论没有加载出来。')}
              <Button size="sm" variant="ghost" onClick={() => void findings.refetch()}>
                {tr('重试')}
              </Button>
            </p>
          ) : (
            <>
              <Select
                aria-label={tr('选择结论')}
                value={findingId}
                onChange={(e) => setFindingId(e.target.value)}
              >
                <option value="">{tr('新建结论')}</option>
                {findings.data.map((finding) => (
                  <option key={finding.id} value={finding.id}>
                    {finding.statement}
                  </option>
                ))}
              </Select>
              {!findingId && (
                <Textarea
                  aria-label={tr('结论陈述')}
                  value={statement}
                  rows={3}
                  maxLength={20000}
                  onChange={(e) => setStatement(e.target.value)}
                  placeholder={tr('写下结论陈述')}
                />
              )}
              <Select
                aria-label={tr('依据角色')}
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {Object.entries(roles).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="primary"
                loading={pending}
                onClick={() => void saveFinding()}
              >
                {tr('保存依据')}
              </Button>
            </>
          )}
        </div>
      )}
      {mode === 'coding' && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <h3 className="text-small font-medium">{tr('摘录编码')}</h3>
          {codes.isPending ? (
            <Skeleton className="h-16" />
          ) : codes.isError ? (
            <p role="alert" className="text-small text-danger">
              {tr('编码没有加载出来。')}
              <Button size="sm" variant="ghost" onClick={() => void codes.refetch()}>
                {tr('重试')}
              </Button>
            </p>
          ) : (
            <>
              <Select
                aria-label={tr('选择编码')}
                value={codeId}
                onChange={(e) => setCodeId(e.target.value)}
              >
                <option value="">{tr('新建编码')}</option>
                {codes.data.map((code) => (
                  <option key={code.id} value={code.id}>
                    {code.name}
                  </option>
                ))}
              </Select>
              {!codeId && (
                <Input
                  aria-label={tr('编码名称')}
                  value={codeName}
                  maxLength={160}
                  onChange={(e) => setCodeName(e.target.value)}
                  placeholder={tr('编码名称')}
                />
              )}
              <Input
                aria-label={tr('对象代号')}
                value={caseId}
                maxLength={160}
                onChange={(e) => setCaseId(e.target.value)}
                placeholder={tr('对象代号（可选）')}
              />
              <Button
                size="sm"
                variant="primary"
                loading={pending}
                onClick={() => void saveCoding()}
              >
                {tr('保存编码')}
              </Button>
            </>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="text-small text-fg-muted">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
