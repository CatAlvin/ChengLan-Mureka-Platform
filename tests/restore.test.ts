import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { Store } from '../apps/server/src/db.js';
import { sampleInput, sampleJob, testWav } from './helpers.js';

it('verifies and restores an exported database into a new folder without replacing current data', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'chenglan-restore-'));
  let extracted: string | undefined;
  try {
    const store = new Store(folder); store.saveDraft(sampleInput());
    const job = sampleJob({ status: 'succeeded' }); store.createJob(job); const id = randomUUID();
    store.addTrack({ id, jobId: job.id, providerId: 'restore-test', title: '已处理的备份', mode: 'easy', duration: 3000, sourceDuration: 8000, processingVersion: 1, sourceFile: `${id}.wav`, localFile: `${id}.trimmed-v1.wav`, lyricsFile: `${id}.trimmed-v1.txt`, timedLyricsFile: `${id}.trimmed-v1.lrc`, model: 'test', lyrics: '歌词', lyricsSections: null, createdAt: Date.now(), saveStatus: 'saved', url: 'https://example.com/music.wav' });
    const assetId = randomUUID(); const exportId = randomUUID(); const collectionId = randomUUID();
    store.addMaterial({ id: assetId, name: '素材', originalFile: `${assetId}.source.webm`, previewFile: `${assetId}.preview.mp3`, duration: 40000, checksum: 'test-checksum', createdAt: Date.now(), deletedAt: null });
    store.addCollection({ id: collectionId, name: '可恢复的作品集', createdAt: Date.now(), archivedAt: null }); store.updateTrack(id, { collectionId });
    store.addExport({ id: exportId, trackId: id, format: 'flac', status: 'saved', localFile: `${exportId}.trimmed-v1.flac`, duration: 3000 });
    const scoreId = randomUUID(); const midiId = randomUUID();
    store.updateJob(job.id, { result: { title: '结果', lyrics: '', scoreFiles: [{ id: scoreId, format: 'musicxml', name: '乐谱.musicxml', bytes: 4 }, { id: midiId, format: 'mid', name: '音轨.mid', bytes: 4 }] } });
    store.close();
    const zip = path.join(folder, 'backup.zip');
    await writeFile(zip, zipSync({ 'manifest.json': strToU8(JSON.stringify({ version: 7, app: 'chenglan-music' })), 'chenglan.sqlite': await readFile(path.join(folder, 'chenglan.sqlite')),
      [`storage/${assetId}.source.webm`]: strToU8('fixture original'), [`storage/${assetId}.preview.mp3`]: strToU8('fixture preview'), [`storage/${exportId}.trimmed-v1.flac`]: strToU8('fixture flac'),
      [`storage/${scoreId}.musicxml`]: strToU8('score'), [`storage/${midiId}.mid`]: strToU8('midi'),
      [`storage/${id}.wav`]: testWav(), [`storage/${id}.trimmed-v1.wav`]: testWav(), [`storage/${id}.trimmed-v1.txt`]: strToU8('歌词'), [`storage/${id}.trimmed-v1.lrc`]: strToU8('[00:00.00]歌词') }));
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/restore.mjs', zip], { cwd: process.cwd() });
    extracted = stdout.split('\n')[0].split('Backup verified and extracted to: ')[1]?.trim();
    expect(extracted).toBeTruthy();
    const restored = new Store(path.join(extracted!, 'data'));
    try {
      expect(restored.listDrafts()[0].input.prompt).toBe(sampleInput().prompt);
      expect(restored.getTrack(id)?.processingVersion).toBe(1);
      expect(restored.getMaterial(assetId)?.checksum).toBe('test-checksum'); expect(restored.getTrack(id)?.collectionId).toBe(collectionId);
      expect(restored.getExport(exportId)?.duration).toBe(3000);
      expect(restored.getJob(job.id)?.result?.scoreFiles).toHaveLength(2); expect(await readFile(path.join(extracted!, 'storage', `${midiId}.mid`), 'utf8')).toBe('midi');
      expect(await readFile(path.join(extracted!, 'storage', `${assetId}.source.webm`), 'utf8')).toBe('fixture original');
      expect(await readFile(path.join(extracted!, 'storage', `${id}.trimmed-v1.lrc`), 'utf8')).toBe('[00:00.00]歌词');
    } finally { restored.close(); }
  } finally {
    await rm(folder, { recursive: true, force: true });
    const backupRoot = path.resolve('backups') + path.sep;
    if (extracted && path.resolve(extracted).startsWith(backupRoot)) await rm(extracted, { recursive: true, force: true });
  }
});

it('migrates a v3 workspace transactionally without changing its existing job input', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'chenglan-migrate-'));
  try {
    const old = new Store(folder); const job = sampleJob({ status: 'succeeded' }); old.createJob(job); old.saveDraft(sampleInput());
    old.sqlite.exec('DROP TABLE registrations; DROP TABLE app_settings; DROP TABLE credit_charges; DROP TABLE credit_wallets; DROP TABLE credit_ledger; DROP TABLE sessions; DROP TABLE users; DROP TABLE login_attempts; DROP TABLE admin_audit; DROP INDEX jobs_owner; ALTER TABLE generation_jobs DROP COLUMN owner_id; DROP INDEX tracks_owner; ALTER TABLE tracks DROP COLUMN owner_id; CREATE TABLE drafts_old (mode TEXT PRIMARY KEY, input TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO drafts_old SELECT mode,input,updated_at FROM drafts; DROP TABLE drafts; ALTER TABLE drafts_old RENAME TO drafts; DROP TABLE materials; DROP TABLE collections; DROP TABLE audio_exports; ALTER TABLE tracks DROP COLUMN collection_id; ALTER TABLE tracks DROP COLUMN origin; ALTER TABLE tracks DROP COLUMN checksum; PRAGMA user_version = 3;'); old.close();
    const updated = new Store(folder);
    try { expect(updated.sqlite.pragma('user_version', { simple: true })).toBe(8); expect(updated.getJob(job.id)?.input).toEqual(job.input); expect(updated.listDrafts()[0].input).toEqual(sampleInput()); expect(updated.listMaterials()).toEqual([]); } finally { updated.close(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it('rejects an archive containing paths outside the allowed backup files', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'chenglan-unsafe-'));
  try {
    const zip = path.join(folder, 'bad.zip');
    await writeFile(zip, zipSync({ '../outside.txt': strToU8('test') }));
    await expect(promisify(execFile)(process.execPath, ['scripts/restore.mjs', zip], { cwd: process.cwd() })).rejects.toThrow();
  } finally { await rm(folder, { recursive: true, force: true }); }
});
