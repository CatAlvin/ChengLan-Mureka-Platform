import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/server/src/db';
import { Credits, creditWeek } from '../apps/server/src/credits';
import { canUseCredits, quoteCredits, pointsForCents } from '../packages/shared/src/credits';
import { toMurekaBody, type ToolInput } from '../packages/shared/src/index';
import { sampleInput, sampleJob } from './helpers';

describe('points pricing and weekly calendar', () => {
  it('uses Shanghai Monday midnight, including year boundaries', () => {
    expect(new Date(creditWeek(Date.parse('2026-10-11T15:59:59Z')))).toEqual(new Date('2026-10-04T16:00:00Z'));
    expect(new Date(creditWeek(Date.parse('2026-10-11T16:00:00Z')))).toEqual(new Date('2026-10-11T16:00:00Z'));
    expect(new Date(creditWeek(Date.parse('2027-01-01T00:00:00Z')))).toEqual(new Date('2026-12-27T16:00:00Z'));
  });
  it('quotes all paid operations using verified China API rates, count and model', () => {
    expect(quoteCredits('song', { mode: 'lyrics', count: 3 }).points).toBe(300);
    expect(quoteCredits('instrumental', { mode: 'instrumental', count: 1 }, undefined, 'mureka-9').points).toBe(33);
    expect(quoteCredits('song', { mode: 'easy', count: 1 }).points).toBe(300);
    expect(quoteCredits('song', { mode: 'easy', count: 1 }, undefined, 'mureka-9').points).toBe(200);
    expect(quoteCredits('remix').points).toBe(300);
    expect(quoteCredits('remix', undefined, undefined, 'mureka-8').points).toBe(150);
    expect(quoteCredits('song', { mode: 'lyrics', count: 1 }, undefined, 'future-model')).toMatchObject({ points: 20, uncertain: true, cents: null });
    expect(quoteCredits('lyrics').points).toBe(8); expect(quoteCredits('lyrics_extend').points).toBe(2);
    for (const [kind, cents] of [['extend', 95], ['region_edit', 95], ['track', 60], ['transcribe', 150], ['recognize', 8], ['describe', 60]] as const) expect(quoteCredits(kind).points).toBe(pointsForCents(cents));
    for (const [preset, cents] of [['band', 50], ['vocals', 150], ['detailed', 300]] as const) expect(quoteCredits('stem', undefined, { operation: 'stem', sourceTrackId: randomUUID(), title: '', preset }).points).toBe(pointsForCents(cents));
    expect(quoteCredits('crop').points).toBe(0); expect(quoteCredits('import').points).toBe(0);
    expect(toMurekaBody({ ...sampleInput(), model: 'mureka-9' }).model).toBe('mureka-9');
    expect(toMurekaBody({ ...sampleInput(), model: 'mureka-8' }).model).toBe('mureka-8');
    expect(canUseCredits({ unlimited: false, balance: 1, held: 0, nextReset: 0, weekly: 1000 }, quoteCredits('stem', undefined, { operation: 'stem', sourceTrackId: randomUUID(), title: '', preset: 'detailed' }))).toBe(true);
    expect(canUseCredits({ unlimited: false, balance: 1, held: 0, nextReset: 0, weekly: 1000 }, quoteCredits('song', { mode: 'lyrics', count: 10 }))).toBe(false);
    expect(canUseCredits({ unlimited: false, balance: 0, held: 0, nextReset: 0, weekly: 1000 }, quoteCredits('lyrics'))).toBe(false);
    expect(canUseCredits({ unlimited: false, balance: 1, held: 0, nextReset: 0, weekly: 1000 }, quoteCredits('song', { mode: 'lyrics', count: 1 }, undefined, 'future-model'))).toBe(false);
  });
});
describe('transactional points ledger', () => {
  let root: string; let store: Store; let credits: Credits; let userId: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chenglan-credits-')); store = new Store(root); credits = new Credits(store); userId = randomUUID();
    store.sqlite.prepare("INSERT INTO users (id,username,display_name,password_hash,role,created_at,password_changed_at) VALUES (?,?,?,'test','user',?,?)").run(userId, 'credit_user', 'Test', Date.now(), Date.now());
  });
  afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(root, { recursive: true, force: true }); });
  function reserve(count = 1, tool?: ToolInput) {
    const job = sampleJob({ kind: tool?.operation ?? 'song', tool, input: { ...sampleInput(), mode: 'lyrics', lyrics: '示例歌词', model: 'mureka-9', count } });
    store.sqlite.transaction(() => { store.forUser(userId).createJob(job); credits.reserve(job.id); })(); return job;
  }
  it('gives ¥10 of points and prevents an extra paid job at zero balance', () => {
    for (let n = 0; n < 10; n++) { const job = reserve(3); credits.complete(job.id); }
    expect(credits.balance(userId)).toMatchObject({ balance: 10, held: 0, weekly: 1000 });
    const finalJob = reserve(); expect(credits.charge(finalJob.id)).toMatchObject({ reserved: 1000, grace: 1 });
    credits.complete(finalJob.id); expect(credits.balance(userId)).toMatchObject({ balance: 0, held: 0 });
    expect(() => reserve()).toThrow('当前剩余 0 点'); expect(store.listJobs()).toHaveLength(11);
  });
  it('settles actual successful output count once and does not charge storage retries', () => {
    const job = reserve(3); credits.complete(job.id, { id: 'provider', status: 'succeeded', model: 'mureka-9', choices: [{ id: 'one', url: 'https://example.com/a.wav' }] });
    expect(credits.balance(userId)).toMatchObject({ balance: 967, held: 0 });
    credits.complete(job.id); credits.release(job.id); store.updateJob(job.id, { status: 'save_failed' });
    expect(credits.balance(userId).balance).toBe(967); expect(credits.charge(job.id)?.actual_cents).toBe(33);
  });
  it('reserves V9.5 prices for new work and remix even when the source used V9', () => {
    const song = sampleJob();
    store.sqlite.transaction(() => { store.forUser(userId).createJob(song); credits.reserve(song.id); })();
    expect(credits.charge(song.id)).toMatchObject({ reserved: 30000, quoted_cents: 300 });
    credits.complete(song.id, { id: 'new-song', status: 'succeeded', model: 'mureka-9.5', choices: [{ id: 'one', url: 'https://example.com/new.wav' }] });
    expect(credits.balance(userId).balance).toBe(700);

    const tool: ToolInput = { operation: 'remix', sourceTrackId: randomUUID(), title: '', lyrics: '', prompt: '柔和的爵士编曲' };
    const remix = sampleJob({ kind: 'remix', tool, input: { ...sampleInput(), model: 'mureka-9' } });
    store.sqlite.transaction(() => { store.forUser(userId).createJob(remix); credits.reserve(remix.id); })();
    expect(credits.charge(remix.id)).toMatchObject({ reserved: 30000, quoted_cents: 300 });
    credits.complete(remix.id, { id: 'new-remix', status: 'succeeded', model: 'mureka-9.5', choices: [{ id: 'one', url: 'https://example.com/remix.wav' }] });
    expect(credits.balance(userId).balance).toBe(400);
  });
  it('retains ambiguous charges for admin review and clamps expensive actual settlement at zero', () => {
    const job = reserve(); credits.review(job.id); store.updateJob(job.id, { status: 'failed' });
    expect(credits.balance(userId)).toMatchObject({ balance: 967, held: 33 });
    expect(credits.pending()).toHaveLength(1);
    credits.settle(job.id, 10000, 'verified invoice', userId); credits.settle(job.id, 0, 'duplicate');
    expect(credits.balance(userId)).toMatchObject({ balance: 0, held: 0 });
    expect(credits.charge(job.id)?.actual_cents).toBe(10000);
  });
  it('refunds only unsubmitted cancellations and releases once', () => {
    const job = reserve(2); credits.release(job.id); credits.release(job.id);
    expect(credits.balance(userId)).toMatchObject({ balance: 1000, held: 0 });
  });
  it('refreshes inactive accounts lazily, without carrying balances or old refunds forward', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T15:50:00Z'));
    const job = reserve(3); const pending = reserve(); expect(credits.balance(userId).balance).toBe(868);
    now.mockReturnValue(Date.parse('2026-10-11T16:00:00Z'));
    expect(credits.balance(userId).balance).toBe(1000); credits.release(job.id);
    expect(credits.balance(userId).balance).toBe(1000);
    credits.settle(pending.id, 66, 'late actual cost'); expect(credits.balance(userId).balance).toBe(967);
  });
  it('records idempotent administrator adjustments and resets them next week', () => {
    const id = randomUUID(); credits.adjust(userId, 25, 'test allowance', userId, id); credits.adjust(userId, 25, 'test allowance', userId, id);
    expect(credits.balance(userId).balance).toBe(1025); expect(() => credits.adjust(userId, 26, 'test allowance', userId, id)).toThrow();
    credits.adjust(userId, -2000, 'deduct', userId, randomUUID()); expect(credits.balance(userId).balance).toBe(0);
  });
  it('lets a positive balance fund one known-cost operation up to ¥3, then reaches zero', () => {
    credits.adjust(userId, -998, 'leave 2 points', userId, randomUUID());
    const paid = reserve(9); // ¥2.97, above the two-point balance
    expect(credits.charge(paid.id)).toMatchObject({ reserved: 200, quoted_cents: 297, grace: 1 });
    expect(credits.balance(userId)).toMatchObject({ balance: 0, held: 2 });
    credits.complete(paid.id); expect(credits.balance(userId)).toMatchObject({ balance: 0, held: 0 });
    expect(() => reserve()).toThrow('当前剩余 0 点');
  });
  it('refunds the final balance on known rejection and rejects unknown or above-¥3 quotes', () => {
    credits.adjust(userId, -999, 'leave 1 point', userId, randomUUID());
    expect(() => reserve(10)).toThrow('本次需要 330 点');
    expect(store.listJobs()).toHaveLength(0);
    const unknown = sampleJob({ kind: 'song', input: { ...sampleInput(), model: 'future-model' as 'mureka-9' } });
    expect(() => store.sqlite.transaction(() => { store.forUser(userId).createJob(unknown); credits.reserve(unknown.id); })()).toThrow('余额不足');
    expect(store.listJobs()).toHaveLength(0);
    const finalJob = reserve(); credits.release(finalJob.id);
    expect(credits.balance(userId)).toMatchObject({ balance: 1, held: 0 });
    const retried = reserve(); credits.complete(retried.id, { id: 'p', status: 'succeeded', model: 'mureka-9', choices: Array.from({ length: 10 }, (_, index) => ({ id: `c${index}`, url: `https://example.com/${index}.wav` })) });
    expect(credits.charge(retried.id)?.state).toBe('review'); // Unexpected actual price above the cap needs inspection.
  });
  it('migrates old wallets, holds and ledger to the new value without touching song data', () => {
    const job = sampleJob({ kind: 'song', input: { ...sampleInput(), mode: 'lyrics', lyrics: '示例歌词' } });
    store.forUser(userId).createJob(job);
    store.sqlite.prepare('INSERT INTO credit_wallets VALUES (?,?,?)').run(userId, creditWeek(), 4000);
    store.sqlite.prepare('INSERT INTO credit_charges (job_id,user_id,week,reserved,quoted_cents,state,unlimited,grace,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(job.id, userId, creditWeek(), 1000, 33, 'held', 0, 0, Date.now());
    store.sqlite.prepare('INSERT INTO credit_ledger VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), userId, job.id, -1000, 4000, 'reserve', '旧版预扣 10 点', null, Date.now());
    store.sqlite.exec('ALTER TABLE credit_charges DROP COLUMN grace; PRAGMA user_version = 7;');
    store.close(); store = new Store(root); credits = new Credits(store);
    expect(store.sqlite.pragma('user_version', { simple: true })).toBe(8);
    expect(credits.balance(userId)).toMatchObject({ balance: 967, held: 33 });
    expect(credits.charge(job.id)).toMatchObject({ reserved: 3300, grace: 0 });
    expect(credits.history(userId)).toHaveLength(2);
    credits.release(job.id); expect(credits.balance(userId).balance).toBe(1000);
    expect(store.getJob(job.id)?.id).toBe(job.id);
  });
  it('gives admins unlimited operations and keeps unknown-model settlements pending', () => {
    store.sqlite.prepare("UPDATE users SET role='admin' WHERE id=?").run(userId);
    for (let i = 0; i < 10; i++) { const job = reserve(3); credits.complete(job.id); }
    expect(credits.balance(userId)).toMatchObject({ unlimited: true, balance: 1000, held: 0 });
    const job = reserve(); credits.complete(job.id, { id: 'p', status: 'succeeded', model: 'unknown', choices: [{ id: 'x', url: 'https://example.com/x.wav' }] });
    expect(credits.charge(job.id)?.state).toBe('review');
  });
});
