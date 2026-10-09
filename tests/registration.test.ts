import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/server/src/app';
import { FakeProvider, testCredentials, loginAs, sampleInput } from './helpers';
import { ProviderError } from '../apps/server/src/provider';

describe('registration, approval and protected quota API', () => {
  let root: string; let server: Awaited<ReturnType<typeof buildApp>>; let admin: Awaited<ReturnType<typeof loginAs>>; let guest: typeof admin; let alice: typeof admin; let aliceId: string;
  const provider = new FakeProvider(); const password = 'Registration-only-test-123';
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chenglan-register-')); server = await buildApp({ root, bootstrap: testCredentials, provider }); admin = await loginAs(server.app);
    const session = await server.app.inject({ url: '/api/session', headers: { host: admin.host } }); guest = { host: admin.host, cookie: session.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': session.json().csrfToken };
  });
  afterAll(async () => { await server.app.close(); await rm(root, { recursive: true, force: true }); });
  const post = (url: string, payload: Record<string, unknown>, headers = guest) => server.app.inject({ method: 'POST', url, payload, headers });
  it('accepts five applications, rejects overflow, CSRF and unauthenticated access', async () => {
    expect((await server.app.inject({ url: '/api/registration', headers: guest })).json()).toMatchObject({ limit: 5, pending: 0, available: true });
    expect((await post('/api/auth/register', { username: 'badcsrf', password }, { ...guest, 'x-csrf-token': 'bad' })).statusCode).toBe(403);
    for (const username of ['alice_new', 'second', 'third', 'fourth', 'fifth']) expect((await post('/api/auth/register', { username, password })).statusCode).toBe(202);
    expect((await post('/api/auth/register', { username: 'sixth', password })).statusCode).toBe(409);
    expect((await post('/api/auth/login', { username: 'alice_new', password })).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/api/admin/registrations', headers: guest })).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/api/snapshot', headers: guest })).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/api/registration', headers: guest })).body).not.toContain('alice_new');
  });
  it('approves into a valid normal account, redacts hashes and releases a rejected slot', async () => {
    const response = await server.app.inject({ url: '/api/admin/registrations', headers: admin }); expect(response.body).not.toContain('scrypt');
    const rows = response.json().requests as { id: string; username: string }[]; aliceId = rows.find(r => r.username === 'alice_new')!.id;
    expect((await post(`/api/admin/registrations/${aliceId}/approve`, {}, admin)).statusCode).toBe(200);
    expect((await post(`/api/admin/registrations/${aliceId}/approve`, {}, admin)).statusCode).toBe(409);
    alice = await loginAs(server.app, { username: 'alice_new', password });
    const snapshot = (await server.app.inject({ url: '/api/snapshot', headers: alice })).json(); expect(snapshot.credits).toMatchObject({ balance: 1000, unlimited: false });
    expect(snapshot.jobs).toHaveLength(0); expect((await server.app.inject({ url: '/api/admin/registrations', headers: alice })).statusCode).toBe(403);
    expect((await post(`/api/admin/registrations/${rows.find(r => r.username === 'second')!.id}/reject`, {}, admin)).statusCode).toBe(200);
    expect((await post('/api/auth/register', { username: 'sixth', password })).statusCode).toBe(202);
  });
  it('enforces queue limits atomically when the final slot is requested concurrently', async () => {
    const responses = await Promise.all(['last_a', 'last_b'].map(username => post('/api/auth/register', { username, password })));
    expect(responses.map(r => r.statusCode).sort()).toEqual([202, 409]);
    expect((await server.app.inject({ url: '/api/registration', headers: guest })).json().pending).toBe(5);
  });
  it('normal users can submit V9, duplicate submissions reserve once and insufficient requests leave no job', async () => {
    const input = { ...sampleInput(), mode: 'lyrics', lyrics: '测试歌词', model: 'mureka-9', count: 3 }; const submissionId = randomUUID();
    const responses = await Promise.all([post('/api/jobs', { submissionId, input }, alice), post('/api/jobs', { submissionId, input }, alice)]);
    expect(responses.map(r => r.statusCode)).toEqual([202, 202]); expect(responses[0].json().id).toBe(responses[1].json().id);
    expect(server.runner.credits.balance(aliceId).balance).toBe(901);
    expect((await post(`/api/admin/users/${aliceId}/credits`, { requestId: randomUUID(), points: -900, reason: 'test final use' }, admin)).statusCode).toBe(200);
    const final = await post('/api/jobs', { submissionId: randomUUID(), input }, alice);
    expect(final.statusCode).toBe(202); expect(server.runner.credits.charge(final.json().id)?.grace).toBe(1);
    expect(server.runner.credits.balance(aliceId).balance).toBe(0);
    expect((await post('/api/jobs', { submissionId: randomUUID(), input }, alice)).statusCode).toBe(402); expect(server.store.forUser(aliceId).listJobs()).toHaveLength(2);
    expect((await post(`/api/jobs/${final.json().id}/cancel`, {}, alice)).statusCode).toBe(200);
    expect((await post(`/api/jobs/${responses[0].json().id}/cancel`, {}, alice)).statusCode).toBe(200);
    expect((await post(`/api/admin/users/${aliceId}/credits`, { requestId: randomUUID(), points: 900, reason: 'restore fixture balance' }, admin)).statusCode).toBe(200);
    expect(server.runner.credits.balance(aliceId).balance).toBe(1000);
  });
  it('returns points for a known rejection, retains ambiguous charges, and blocks forged quota changes', async () => {
    const input = { ...sampleInput(), mode: 'lyrics', lyrics: '测试歌词', model: 'mureka-9' };
    provider.submitError = new ProviderError('invalid', 400);
    const rejected = await post('/api/jobs', { submissionId: randomUUID(), input }, alice); await server.runner.tick();
    expect(server.runner.credits.charge(rejected.json().id)?.state).toBe('released'); expect(server.runner.credits.balance(aliceId).balance).toBe(1000);
    provider.submitError = new ProviderError('unknown', 0, null, true);
    const unknown = await post('/api/jobs', { submissionId: randomUUID(), input }, alice); await server.runner.tick();
    expect(server.runner.credits.charge(unknown.json().id)?.state).toBe('review'); expect(server.runner.credits.balance(aliceId).balance).toBe(967);
    await post(`/api/jobs/${unknown.json().id}/reconcile`, { checked: true }, alice); expect(server.runner.credits.balance(aliceId).balance).toBe(967);
    expect((await post(`/api/admin/users/${aliceId}/credits`, { requestId: randomUUID(), points: 999, reason: 'forged' }, alice)).statusCode).toBe(403);
    expect((await post(`/api/admin/credits/${unknown.json().id}/settle`, { cents: 8, reason: 'test invoice' }, admin)).statusCode).toBe(200);
    expect(server.runner.credits.balance(aliceId).balance).toBe(992); provider.submitError = null;
  });
  it('allows auditable admin additions and deductions, revokes disabled accounts and refunds their queued jobs', async () => {
    const payload = { requestId: randomUUID(), points: 10, reason: 'fixture allowance' };
    for (let i = 0; i < 2; i++) expect((await post(`/api/admin/users/${aliceId}/credits`, payload, admin)).statusCode).toBe(200);
    expect(server.runner.credits.balance(aliceId).balance).toBe(1002);
    const input = { ...sampleInput(), mode: 'lyrics', lyrics: '测试歌词' }; await post('/api/jobs', { submissionId: randomUUID(), input }, alice);
    expect((await server.app.inject({ method: 'PATCH', url: `/api/admin/users/${aliceId}`, headers: admin, payload: { disabled: true } })).statusCode).toBe(200);
    expect(server.runner.credits.balance(aliceId).balance).toBe(1002);
    expect((await server.app.inject({ url: '/api/snapshot', headers: alice })).statusCode).toBe(401);
    expect((await post('/api/auth/login', { username: 'alice_new', password })).statusCode).toBe(401);
  });
});
