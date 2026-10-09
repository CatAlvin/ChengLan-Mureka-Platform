import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { unzipSync } from 'fflate';
import { buildApp } from '../apps/server/src/app.js';
import { LEGACY_USER_ID } from '../apps/server/src/db.js';
import { loginAs, testCredentials, FakeProvider, fakeDownload, sampleInput, sampleJob, testWav } from './helpers.js';

describe('accounts and private workspaces', () => {
  let server: Awaited<ReturnType<typeof buildApp>>;
  let root: string; let admin: Awaited<ReturnType<typeof loginAs>>; let alice: typeof admin; let bob: typeof admin;
  let aliceId: string; let bobId: string; let trackId: string; let jobId: string; let materialId: string; let collectionId: string; let exportId: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chenglan-auth-'));
    server = await buildApp({ root, bootstrap: testCredentials, provider: new FakeProvider(), downloader: fakeDownload });
    admin = await loginAs(server.app);
    for (const username of ['alice','bob']) {
      const response = await server.app.inject({ method: 'POST', url: '/api/admin/users', headers: admin, payload: { username, displayName: username, password: 'Temporary-test-123' } });
      expect(response.statusCode).toBe(201);
      const headers = await loginAs(server.app, { username, password: 'Temporary-test-123' });
      expect((await server.app.inject({ url: '/api/snapshot', headers })).statusCode).toBe(428);
      const changed = await server.app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: 'Temporary-test-123', password: 'Private-test-456' } });
      expect(changed.statusCode).toBe(200);
      expect((await server.app.inject({ url: '/api/snapshot', headers })).statusCode).toBe(401);
      const ready = await loginAs(server.app, { username, password: 'Private-test-456' });
      if (username === 'alice') { alice = ready; aliceId = response.json().id; } else { bob = ready; bobId = response.json().id; }
    }
    const own = server.store.forUser(aliceId); const job = sampleJob({ status: 'succeeded', kind: 'stem', input: { ...sampleInput(), prompt: 'Alice-secret-lyrics-unique' } });
    own.createJob(job); jobId = job.id; trackId = randomUUID(); materialId = randomUUID(); collectionId = randomUUID(); exportId = randomUUID();
    await writeFile(path.join(root,'storage',`${trackId}.wav`),testWav()); await writeFile(path.join(root,'storage',`${trackId}.txt`),'Alice-secret-lyrics-unique');
    own.addTrack({ id: trackId, jobId, providerId: 'owned-result', model: 'fixture', title: 'Alice-private-title', mode: 'easy', duration: 8000, createdAt: Date.now(), saveStatus: 'saved', url: 'https://example.com/private', localFile: `${trackId}.wav`, lyricsFile: `${trackId}.txt`, lyrics: 'Alice-secret-lyrics-unique' });
    own.addMaterial({ id: materialId, name: 'Alice-material', originalFile: `${trackId}.wav`, previewFile: `${trackId}.wav`, duration: 8000, createdAt: Date.now(), deletedAt: null, checksum: 'test' });
    own.addCollection({ id: collectionId, name: 'Alice-collection', createdAt: Date.now() });
    own.addExport({ id: exportId, trackId, format: 'wav', status: 'saved', localFile: `${trackId}.wav` });
    own.saveDraft({ ...sampleInput(), prompt: 'Alice-secret-lyrics-unique' });
    server.store.forUser(bobId).saveDraft({ ...sampleInput(), prompt: 'Bob-only-draft' });
  }, 30000);
  afterAll(async () => { await server?.app.close(); if(root) await rm(root,{recursive:true,force:true}); });
  it('requires authentication on API, media and encoded route variants; registration is public only for guests', async () => {
    for (const url of ['/api/snapshot',`/media/${trackId}`,`/api/tracks/${trackId}/lyrics`]) expect((await server.app.inject({url,headers:{host:admin.host}})).statusCode).toBe(401);
    for (const url of ['/api%2Fsnapshot','/api/%73napshot','/%61pi/snapshot']) { const res=await server.app.inject({url,headers:{host:admin.host}}); expect(res.body).not.toContain('Alice-private-title'); expect(res.statusCode).not.toBe(200); }
    expect((await server.app.inject({method:'POST',url:'/api/auth/register',headers:alice,payload:{}})).statusCode).toBe(409);
    expect((await server.app.inject({method:'POST',url:'/api/shutdown',headers:admin})).statusCode).toBe(403);
  });
  it('filters every list, drafts, file sizes and account billing by identity', async () => {
    const own=(await server.app.inject({url:'/api/snapshot',headers:alice})).json(); const other=(await server.app.inject({url:'/api/snapshot',headers:bob})).json();
    expect(own.tracks).toHaveLength(1); expect(own.materials).toHaveLength(1); expect(other.tracks).toHaveLength(0); expect(other.jobs).toHaveLength(0); expect(other.materials).toHaveLength(0); expect(other.collections).toHaveLength(0); expect(other.storageBytes).toBe(0); expect(other.account.balance).toBeNull();
    expect((await server.app.inject({url:'/api/drafts',headers:bob})).body).not.toContain('Alice-secret');
    expect((await server.app.inject({url:'/api/snapshot',headers:admin})).json().tracks).toHaveLength(0);
    expect((await server.app.inject({url:'/api/admin/usage',headers:admin})).body).not.toContain('Alice-private-title');
  });
  it('rejects guessed identifiers for audio, lyrics, stems, exports, materials and writes', async () => {
    for (const url of [`/media/${trackId}`,`/media/${trackId}?download=1`,`/media/${trackId}?download=1&bundle=1`,`/api/tracks/${trackId}/lyrics`,`/api/jobs/${jobId}/download`,`/api/exports/${exportId}/download`,`/api/exports/${exportId}/download?bundle=1`,`/api/materials/${materialId}/media`]) {
      expect((await server.app.inject({url,headers:alice})).statusCode).toBe(200);
      expect((await server.app.inject({url,headers:bob})).statusCode).toBe(404);
      expect((await server.app.inject({url,headers:admin})).statusCode).toBe(404);
    }
    for (const [url,payload] of [[`/api/tracks/${trackId}`,{title:'stolen'}],[`/api/materials/${materialId}`,{name:'stolen'}],[`/api/collections/${collectionId}`,{name:'stolen'}]] as const) expect((await server.app.inject({method:'PATCH',url,headers:bob,payload})).statusCode).toBe(404);
    expect((await server.app.inject({method:'POST',url:`/api/jobs/${jobId}/cancel`,headers:bob})).statusCode).toBe(404);
    expect((await server.app.inject({method:'POST',url:'/api/jobs',headers:bob,payload:{submissionId:randomUUID(),input:{...sampleInput(),collectionId}}})).statusCode).toBe(400);
    const importCollision=await server.app.inject({method:'POST',url:`/api/materials?id=${materialId}&name=other.wav`,headers:{...bob,'content-type':'application/octet-stream'},payload:testWav()});
    expect(importCollision.statusCode).toBe(409); expect((await readFile(path.join(root,'storage',`${trackId}.wav`))).length).toBeGreaterThan(100);
  });
  it('produces backups containing only the requesting user and no deleted SQL pages or credentials', async () => {
    const response=await server.app.inject({method:'POST',url:'/api/backup',headers:bob}); expect(response.statusCode).toBe(200);
    const entries=unzipSync(response.rawPayload); expect(Object.keys(entries)).toEqual(['chenglan.sqlite','manifest.json']);
    const bytes=Buffer.from(entries['chenglan.sqlite']); expect(bytes.includes(Buffer.from('Alice-secret-lyrics-unique'))).toBe(false); expect(bytes.includes(Buffer.from('scrypt$'))).toBe(false);
    const file=path.join(root,'backup-check.sqlite'); await writeFile(file,bytes); const db=new Database(file);
    try { expect(db.prepare('SELECT count(*) n FROM users').get()).toEqual({n:0}); expect(db.prepare('SELECT count(*) n FROM sessions').get()).toEqual({n:0}); expect(db.prepare('SELECT count(*) n FROM tracks').get()).toEqual({n:0}); expect(db.prepare('SELECT owner_id FROM drafts').all()).toEqual([{owner_id:bobId}]); } finally { db.close(); }
  });
  it('requires admin role and CSRF, normalizes usernames and protects the current admin', async () => {
    expect((await server.app.inject({url:'/api/admin/users',headers:alice})).statusCode).toBe(403);
    expect((await server.app.inject({method:'POST',url:'/api/admin/users',headers:alice,payload:{}})).statusCode).toBe(403);
    expect((await server.app.inject({method:'POST',url:'/api/admin/users',headers:{host:admin.host,cookie:admin.cookie},payload:{}})).statusCode).toBe(403);
    expect((await server.app.inject({method:'PATCH',url:`/api/admin/users/${LEGACY_USER_ID}`,headers:admin,payload:{disabled:true}})).statusCode).toBe(400);
    expect((await server.app.inject({method:'POST',url:'/api/admin/users',headers:admin,payload:{username:'ALICE',displayName:'duplicate',password:'Test-only-123'}})).statusCode).toBe(409);
    expect((await server.app.inject({url:'/api/admin/users',headers:admin})).body).not.toContain('password_hash');
  });
  it('revokes sessions on password reset, disability and role change, and cancels unsubmitted work', async () => {
    const queued=sampleJob();server.store.forUser(bobId).createJob(queued);
    expect((await server.app.inject({method:'PATCH',url:`/api/admin/users/${bobId}`,headers:admin,payload:{disabled:true}})).statusCode).toBe(200);
    expect((await server.app.inject({url:'/api/snapshot',headers:bob})).statusCode).toBe(401);expect(server.store.getJob(queued.id)?.status).toBe('cancelled');
    await server.app.inject({method:'PATCH',url:`/api/admin/users/${bobId}`,headers:admin,payload:{disabled:false}});
    bob=await loginAs(server.app,{username:'bob',password:'Private-test-456'});
    await server.app.inject({method:'PATCH',url:`/api/admin/users/${bobId}`,headers:admin,payload:{role:'admin'}});
    expect((await server.app.inject({url:'/api/admin/users',headers:bob})).statusCode).toBe(401);
    bob=await loginAs(server.app,{username:'bob',password:'Private-test-456'});
    await server.app.inject({method:'POST',url:`/api/admin/users/${bobId}/password`,headers:admin,payload:{password:'Reset-test-789'}});
    expect((await server.app.inject({url:'/api/snapshot',headers:bob})).statusCode).toBe(401);
    const reset=await loginAs(server.app,{username:'bob',password:'Reset-test-789'});expect((await server.app.inject({url:'/api/admin/users',headers:reset})).statusCode).toBe(428);
    await server.app.inject({method:'POST',url:'/api/auth/logout',headers:alice});expect((await server.app.inject({url:'/api/snapshot',headers:alice})).statusCode).toBe(401);
  });
  it('throttles repeated invalid password attempts', async () => {
    const guest=await server.app.inject({url:'/api/session',headers:{host:admin.host}});const headers={host:admin.host,cookie:guest.cookies.map(c=>`${c.name}=${c.value}`).join('; '),'x-csrf-token':guest.json().csrfToken};
    for(let i=0;i<12;i++)expect((await server.app.inject({method:'POST',url:'/api/auth/login',headers,payload:{username:'missing-user',password:'Invalid-test-123'}})).statusCode).toBe(401);
    expect((await server.app.inject({method:'POST',url:'/api/auth/login',headers,payload:{username:'missing-user',password:'Invalid-test-123'}})).statusCode).toBe(429);
  });
});

it('uses secure production cookies and rejects foreign origins and browser shutdown', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'chenglan-prod-'));const host='music.example.com'; const server=await buildApp({root,bootstrap:testCredentials,provider:new FakeProvider(),publicOrigin:`https://${host}`});
  try {
    const response=await server.app.inject({url:'/api/session',headers:{host}});
    expect(response.headers['set-cookie']).toContain('__Host-chenglan_session');expect(response.headers['set-cookie']).toContain('Secure');expect(response.headers['set-cookie']).toContain('HttpOnly');expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    expect((await server.app.inject({url:'/api/session',headers:{host,origin:'https://evil.example'}})).statusCode).toBe(403);
    expect((await server.app.inject({url:'/api/session',headers:{host:'localhost:4173'}})).statusCode).toBe(403);
    const headers=await loginAs(server.app,testCredentials,host);expect((await server.app.inject({method:'POST',url:'/api/shutdown',headers})).statusCode).toBe(403);
  }finally{await server.app.close();await rm(root,{recursive:true,force:true});}
});
