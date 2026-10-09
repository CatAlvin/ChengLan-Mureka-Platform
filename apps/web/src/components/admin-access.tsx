import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, formatDate, type SessionUser } from '../lib/api';
import { pointsForCents, type CreditBalance } from '../../../../packages/shared/src/credits';
import { Button } from './ui/button';
import { Modal } from './modal';
import './credits.css';

export type ManagedUser = SessionUser & { credits: CreditBalance };
type Review = { jobId: string; username: string; kind: string; providerId: string | null; reserved: number; note: string; createdAt: number };
export function AdminAccess() {
  const client = useQueryClient();
  const queue = useQuery({ queryKey: ['registrations'], queryFn: () => api<{ limit: number; pending: number; requests: { id: string; username: string; createdAt: number }[] }>('/api/admin/registrations'), refetchInterval: 10000 });
  const charges = useQuery({ queryKey: ['credit-reviews'], queryFn: () => api<{ reviews: Review[] }>('/api/admin/credits'), refetchInterval: 10000 });
  const [limit, setLimit] = useState(''); const [busy, setBusy] = useState(''); const [review, setReview] = useState<Review | null>(null);
  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(id); try { await api(`/api/admin/registrations/${id}/${decision}`, { method: 'POST' }); await Promise.all([queue.refetch(), client.invalidateQueries({ queryKey: ['admin-users'] })]); toast.success(decision === 'approve' ? '已批准，用户现在可以登录' : '已拒绝申请，名额已释放'); } catch (e) { toast.error((e as Error).message); } finally { setBusy(''); }
  }
  return <><section className="admin-section"><div className="admin-section-heading"><div><h2>注册审批 <small>{queue.data?.pending ?? '—'} / {queue.data?.limit ?? '—'}</small></h2><p>只有批准后账号才生效。队列满时自动暂停接受申请。</p></div>
    <form className="approval-actions" onSubmit={async e => { e.preventDefault(); setBusy('limit'); try { await api('/api/admin/registrations/settings', { method: 'PATCH', body: { limit: Number(limit) } }); setLimit(''); await queue.refetch(); toast.success('队列上限已更新'); } catch (failure) { toast.error((failure as Error).message); } finally { setBusy(''); } }}><label>队列上限<input aria-label="待审批队列上限" type="number" min={1} max={100} required placeholder={String(queue.data?.limit || 5)} value={limit} onChange={e => setLimit(e.target.value)} /></label><Button className="secondary-button" disabled={!!busy} type="submit">保存上限</Button></form></div>
    {queue.error && <p role="alert">申请列表读取失败。<button onClick={() => void queue.refetch()}>重试</button></p>}
    <div className="approval-list">{queue.data?.requests.map(request => <article className="approval-row" key={request.id}><div><strong>@{request.username}</strong><small>{formatDate(request.createdAt)} 提交</small></div><div><Button className="primary-button" disabled={!!busy} onClick={() => void decide(request.id, 'approve')}>批准</Button><Button className="secondary-button" disabled={!!busy} onClick={() => void decide(request.id, 'reject')}>拒绝申请</Button></div></article>)}</div>{queue.data && !queue.data.requests.length && <p className="field-help">暂时没有待审批申请。</p>}
  </section><section className="admin-section credit-admin-list"><div className="admin-section-heading"><div><h2>费用待核实 <small>{charges.data?.reviews.length ?? '—'}</small></h2><p>已知单价按官网价格与实际成功数量自动结算。此处处理结果不明或价格未知的任务。</p></div></div>
    <p className="field-help">Mureka API 仅提供账户汇总金额，不能用于分摊个人费用。请在 Mureka 后台查到对应任务的实际费用后结算；确认未收费填 0。</p>
    {charges.error && <p role="alert">核账列表读取失败。<button onClick={() => void charges.refetch()}>重试</button></p>}
    {charges.data?.reviews.map(row => <article className="approval-row" key={row.jobId}><div><strong>@{row.username} · {row.kind} · 预扣 {row.reserved} 点</strong><small>{row.note}</small><code>任务 {row.jobId}<br />云端 {row.providerId || '待确认'}</code></div><Button className="secondary-button" onClick={() => setReview(row)}>按账单结算</Button></article>)}{charges.data && !charges.data.reviews.length && <p className="field-help">没有待核实费用。</p>}
  </section><Modal open={!!review} onOpenChange={open => !open && setReview(null)} title="核实实际费用" description="请输入已查到的任务账单金额。保存后只结算一次。">{review && <SettleCharge row={review} onDone={async () => { setReview(null); await charges.refetch(); await client.invalidateQueries({ queryKey: ['admin-users'] }); }} />}</Modal></>;
}
function SettleCharge({ row, onDone }: { row: Review; onDone: () => Promise<void> }) {
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <form className="account-form" onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await api(`/api/admin/credits/${row.jobId}/settle`, { method: 'POST', body: { cents: Math.round(Number(amount) * 100), reason } }); await onDone(); toast.success('费用已结算'); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}><p>@{row.username} · 预扣 {row.reserved} 点</p><label>实际费用（元）<input type="number" step="0.01" min={0} max={100000} required value={amount} onChange={e => setAmount(e.target.value)} /></label><p className="field-help">将按 {pointsForCents(Math.round(Number(amount) * 100))} 点结算，余额最低为 0。</p><label>账单核对说明<input value={reason} required maxLength={200} placeholder="例如：已核对云端任务账单" onChange={e => setReason(e.target.value)} /></label>{error && <p role="alert" className="auth-error">{error}</p>}<Button className="primary-button" disabled={busy} type="submit">确认实际费用</Button></form>;
}
export function AdjustCredits({ user, onDone }: { user: ManagedUser; onDone: () => Promise<void> }) {
  const [points, setPoints] = useState('10'); const [direction, setDirection] = useState('add'); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [pending, setPending] = useState<{ requestId: string; points: number; reason: string } | null>(null);
  return <form className="account-form" onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); const body = pending || { requestId: crypto.randomUUID(), points: Number(points) * (direction === 'add' ? 1 : -1), reason }; setPending(body); try { await api(`/api/admin/users/${user.id}/credits`, { method: 'POST', body }); await onDone(); toast.success('额度已调整'); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}>
    <p className="credit-adjust-summary">@{user.username} · 当前可用 {user.credits.balance} 点</p><label>操作<select value={direction} disabled={!!pending} onChange={e => setDirection(e.target.value)}><option value="add">增加点数</option><option value="deduct">扣除点数</option></select></label><label>点数<input type="number" required min={0.01} max={100000} step="0.01" disabled={!!pending} value={points} onChange={e => setPoints(e.target.value)} /></label><label>说明<input required maxLength={200} disabled={!!pending} placeholder="例如：项目创作补充额度" value={reason} onChange={e => setReason(e.target.value)} /></label><p className="field-help">余额最低为 0，调整会留存记录；下周一仍重置为 1000 点（¥10）。</p>{error && <p className="auth-error" role="alert">{error}</p>}<Button type="submit" className="primary-button" disabled={busy}>{busy ? '正在保存…' : pending ? '核对这次调整' : '保存额度调整'}</Button>
  </form>;
}
