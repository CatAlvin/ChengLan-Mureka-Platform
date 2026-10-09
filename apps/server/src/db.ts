import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { eq, desc, and } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scoreFilename } from './score-files.js';
import type { CreativeInput, Job, JobKind, JobStatus, LyricsResult, Track, ToolInput, Material, AudioExport } from '../../../packages/shared/src/index.js';

export const LEGACY_USER_ID = '00000000-0000-4000-8000-000000000001';
const ownerColumn = () => text('owner_id').notNull().default(LEGACY_USER_ID);
export const jobs = sqliteTable('generation_jobs', {
  ownerId: ownerColumn(), id: text('id').primaryKey(), submissionId: text('submission_id').notNull().unique(),
  kind: text('kind').$type<JobKind>().notNull(), input: text('input', { mode: 'json' }).$type<CreativeInput>().notNull(),
  status: text('status').$type<JobStatus>().notNull(), providerId: text('provider_id'), error: text('error'), traceId: text('trace_id'),
  result: text('result', { mode: 'json' }).$type<LyricsResult>(),
  tool: text('tool', { mode: 'json' }).$type<ToolInput>(), artifactUrl: text('artifact_url'),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(), pollAfter: integer('poll_after').notNull().default(0),
});
export const tracks = sqliteTable('tracks', {
  ownerId: ownerColumn(),
  id: text('id').primaryKey(), jobId: text('job_id').notNull().references(() => jobs.id),
  providerId: text('provider_id').notNull(), title: text('title').notNull(), mode: text('mode').$type<CreativeInput['mode']>().notNull(),
  duration: integer('duration').notNull(), model: text('model').notNull(), lyrics: text('lyrics').notNull(),
  lyricsSections: text('lyrics_sections', { mode: 'json' }).$type<unknown>(),
  favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false), deletedAt: integer('deleted_at'),
  createdAt: integer('created_at').notNull(), saveStatus: text('save_status').$type<Track['saveStatus']>().notNull(), saveError: text('save_error'),
  url: text('url').notNull(), flacUrl: text('flac_url'), wavUrl: text('wav_url'),
  localFile: text('local_file'), contentType: text('content_type'),
  sourceFile: text('source_file'), sourceDuration: integer('source_duration'),
  processingVersion: integer('processing_version').notNull().default(0),
  lyricsFile: text('lyrics_file'), timedLyricsFile: text('timed_lyrics_file'),
  watermarked: integer('watermarked', { mode: 'boolean' }).notNull().default(false),
  parentTrackId: text('parent_track_id'), operation: text('operation').$type<Track['operation']>(), stemName: text('stem_name'),
  collectionId: text('collection_id'),
  origin: text('origin').$type<'generated' | 'uploaded'>().notNull().default('generated'), checksum: text('checksum'),
});
const materials = sqliteTable('materials', {
  ownerId: ownerColumn(),
  id: text('id').primaryKey(), name: text('name').notNull(), originalFile: text('original_file').notNull(), previewFile: text('preview_file').notNull(),
  duration: integer('duration').notNull(), createdAt: integer('created_at').notNull(), deletedAt: integer('deleted_at'), checksum: text('checksum').notNull(),
});
const collections = sqliteTable('collections', { ownerId: ownerColumn(), id: text('id').primaryKey(), name: text('name').notNull(), createdAt: integer('created_at').notNull(), archivedAt: integer('archived_at') });
const audioExports = sqliteTable('audio_exports', {
  id: text('id').primaryKey(), trackId: text('track_id').notNull().references(() => tracks.id), format: text('format').$type<'flac' | 'wav'>().notNull(),
  status: text('status').$type<AudioExport['status']>().notNull(), error: text('error'), sourceFile: text('source_file'), localFile: text('local_file'),
  duration: integer('duration').notNull().default(0), lyricsFile: text('lyrics_file'), timedLyricsFile: text('timed_lyrics_file'),
});
const drafts = sqliteTable('drafts', {
  ownerId: ownerColumn(), mode: text('mode').notNull(), input: text('input', { mode: 'json' }).$type<CreativeInput>().notNull(), updatedAt: integer('updated_at').notNull(),
}, table => [primaryKey({ columns: [table.ownerId, table.mode] })]);
export type StoredTrack = typeof tracks.$inferSelect;
export type StoredJob = typeof jobs.$inferSelect;
export type StoredMaterial = typeof materials.$inferSelect;
export type StoredExport = typeof audioExports.$inferSelect;

export class Store {
  private ownerId: string | null = null;
  forUser(ownerId: string): Store { return Object.assign(Object.create(Store.prototype), { ...this, ownerId }); }
  readonly sqlite: Database.Database;
  readonly db;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.sqlite = new Database(path.join(dataDir, 'chenglan.sqlite'));
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    // Versioned, transactional schema bootstrap; future versions add migrations here.
    this.sqlite.transaction(() => {
      const version = this.sqlite.pragma('user_version', { simple: true }) as number;
      if (version > 8) throw new Error('数据库版本高于当前程序，请更新应用后再打开。');
      if (version === 0) {
        this.sqlite.exec(`
          CREATE TABLE generation_jobs (
            id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
            input TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT, error TEXT, trace_id TEXT,
            result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, poll_after INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX jobs_status ON generation_jobs(status);
          CREATE TABLE tracks (
            id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id), provider_id TEXT NOT NULL,
            title TEXT NOT NULL, mode TEXT NOT NULL, duration INTEGER NOT NULL, model TEXT NOT NULL,
            lyrics TEXT NOT NULL, lyrics_sections TEXT, favorite INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
            created_at INTEGER NOT NULL, save_status TEXT NOT NULL, save_error TEXT,
            url TEXT NOT NULL, flac_url TEXT, wav_url TEXT, local_file TEXT, content_type TEXT,
            watermarked INTEGER NOT NULL DEFAULT 0, UNIQUE(job_id, provider_id)
          );
          CREATE TABLE drafts (mode TEXT PRIMARY KEY, input TEXT NOT NULL, updated_at INTEGER NOT NULL);
          PRAGMA user_version = 1;
        `);
      }
      if (version < 2) this.sqlite.exec(`
        ALTER TABLE tracks ADD COLUMN source_file TEXT;
        ALTER TABLE tracks ADD COLUMN source_duration INTEGER;
        ALTER TABLE tracks ADD COLUMN processing_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tracks ADD COLUMN lyrics_file TEXT;
        ALTER TABLE tracks ADD COLUMN timed_lyrics_file TEXT;
        PRAGMA user_version = 2;
      `);
      if (version < 3) this.sqlite.exec(`
        ALTER TABLE generation_jobs ADD COLUMN tool TEXT;
        ALTER TABLE generation_jobs ADD COLUMN artifact_url TEXT;
        ALTER TABLE tracks ADD COLUMN parent_track_id TEXT;
        ALTER TABLE tracks ADD COLUMN operation TEXT;
        ALTER TABLE tracks ADD COLUMN stem_name TEXT;
        PRAGMA user_version = 3;
      `);
      if (version < 4) this.sqlite.exec(`
        CREATE TABLE materials (id TEXT PRIMARY KEY, name TEXT NOT NULL, original_file TEXT NOT NULL, preview_file TEXT NOT NULL, duration INTEGER NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER, checksum TEXT NOT NULL);
        CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER);
        ALTER TABLE tracks ADD COLUMN collection_id TEXT;
        CREATE TABLE audio_exports (id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id), format TEXT NOT NULL, status TEXT NOT NULL, error TEXT, source_file TEXT, local_file TEXT, duration INTEGER NOT NULL DEFAULT 0, lyrics_file TEXT, timed_lyrics_file TEXT, UNIQUE(track_id, format));
        PRAGMA user_version = 4;
      `);
      if (version < 5) this.sqlite.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','admin')), disabled INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, password_changed_at INTEGER NOT NULL, last_login_at INTEGER);
        CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE TABLE login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE admin_audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, target_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL);
        ALTER TABLE generation_jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}';
        ALTER TABLE tracks ADD COLUMN owner_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}';
        ALTER TABLE materials ADD COLUMN owner_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}';
        ALTER TABLE collections ADD COLUMN owner_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}';
        ALTER TABLE drafts RENAME TO drafts_v4;
        CREATE TABLE drafts (owner_id TEXT NOT NULL, mode TEXT NOT NULL, input TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner_id, mode));
        INSERT INTO drafts SELECT '${LEGACY_USER_ID}', mode, input, updated_at FROM drafts_v4;
        DROP TABLE drafts_v4;
        CREATE INDEX jobs_owner ON generation_jobs(owner_id);
        CREATE INDEX tracks_owner ON tracks(owner_id);
        CREATE INDEX materials_owner ON materials(owner_id);
        CREATE INDEX collections_owner ON collections(owner_id);
        PRAGMA user_version = 5;
      `);
      if (version < 6) this.sqlite.exec(`
        ALTER TABLE tracks ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated';
        ALTER TABLE tracks ADD COLUMN checksum TEXT;
        PRAGMA user_version = 6;
      `);
      if (version < 7) this.sqlite.exec(`
        CREATE TABLE registrations (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT INTO app_settings VALUES ('registration_limit', 5);
        CREATE TABLE credit_wallets (user_id TEXT PRIMARY KEY REFERENCES users(id), week INTEGER NOT NULL, balance INTEGER NOT NULL CHECK(balance >= 0));
        CREATE TABLE credit_charges (job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id), user_id TEXT NOT NULL REFERENCES users(id), week INTEGER NOT NULL, reserved INTEGER NOT NULL, quoted_cents INTEGER, actual_cents INTEGER, state TEXT NOT NULL CHECK(state IN ('held','review','settled','released')), unlimited INTEGER NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER, note TEXT);
        CREATE INDEX credit_charges_user ON credit_charges(user_id);
        CREATE TABLE credit_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), job_id TEXT, delta INTEGER NOT NULL, balance INTEGER NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, actor_id TEXT, created_at INTEGER NOT NULL);
        CREATE INDEX credit_ledger_user ON credit_ledger(user_id, created_at);
        PRAGMA user_version = 7;
      `);
      if (version < 8) {
        this.sqlite.exec('ALTER TABLE credit_charges ADD COLUMN grace INTEGER NOT NULL DEFAULT 0');
        // Convert every old point amount to the new ¥1 = 100 point scale. Add the
        // current week's ¥8.35 difference so a fresh old 50-point wallet becomes 1000.
        const currentWeek = (() => { const local = new Date(Date.now() + 8 * 3600000); return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (local.getUTCDay() + 6) % 7) - 8 * 3600000; })();
        this.sqlite.exec(`
          UPDATE credit_ledger SET delta=CAST(ROUND(delta*3.3) AS INTEGER), balance=CAST(ROUND(balance*3.3) AS INTEGER), note=note||'（旧版点数已换算）';
          UPDATE credit_charges SET reserved=CAST(ROUND(reserved*3.3) AS INTEGER);
          UPDATE credit_wallets SET balance=CAST(ROUND(balance*3.3) AS INTEGER);
        `);
        const wallets = this.sqlite.prepare('SELECT user_id,balance FROM credit_wallets WHERE week=?').all(currentWeek) as { user_id: string; balance: number }[];
        const topUp = this.sqlite.prepare('UPDATE credit_wallets SET balance=balance+83500 WHERE user_id=?');
        const entry = this.sqlite.prepare('INSERT INTO credit_ledger VALUES (?,?,?,?,?,?,?,?,?)');
        for (const wallet of wallets) {
          topUp.run(wallet.user_id);
          entry.run(randomUUID(), wallet.user_id, null, 83500, wallet.balance + 83500, 'policy', '每周额度从 ¥1.65 提升至 ¥10', null, Date.now());
        }
        this.sqlite.pragma('user_version = 8');
      }
    })();
    this.db = drizzle(this.sqlite);
  }
  listJobs(): StoredJob[] { return this.db.select().from(jobs).where(this.ownerId ? eq(jobs.ownerId, this.ownerId) : undefined).orderBy(desc(jobs.createdAt)).all(); }
  publicJobs(): Job[] { return this.listJobs().map(({ artifactUrl: _artifactUrl, ...job }) => job); }
  getJob(id: string) { return this.db.select().from(jobs).where(and(eq(jobs.id, id), this.ownerId ? eq(jobs.ownerId, this.ownerId) : undefined)).get(); }
  getSubmission(id: string) { return this.db.select().from(jobs).where(and(eq(jobs.submissionId, id), this.ownerId ? eq(jobs.ownerId, this.ownerId) : undefined)).get(); }
  createJob(job: Job & { ownerId?: string }): Job { this.db.insert(jobs).values({ ...job, ownerId: this.ownerId || job.ownerId || LEGACY_USER_ID }).run(); return job; }
  updateJob(id: string, patch: Partial<StoredJob>) {
    this.db.update(jobs).set({ ...patch, updatedAt: Date.now() }).where(and(eq(jobs.id, id), this.ownerId ? eq(jobs.ownerId, this.ownerId) : undefined)).run();
  }
  listTracks(): StoredTrack[] { return this.db.select().from(tracks).where(this.ownerId ? eq(tracks.ownerId, this.ownerId) : undefined).orderBy(desc(tracks.createdAt)).all(); }
  getTrack(id: string) { return this.db.select().from(tracks).where(and(eq(tracks.id, id), this.ownerId ? eq(tracks.ownerId, this.ownerId) : undefined)).get(); }
  addTrack(track: typeof tracks.$inferInsert) { this.db.insert(tracks).values({ ...track, ownerId: this.ownerId || track.ownerId || LEGACY_USER_ID }).onConflictDoNothing().run(); }
  updateTrack(id: string, patch: Partial<StoredTrack>) { this.db.update(tracks).set(patch).where(and(eq(tracks.id, id), this.ownerId ? eq(tracks.ownerId, this.ownerId) : undefined)).run(); }
  listMaterials() { return this.db.select().from(materials).where(this.ownerId ? eq(materials.ownerId, this.ownerId) : undefined).orderBy(desc(materials.createdAt)).all(); }
  getMaterial(id: string) { return this.db.select().from(materials).where(and(eq(materials.id, id), this.ownerId ? eq(materials.ownerId, this.ownerId) : undefined)).get(); }
  addMaterial(asset: Omit<StoredMaterial, 'ownerId'> & { ownerId?: string }) { this.db.insert(materials).values({ ...asset, ownerId: this.ownerId || asset.ownerId || LEGACY_USER_ID }).run(); }
  updateMaterial(id: string, patch: Partial<StoredMaterial>) { this.db.update(materials).set(patch).where(and(eq(materials.id, id), this.ownerId ? eq(materials.ownerId, this.ownerId) : undefined)).run(); }
  publicMaterials(): Material[] { return this.listMaterials().map(({ originalFile: _original, previewFile: _preview, checksum: _checksum, ...asset }) => ({ ...asset, playbackUrl: `/api/materials/${asset.id}/media` })); }
  listCollections() { return this.db.select().from(collections).where(this.ownerId ? eq(collections.ownerId, this.ownerId) : undefined).orderBy(desc(collections.createdAt)).all(); }
  getCollection(id: string) { return this.db.select().from(collections).where(and(eq(collections.id, id), this.ownerId ? eq(collections.ownerId, this.ownerId) : undefined)).get(); }
  addCollection(value: typeof collections.$inferInsert) { this.db.insert(collections).values({ ...value, ownerId: this.ownerId || value.ownerId || LEGACY_USER_ID }).run(); }
  updateCollection(id: string, patch: Partial<typeof collections.$inferInsert>) { this.db.update(collections).set(patch).where(and(eq(collections.id, id), this.ownerId ? eq(collections.ownerId, this.ownerId) : undefined)).run(); }
  listExports() { const values = this.db.select().from(audioExports).all(); return this.ownerId ? values.filter(e => !!this.getTrack(e.trackId)) : values; }
  getExport(id: string) { const value = this.db.select().from(audioExports).where(eq(audioExports.id, id)).get(); return value && (!this.ownerId || this.getTrack(value.trackId)) ? value : undefined; }
  addExport(value: typeof audioExports.$inferInsert) { if (this.ownerId && !this.getTrack(value.trackId)) throw new Error('作品不存在'); this.db.insert(audioExports).values(value).onConflictDoNothing().run(); }
  updateExport(id: string, patch: Partial<StoredExport>) { this.db.update(audioExports).set(patch).where(eq(audioExports.id, id)).run(); }
  publicExports(): AudioExport[] { return this.listExports().map(({ id, trackId, format, status, error, duration }) => ({ id, trackId, format, status, error, duration, downloadUrl: status === 'saved' ? `/api/exports/${id}/download` : null })); }
  storageFiles(): string[] { return [...new Set([
    ...this.listJobs().flatMap(j => (j.result?.scoreFiles || []).map(scoreFilename)),
    ...this.listTracks().flatMap(t => [t.sourceFile, t.localFile, t.lyricsFile, t.timedLyricsFile]),
    ...this.listMaterials().flatMap(t => [t.originalFile, t.previewFile]),
    ...this.listExports().flatMap(t => [t.sourceFile, t.localFile, t.lyricsFile, t.timedLyricsFile]),
  ].filter((file): file is string => !!file))]; }
  publicTracks(): Track[] {
    const byJob = new Map(this.listJobs().map(j => [j.id, j]));
    const exports = this.publicExports();
    return this.listTracks().map(({ url: _url, flacUrl, wavUrl, localFile, contentType: _contentType,
      sourceFile: _sourceFile, sourceDuration: _sourceDuration, processingVersion: _processingVersion, checksum: _checksum, lyricsFile, timedLyricsFile, ...track }) => ({
      ...track, playbackUrl: localFile && track.saveStatus === 'saved' ? `/media/${track.id}?v=${_processingVersion}` : null,
      hasFlac: !!flacUrl || !!localFile?.endsWith('.flac') || track.origin === 'uploaded' && !!_sourceFile?.endsWith('.flac'), hasWav: !!wavUrl || !!localFile?.endsWith('.wav') || track.origin === 'uploaded' && !!_sourceFile?.endsWith('.wav'), input: byJob.get(track.jobId)!.input,
      originalUrl: track.origin === 'uploaded' && _sourceFile ? `/api/tracks/${track.id}/original` : null,
      exports: exports.filter(e => e.trackId === track.id),
      lyricsUrl: lyricsFile ? `/api/tracks/${track.id}/lyrics` : null,
      timedLyricsUrl: timedLyricsFile ? `/api/tracks/${track.id}/lyrics?format=lrc` : null,
    }));
  }
  saveDraft(input: CreativeInput) {
    this.db.insert(drafts).values({ ownerId: this.ownerId || LEGACY_USER_ID, mode: input.mode, input, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: [drafts.ownerId, drafts.mode], set: { input, updatedAt: Date.now() } }).run();
  }
  listDrafts() { return this.db.select().from(drafts).where(this.ownerId ? eq(drafts.ownerId, this.ownerId) : undefined).all(); }
  async backupForUser(destination: string) {
    if (!this.ownerId) throw new Error('备份必须属于一名用户');
    await this.sqlite.backup(destination);
    const copy = new Database(destination);
    try {
      copy.pragma('foreign_keys = OFF'); copy.pragma('secure_delete = ON');
      copy.transaction(() => {
        for (const table of ['generation_jobs','tracks','materials','collections','drafts']) copy.prepare(`DELETE FROM ${table} WHERE owner_id <> ?`).run(this.ownerId);
        copy.exec('DELETE FROM audio_exports WHERE track_id NOT IN (SELECT id FROM tracks); DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_audit; DELETE FROM registrations; DELETE FROM credit_wallets; DELETE FROM credit_charges; DELETE FROM credit_ledger; DELETE FROM users;');
      })();
      // Deleted pages must not retain another user's content or password hashes.
      copy.exec('VACUUM'); copy.pragma('wal_checkpoint(TRUNCATE)');
    } finally { copy.close(); }
  }
  recover() {
    this.db.update(audioExports).set({ status: 'save_failed', error: '上次保存被中断，可重新保存。' }).where(eq(audioExports.status, 'saving')).run();
    this.db.update(jobs).set({ status: 'local_queued', error: null }).where(eq(jobs.status, 'preparing_source')).run();
    this.db.update(jobs).set({ status: 'submission_unknown', error: '上次提交时服务中断，结果待核实。请检查 Mureka 账户后再决定是否重新生成。', updatedAt: Date.now() })
      .where(eq(jobs.status, 'submitting')).run();
    this.db.update(tracks).set({ saveStatus: 'save_failed', saveError: '上次保存被中断，请重新保存。' }).where(eq(tracks.saveStatus, 'saving')).run();
  }
  close() { this.sqlite.close(); }
}
