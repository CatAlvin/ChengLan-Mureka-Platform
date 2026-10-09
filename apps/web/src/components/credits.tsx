import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import { CREDIT_PRICE_ROWS, isLastUse, pointsForCents, type CreditBalance, type CreditQuote } from '../../../../packages/shared/src/credits';
import './credits.css';

export function CreditBadge({ balance }: { balance?: CreditBalance }) {
  return balance ? <Link to="/settings#credits" className="credit-badge" aria-label={`额度：${balance.unlimited ? '无限' : balance.balance + ' 点'}，查看明细`}>{balance.unlimited ? '∞' : balance.balance}<small>点</small></Link> : null;
}
export function CostHint({ quote, balance }: { quote: CreditQuote; balance?: CreditBalance }) {
  const lastUse = isLastUse(balance, quote);
  return <div className={`cost-hint ${balance && !balance.unlimited && balance.balance < quote.points && !lastUse ? 'cost-insufficient' : ''}`}>
    <strong>{quote.points ? `本次${quote.uncertain ? '押金' : '预扣'} ${quote.points} 点` : '免费操作'}</strong><span>{balance?.unlimited ? '管理员额度无限' : balance ? `可用 ${balance.balance} 点` : '正在读取额度'}</span>
    {quote.uncertain && <small>费用暂不确定，完成后按实际费用结算。</small>}
    {lastUse && <small>本次已知费用不超过 ¥3，可用剩余点数完成最后一次创作；成功后余额归零。</small>}
    {balance && !balance.unlimited && balance.balance < quote.points && !lastUse && <small>额度不足，可等待周一刷新或联系管理员。余额为 0 或费用未知时无法使用最后一次额度。</small>}
  </div>;
}
type LedgerEntry = { id: string; delta: number; balance: number; action: string; note: string; createdAt: number };
export function CreditPanel() {
  const query = useQuery({ queryKey: ['credits'], queryFn: () => api<CreditBalance & { history: LedgerEntry[] }>('/api/credits'), refetchInterval: 5000 });
  const [expanded, setExpanded] = useState(false);
  return <section className="settings-card credit-panel" id="credits"><h2>我的创作额度</h2>{query.data ? <>
    <div className="credit-summary"><strong>{query.data.unlimited ? '∞' : query.data.balance}<small>{query.data.unlimited ? '无限额度' : `可用点数 · 约 ¥${(query.data.balance / 100).toFixed(2)}`}</small></strong><span>预扣待结算 {query.data.unlimited ? '—' : query.data.held} 点<br />下次刷新：{formatDate(query.data.nextReset)}</span></div>
    <p className="field-help">每周一 00:00（北京时间）重置为 1000 点，跨周完成的任务不会把上周退款转入本周。</p>
    <details><summary>各项操作需要多少点？</summary><p>按 <a href="https://platform.mureka.cn/pricing" target="_blank" rel="noreferrer">Mureka 中国区 API 定价</a>换算，1 分钱 = 1 点。价格核对于 2026-10-09。</p><table><thead><tr><th>操作</th><th>点数</th></tr></thead><tbody>{CREDIT_PRICE_ROWS.map(([label, cents]) => <tr key={label}><td>{label.replace('（V8）', '（V8 / V9）')}</td><td>{pointsForCents(cents)}</td></tr>)}</tbody></table><p>余额大于 0、但不足本次费用时，已知费用不超过 ¥3 的操作仍可进行一次；成功后余额归零，失败且未收费则退回。费用未知先预扣 20 点，由管理员核账。音频保存重试不重复扣点。</p></details>
    <button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '查看'}最近点数明细</button>
    {expanded && <div className="credit-history">{query.data.history.length ? query.data.history.map(row => <div key={row.id}><div><strong>{row.note}</strong><small>{formatDate(row.createdAt)} · 余额 {row.balance}</small></div><b>{row.delta > 0 ? '+' : ''}{row.delta}</b></div>) : <p>暂无点数变动。</p>}</div>}
  </> : <p role="status">{query.error ? '额度暂时读取失败，请稍后重试。' : '正在读取额度…'}</p>}</section>;
}
