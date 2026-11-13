import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import { LAST_USE_MAX_CENTS, pointsForCents, quoteCredits, WEEKLY_POINTS, type CreditBalance } from '../../../packages/shared/src/credits.js';
import { creationModel, DEFAULT_MUREKA_MODEL } from '../../../packages/shared/src/index.js';
import type { SongTask } from './provider.js';

const WEEK = 7 * 86400000;
export function creditWeek(now = Date.now()) {
  const local = new Date(now + 8 * 3600000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (local.getUTCDay() + 6) % 7) - 8 * 3600000;
}
type Wallet = { week: number; balance: number };
type Charge = { job_id: string; user_id: string; week: number; reserved: number; quoted_cents: number | null; actual_cents: number | null; state: 'held' | 'review' | 'settled' | 'released'; unlimited: number; grace: number };
export class CreditError extends Error { readonly statusCode = 402; }
export class Credits {
  constructor(private store: Store) {}
  private get sql() { return this.store.sqlite; }
  private entry(userId: string, delta: number, balance: number, action: string, note: string, jobId: string | null = null, actor: string | null = null, id: string = randomUUID()) {
    this.sql.prepare('INSERT INTO credit_ledger VALUES (?,?,?,?,?,?,?,?,?)').run(id, userId, jobId, delta, balance, action, note, actor, Date.now());
  }
  private wallet(userId: string, now = Date.now()): Wallet {
    const week = creditWeek(now);
    const old = this.sql.prepare('SELECT week,balance FROM credit_wallets WHERE user_id=?').get(userId) as Wallet | undefined;
    if (!old || old.week < week) {
      this.sql.prepare('INSERT INTO credit_wallets VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET week=excluded.week,balance=excluded.balance').run(userId, week, WEEKLY_POINTS * 100);
      this.entry(userId, WEEKLY_POINTS * 100 - (old?.balance ?? 0), WEEKLY_POINTS * 100, 'weekly', `每周额度重置为 ${WEEKLY_POINTS} 点`);
      return { week, balance: WEEKLY_POINTS * 100 };
    }
    return old;
  }
  balance(userId: string, now = Date.now()): CreditBalance {
    return this.sql.transaction(() => {
      const wallet = this.wallet(userId, now);
      const user = this.sql.prepare('SELECT role FROM users WHERE id=?').get(userId) as { role: string };
      const held = (this.sql.prepare("SELECT coalesce(sum(reserved),0) n FROM credit_charges WHERE user_id=? AND state IN ('held','review') AND unlimited=0").get(userId) as {n:number}).n;
      return { unlimited: user.role === 'admin', balance: wallet.balance / 100, held: held / 100, weekly: WEEKLY_POINTS, nextReset: wallet.week + WEEK };
    })();
  }
  reserve(jobId: string) {
    return this.sql.transaction(() => {
      if (this.charge(jobId)) return;
      const job = this.store.getJob(jobId)!;
      const quote = quoteCredits(job.kind, job.input, job.tool ?? undefined, job.kind === 'remix' ? DEFAULT_MUREKA_MODEL : creationModel(job.input));
      if (!quote.points) return;
      const user = this.sql.prepare('SELECT role FROM users WHERE id=?').get(job.ownerId) as { role: string };
      const wallet = this.wallet(job.ownerId); const unlimited = user.role === 'admin';
      const units = Math.round(quote.points * 100);
      const grace = !unlimited && wallet.balance > 0 && wallet.balance < units && quote.cents !== null && quote.cents > 0 && quote.cents <= LAST_USE_MAX_CENTS;
      if (!unlimited && wallet.balance < units && !grace) throw new CreditError(`本次需要 ${quote.points} 点，当前剩余 ${wallet.balance / 100} 点。余额不足时，仅已知费用不超过 3 元的操作可使用最后一次额度。`);
      const reserved = grace ? wallet.balance : units;
      this.sql.prepare('INSERT INTO credit_charges (job_id,user_id,week,reserved,quoted_cents,state,unlimited,grace,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(jobId, job.ownerId, wallet.week, reserved, quote.cents, 'held', Number(unlimited), Number(grace), Date.now());
      if (!unlimited) this.change(job.ownerId, wallet, -reserved, 'reserve', grace ? `${quote.label}最后一次额度预扣` : `${quote.label}预扣`, jobId);
    })();
  }
  charge(jobId: string) { return this.sql.prepare('SELECT * FROM credit_charges WHERE job_id=?').get(jobId) as Charge | undefined; }
  private change(userId: string, wallet: Wallet, delta: number, action: string, note: string, jobId: string | null, actor: string | null = null, id?: string) {
    const balance = Math.max(0, wallet.balance + delta);
    this.sql.prepare('UPDATE credit_wallets SET balance=? WHERE user_id=?').run(balance, userId);
    this.entry(userId, balance - wallet.balance, balance, action, note, jobId, actor, id);
  }
  settle(jobId: string, cents: number, note: string, actor: string | null = null, released = false) {
    if (!Number.isSafeInteger(cents) || cents < 0 || cents > 10000000) throw new Error('费用无效');
    return this.sql.transaction(() => {
      const charge = this.charge(jobId);
      if (!charge || !['held', 'review'].includes(charge.state)) return false;
      const wallet = this.wallet(charge.user_id);
      const actual = Math.round(pointsForCents(cents) * 100);
      // A late completion cannot refund an expired week's allowance into this week.
      const sameWeek = wallet.week === charge.week;
      // A successful last-use operation consumes the remaining balance; a free or rejected one restores it.
      const delta = charge.grace ? (sameWeek && (released || cents === 0) ? charge.reserved : 0) : sameWeek ? charge.reserved - actual : -Math.max(0, actual - charge.reserved);
      if (!charge.unlimited) this.change(charge.user_id, wallet, delta, released ? 'release' : 'settle', `${note}；实际 ${pointsForCents(cents)} 点${charge.grace && cents > 0 && !released ? '（最后一次额度）' : ''}${!sameWeek ? '（跨周结算）' : ''}`, jobId, actor);
      this.sql.prepare('UPDATE credit_charges SET actual_cents=?,state=?,settled_at=?,note=? WHERE job_id=?').run(cents, released ? 'released' : 'settled', Date.now(), note, jobId);
      return true;
    })();
  }
  release(jobId: string) { return this.settle(jobId, 0, '创作未提交，退回预扣', null, true); }
  review(jobId: string, note = '上游费用待核实，请管理员根据该任务的账单明细结算') {
    this.sql.prepare("UPDATE credit_charges SET state='review',note=? WHERE job_id=? AND state='held'").run(note, jobId);
  }
  complete(jobId: string, task?: SongTask) {
    const charge = this.charge(jobId); if (!charge || charge.state !== 'held') return;
    const job = this.store.getJob(jobId)!;
    let cents = charge.quoted_cents;
    if (task) {
      if (task.status !== 'succeeded') { this.review(jobId, '云端任务未成功，待核实是否收费'); return; }
      const quote = quoteCredits(job.kind, job.input, job.tool ?? undefined, task.model || (job.kind === 'remix' ? DEFAULT_MUREKA_MODEL : creationModel(job.input)), task.choices?.length ?? 0);
      cents = quote.cents;
    }
    if (charge.grace && cents !== null && cents > LAST_USE_MAX_CENTS) { this.review(jobId, '最后一次额度实际费用高于 3 元，需管理员核实'); return; }
    if (cents === null) this.review(jobId);
    else this.settle(jobId, cents, '按已核实官网单价和实际成功数量结算');
  }
  adjust(userId: string, points: number, reason: string, actor: string, id: string) {
    return this.sql.transaction(() => {
      const old = this.sql.prepare('SELECT user_id,delta,actor_id,note FROM credit_ledger WHERE id=?').get(id) as {user_id:string; actor_id:string;note:string} | undefined;
      if (old) { if (old.user_id !== userId || old.actor_id !== actor || old.note !== `${reason}（申请调整 ${points} 点）`) throw new Error('重复请求内容不一致'); return this.balance(userId); }
      const wallet = this.wallet(userId);
      this.change(userId, wallet, Math.round(points * 100), 'adjust', `${reason}（申请调整 ${points} 点）`, null, actor, id);
      return this.balance(userId);
    })();
  }
  history(userId: string) { return this.sql.prepare('SELECT id,job_id AS jobId,delta/100.0 AS delta,balance/100.0 AS balance,action,note,created_at AS createdAt FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(userId); }
  pending() { return this.sql.prepare("SELECT c.job_id AS jobId,c.user_id AS userId,u.username,j.kind,j.provider_id AS providerId,c.reserved/100.0 AS reserved,c.note,c.created_at AS createdAt FROM credit_charges c JOIN users u ON u.id=c.user_id JOIN generation_jobs j ON j.id=c.job_id WHERE c.state='review' ORDER BY c.created_at").all(); }
}
