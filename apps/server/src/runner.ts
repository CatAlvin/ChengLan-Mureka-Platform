import { randomUUID } from 'node:crypto';
import { stat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { terminalStatuses, toolRangeError, type Account, type Job, type LyricsResult } from '../../../packages/shared/src/index.js';
import { Store } from './db.js';
import { ProviderError, type MusicProvider, type SongTask } from './provider.js';
import { downloadMedia, downloadArchive, type Downloader } from './media.js';
import { prepareToolAudio, stemEntries, stemLabel, saveStemWav, cropAudio, cropLyrics, regionResultError } from './creative-audio.js';
import { AUDIO_PROCESSING_VERSION, trimAudioEnd, saveLyrics, lyricsText, lrcText, type AudioProcessor } from './postprocess.js';
import { prepareSource } from './materials.js';
import { scoreEntries, saveScoreEntries } from './score-files.js';
import { Credits } from './credits.js';
import type { StoredJob } from './db.js';

export class Runner {
  readonly credits: Credits;
  account: Account;
  private billingRequest: Promise<Account> | null = null;
  private busy = false;
  private formatBusy = false;
  private cropBusy = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private saves = new Map<string, Promise<void>>();
  private lyricUpdates = new Set<string>();
  constructor(readonly store: Store, readonly provider: MusicProvider, readonly storageDir: string, readonly downloader: Downloader = downloadMedia, readonly processor: AudioProcessor = trimAudioEnd, readonly archiveDownloader: Downloader = downloadArchive) {
    this.credits = new Credits(store);
    this.account = { connected: false, configured: provider.configured, balance: null, totalSpending: null, concurrency: 1, checkedAt: null, error: null };
  }
  refreshAccount(force = false): Promise<Account> {
    if (this.billingRequest) return this.billingRequest;
    if (!force && this.account.checkedAt && Date.now() - this.account.checkedAt < 60000) return Promise.resolve(this.account);
    this.billingRequest = (async () => {
      try {
        const billing = await this.provider.billing();
        this.account = { connected: true, configured: this.provider.configured, balance: billing.balance, totalSpending: billing.total_spending, concurrency: Math.max(1, billing.concurrent_request_limit), checkedAt: Date.now(), error: null };
      } catch (error) {
        this.account = { ...this.account, connected: false, checkedAt: Date.now(), error: error instanceof ProviderError ? error.message : '无法读取账户，请检查网络后重新检测。' };
      } finally { this.billingRequest = null; }
      return this.account;
    })();
    return this.billingRequest;
  }
  start() {
    this.store.recover();
    for (const job of this.store.listJobs()) if (job.status === 'submission_unknown') this.credits.review(job.id, '服务中断后的提交结果待核实');
    for (const track of this.store.listTracks()) {
      if (!track.deletedAt && (track.saveStatus !== 'saved' || track.processingVersion < AUDIO_PROCESSING_VERSION || (track.lyrics && !track.lyricsFile))) void this.saveTrack(track.id);
      else { this.checkRegionResult(track.id); this.queueFormats(track.id); }
    }
    for (const output of this.store.listExports()) if (output.status === 'save_failed' && !this.store.getTrack(output.trackId)?.deletedAt) this.store.updateExport(output.id, { status: 'saving', error: null });
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 2000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.busy || this.formatBusy) await new Promise(resolve => setTimeout(resolve, 30));
    await Promise.allSettled(this.saves.values());
  }
  private async accept(job: Job, task: SongTask) {
    if (job.providerId && job.providerId !== task.id) throw new Error('任务编号不匹配，稍后重新查询。');
    const error = ['failed', 'timeouted', 'cancelled'].includes(task.status)
      ? (task.status === 'timeouted' ? 'Mureka 生成超时，原始输入已保留。' : task.status === 'cancelled' ? '此任务已被上游取消。' : '这次生成未成功，原始输入已保留，可调整后再试。') : null;
    // Results and completion are committed together, so a crash cannot lose successful outputs.
    this.store.sqlite.transaction(() => {
      if (task.status === 'succeeded') {
        if (!task.choices?.length) throw new Error('任务已完成但尚未返回作品，稍后继续查询。');
        task.choices.forEach((choice, index) => {
          // Preserve supplied lyrics even if the provider omits its transcript, clearly
          // labeling them as a reference instead of presenting a partial verse as the song.
          const tool = job.tool;
          const reference = tool?.operation === 'track' ? (tool.generateType === 'Vocals' ? tool.lyrics : '') : tool?.operation === 'remix' ? (tool.lyrics ? `歌词参考（以实际演唱为准）\n\n${tool.lyrics}` : '') : tool && (tool.operation === 'extend' || tool.operation === 'region_edit')
            ? `歌词参考（以实际演唱为准）\n\n[原作品歌词]\n${this.store.getTrack(tool.sourceTrackId)?.lyrics || '纯音乐或暂无歌词'}\n\n[${tool.operation === 'extend' ? '续写歌词' : '局部重唱歌词'}]\n${tool.lyrics}`
            : job.input.lyrics;
          const lyrics = tool?.operation === 'track' && tool.generateType !== 'Vocals' ? '' : lyricsText(choice.lyrics_sections, reference);
          const baseTitle = job.input.title.trim() || job.input.prompt.trim().slice(0, 22) || '我的新作品';
          this.store.addTrack({
            id: randomUUID(), ownerId: this.store.getJob(job.id)!.ownerId, jobId: job.id, providerId: choice.id,
            title: baseTitle + (task.choices!.length > 1 ? ` · 版本 ${index + 1}` : ''),
            mode: job.input.mode, duration: choice.duration ?? 0, model: task.model || 'auto', lyrics,
            lyricsSections: tool?.operation === 'track' && tool.generateType !== 'Vocals' ? null : choice.lyrics_sections ?? null, createdAt: Date.now(), saveStatus: 'saving',
            url: choice.url, flacUrl: choice.flac_url || null, wavUrl: choice.wav_url || null, watermarked: task.watermarked ?? false,
            parentTrackId: job.tool?.sourceTrackId ?? null, operation: job.tool?.operation === 'track' || job.tool?.operation === 'extend' || job.tool?.operation === 'region_edit' || job.tool?.operation === 'remix' ? job.tool.operation : null,
            collectionId: job.tool ? this.store.getTrack(job.tool.sourceTrackId)?.collectionId ?? null : job.input.collectionId ?? null,
          });
        });
      }
      this.store.updateJob(job.id, { providerId: task.id, status: task.status, error, traceId: task.trace_id || null, pollAfter: Date.now() + 5000 });
      if (terminalStatuses.includes(task.status)) this.credits.complete(job.id, task);
    })();
    if (task.status === 'succeeded') {
      for (const track of this.store.listTracks().filter(t => t.jobId === job.id && t.saveStatus !== 'saved')) void this.saveTrack(track.id);
      this.account.checkedAt = null;
    }
  }
  private completePaid(id: string, patch: Partial<StoredJob>) {
    this.store.sqlite.transaction(() => { this.store.updateJob(id, patch); this.credits.complete(id); })();
  }
  private rejectUnpaid(id: string, error: string, status: 'failed' | 'cancelled' = 'failed') {
    this.store.sqlite.transaction(() => { this.credits.release(id); this.store.updateJob(id, { status, error }); })();
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      void this.savePendingFormat().catch(() => {});
      const crop = this.store.listJobs().filter(j => j.kind === 'crop' && j.status === 'local_queued').sort((a, b) => a.createdAt - b.createdAt)[0];
      if (crop) void this.saveCrop(crop.id);
      for (const job of this.store.listJobs()) {
        if (job.kind === 'crop') continue;
        if (job.kind === 'stem' && job.status === 'saving') { void this.saveStems(job.id); continue; }
        if (job.kind === 'transcribe' && job.status === 'saving') { void this.saveScore(job.id); continue; }
        if (!job.providerId || terminalStatuses.includes(job.status) || job.pollAfter > Date.now()) continue;
        try { await this.accept(job, await this.provider.query(job.providerId, job.kind)); }
        catch (error) { this.store.updateJob(job.id, { error: error instanceof ProviderError ? error.message : '暂时无法更新任务状态，稍后自动重试。', pollAfter: Date.now() + 15000 }); }
      }
      const list = this.store.listJobs();
      // Local editing remains available without an API key, balance or cloud slots.
      const queued = list.filter(j => j.kind !== 'crop' && j.status === 'local_queued').sort((a, b) => a.createdAt - b.createdAt);
      if (!queued.length) return;
      const account = await this.refreshAccount();
      if (!account.connected || account.balance === null || account.balance <= 0) return;
      const active = list.filter(j => j.kind !== 'crop' && !terminalStatuses.includes(j.status) && !['local_queued', 'saving'].includes(j.status)).length;
      if (active >= account.concurrency) return;
      const job = queued[0];
      const ownerDisabled = () => !!(this.store.sqlite.prepare('SELECT disabled FROM users WHERE id=?').get(job.ownerId) as { disabled: number } | undefined)?.disabled;
      if (ownerDisabled()) { this.rejectUnpaid(job.id, '账户已停用。', 'cancelled'); return; }
      // Claim before crossing the network boundary. An interrupted claim is never blindly retried.
      this.store.updateJob(job.id, { status: job.tool && job.kind !== 'lyrics_extend' || job.input.source && job.kind !== 'lyrics' ? 'preparing_source' : 'submitting', error: null });
      try {
        if (job.tool && job.tool.operation !== 'crop') {
          const source = this.store.getTrack(job.tool.sourceTrackId);
          if (!source || source.ownerId !== job.ownerId || source.deletedAt || !source.localFile || source.saveStatus !== 'saved') throw new ProviderError('原作品尚未保存完整或已移入回收站，请恢复后再试。', 400);
          const rangeError = toolRangeError(job.tool, source.duration);
          if (rangeError) { this.rejectUnpaid(job.id, rangeError); return; }
          if (job.tool.operation === 'lyrics_extend') {
            const result = await this.provider.extendLyrics(job.tool.lyrics);
            this.completePaid(job.id, { status: 'succeeded', result });
          } else {
            const data = await prepareToolAudio(this.storageDir, source.origin === 'uploaded' ? source.sourceFile || source.localFile : source.localFile, source.duration);
            if (job.tool.operation === 'describe') {
              if (ownerDisabled()) throw new ProviderError('账户已停用。', 403);
              this.store.updateJob(job.id, { status: 'submitting' });
              const result = await this.provider.describe(data);
              this.completePaid(job.id, { status: 'succeeded', result: { title: source.title, lyrics: '', description: result.description, instruments: result.instrument, genres: result.genres, tags: result.tags } });
            } else if (job.tool.operation === 'stem') {
              if (ownerDisabled()) throw new ProviderError('账户已停用。', 403);
              this.store.updateJob(job.id, { status: 'submitting' });
              const archives = await this.provider.separate(data, job.tool.preset);
              this.completePaid(job.id, { artifactUrl: typeof archives === 'string' ? archives : JSON.stringify(archives), status: 'saving' });
              void this.saveStems(job.id);
            } else {
              const uploadId = await this.provider.uploadAudio(data, job.tool.operation === 'remix' ? 'remix' : 'audio');
              if (ownerDisabled()) throw new ProviderError('账户已停用。', 403);
              this.store.updateJob(job.id, { status: 'submitting' });
              if (job.tool.operation === 'transcribe') {
                const artifactUrl = await this.provider.transcribe(uploadId, job.tool.title || source.title);
                this.completePaid(job.id, { artifactUrl, status: 'saving' });
                void this.saveScore(job.id);
              } else if (job.tool.operation === 'recognize') {
                const result = await this.provider.recognize(uploadId);
                this.completePaid(job.id, { status: 'succeeded', result: { title: source.title, lyrics: lyricsText(result.lyrics_sections, ''), lyricsSections: result.lyrics_sections, duration: result.duration, timedLyrics: lrcText(result.lyrics_sections, source.duration) } });
              } else {
                const task = await this.provider.createVersion(job.tool, uploadId);
                this.store.updateJob(job.id, { providerId: task.id, status: task.status === 'succeeded' ? 'running' : task.status });
                await this.accept(job, task);
              }
            }
          }
          this.account.checkedAt = null;
        } else if (job.kind === 'lyrics') {
          const result = await this.provider.lyrics(`${job.input.prompt}\n语言：${job.input.language}；风格：${job.input.styles.join('、')}；情绪：${job.input.mood}`);
          this.completePaid(job.id, { status: 'succeeded', result });
          this.account.checkedAt = null;
        } else {
          let uploadId: string | undefined;
          if (job.input.source) {
            const data = await prepareSource(this.store, job.input, this.storageDir);
            uploadId = await this.provider.uploadAudio(data, job.input.mode === 'instrumental' ? 'instrumental' : job.input.source.kind);
            if (ownerDisabled()) throw new ProviderError('账户已停用。', 403);
            this.store.updateJob(job.id, { status: 'submitting' });
          }
          const task = await this.provider.submit(job.input, uploadId);
          // Persist the provider ID before processing even an immediately completed response.
          this.store.updateJob(job.id, { providerId: task.id, status: task.status === 'succeeded' ? 'running' : task.status });
          await this.accept(job, task);
        }
      } catch (error) {
        const current = this.store.getJob(job.id)!;
        if (current.providerId) {
          this.store.updateJob(job.id, { status: 'running', error: '已提交成功，正在恢复结果查询。', pollAfter: Date.now() + 5000 });
        } else {
          const preparationFailed = current.status === 'preparing_source';
          const knownRejection = preparationFailed || error instanceof ProviderError && !error.ambiguous;
          this.store.sqlite.transaction(() => {
            if (knownRejection) this.credits.release(job.id); else this.credits.review(job.id);
            this.store.updateJob(job.id, { status: knownRejection ? 'failed' : 'submission_unknown',
              error: preparationFailed ? '素材未准备完成，本次未发起创作。请检查网络和本机音频工具后再试。' : error instanceof ProviderError ? error.message : '提交结果待核实，请检查 Mureka 账户后再操作。', traceId: error instanceof ProviderError ? error.traceId : null });
          })();
        }
      }
    } finally { this.busy = false; }
  }
  saveCrop(id: string): Promise<void> {
    if (this.saves.has(id)) return this.saves.get(id)!;
    if (this.cropBusy || this.stopped) return Promise.resolve();
    const job = this.store.getJob(id);
    if (!job || job.kind !== 'crop' || job.tool?.operation !== 'crop' || !['local_queued', 'preparing_source', 'save_failed'].includes(job.status)) return Promise.resolve();
    const tool = job.tool;
    const disabled = () => !!(this.store.sqlite.prepare('SELECT disabled FROM users WHERE id=?').get(job.ownerId) as { disabled: number } | undefined)?.disabled;
    if (disabled()) { this.store.updateJob(id, { status: 'cancelled', error: '账户已停用。' }); return Promise.resolve(); }
    this.cropBusy = true;
    this.store.updateJob(id, { status: 'preparing_source', error: null });
    const files: string[] = [];
    const work = (async () => {
      try {
        const source = this.store.getTrack(tool.sourceTrackId);
        if (!source || source.ownerId !== job.ownerId || source.deletedAt || source.saveStatus !== 'saved' || !source.localFile) throw new Error('原作品不可用');
        // Generated sourceFile contains the unprocessed AI tail. Crop only its
        // saved playback/native exports; user uploads retain their full original.
        const native = new Map<'wav' | 'flac', string>();
        for (const format of ['wav', 'flac'] as const) {
          const original = source.origin === 'uploaded' && path.extname(source.sourceFile || '') === `.${format}` ? source.sourceFile : null;
          const saved = path.extname(source.localFile) === `.${format}` ? source.localFile : this.store.listExports().find(output => output.trackId === source.id && output.format === format && output.status === 'saved')?.localFile;
          if (original || saved) native.set(format, (original || saved)!);
        }
        const bestSource = native.get('wav') || native.get('flac') || (source.origin === 'uploaded' ? source.sourceFile : null) || source.localFile;
        const audio = await cropAudio(this.storageDir, bestSource, id, tool.start, tool.end, 'mp3');
        files.push(audio.filename);
        const clipped = cropLyrics(source.lyricsSections, source.lyrics, tool.start, tool.end, source.duration);
        const lyrics = await saveLyrics(this.storageDir, audio.filename, clipped.lyrics, clipped.sections, audio.duration);
        files.push(...[lyrics.lyricsFile, lyrics.timedLyricsFile].filter((file): file is string => !!file));
        const outputs: { id: string; format: 'wav' | 'flac'; localFile: string; duration: number }[] = [];
        for (const [format, filename] of native) {
          const output = await cropAudio(this.storageDir, filename, id, tool.start, tool.end, format);
          files.push(output.filename);
          outputs.push({ id: randomUUID(), format, localFile: output.filename, duration: output.duration });
        }
        if (disabled() || this.store.getTrack(source.id)?.deletedAt) throw new Error('原作品或账户已不可用');
        this.store.sqlite.transaction(() => {
          this.store.addTrack({ id, ownerId: source.ownerId, jobId: id, providerId: `crop:${id}`, title: job.input.title,
            mode: source.mode, duration: audio.duration, model: '本地裁剪', lyrics: lyrics.lyrics, lyricsSections: clipped.sections,
            createdAt: Date.now(), saveStatus: 'saved', url: '', contentType: 'audio/mpeg', localFile: audio.filename,
            sourceFile: native.get('wav') ? `${id}.wav` : native.get('flac') ? `${id}.flac` : audio.filename,
            sourceDuration: audio.duration, processingVersion: AUDIO_PROCESSING_VERSION, watermarked: source.watermarked,
            parentTrackId: source.id, operation: 'crop', collectionId: source.collectionId, origin: source.origin,
            lyricsFile: lyrics.lyricsFile, timedLyricsFile: lyrics.timedLyricsFile });
          for (const output of outputs) this.store.addExport({ ...output, trackId: id, status: 'saved', lyricsFile: lyrics.lyricsFile, timedLyricsFile: lyrics.timedLyricsFile });
          this.store.updateJob(id, { status: 'succeeded', error: null });
        })();
      } catch {
        for (const filename of files) await unlink(path.join(this.storageDir, filename)).catch(() => {});
        this.store.updateJob(id, { status: 'save_failed', error: '裁剪未完成。请确认原作品可用后重试；原曲保持完整，重试不会产生创作费用。' });
      } finally { this.cropBusy = false; this.saves.delete(id); }
    })();
    this.saves.set(id, work); return work;
  }
  saveStems(id: string): Promise<void> {
    if (this.saves.has(id)) return this.saves.get(id)!;
    const job = this.store.getJob(id);
    if (!job?.artifactUrl || job.kind !== 'stem' || !job.tool || job.status === 'succeeded') return Promise.resolve();
    const source = this.store.getTrack(job.tool.sourceTrackId);
    if (!source) return Promise.resolve();
    this.store.updateJob(id, { status: 'saving', error: null });
    const work = (async () => {
      let archive: string | undefined;
      try {
        const archives: { audio: string; midi?: string } = job.artifactUrl!.startsWith('{') ? JSON.parse(job.artifactUrl!) : { audio: job.artifactUrl! };
        const downloaded = await this.archiveDownloader(archives.audio, this.storageDir, id);
        archive = downloaded.filename;
        const entries = stemEntries(await readFile(path.join(this.storageDir, archive)));
        for (const [name, bytes] of entries) {
          // Stable per-entry identity makes partial download recovery idempotent.
          let track = this.store.listTracks().find(t => t.jobId === id && t.providerId === name);
          if (track?.saveStatus === 'saved') continue;
          const stem = stemLabel(name); const trackId = track?.id || randomUUID();
          const saved = await saveStemWav(bytes, this.storageDir, trackId);
          if (!track) {
            this.store.addTrack({ id: trackId, ownerId: source.ownerId, jobId: id, providerId: name, title: `${(job.tool!.title || source.title).slice(0, 60)} · ${stem.label}`.slice(0, 80),
              mode: stem.vocal ? 'lyrics' : 'instrumental', duration: saved.duration, model: job.tool!.operation === 'stem' && job.tool!.preset === 'vocals' ? 'audio-separation-3' : job.tool!.operation === 'stem' && job.tool!.preset === 'detailed' ? 'audio-separation-2' : 'audio-separation-1',
              lyrics: stem.vocal ? source.lyrics : '', lyricsSections: stem.vocal ? source.lyricsSections : null,
              createdAt: Date.now(), saveStatus: 'saving', url: '', contentType: 'audio/wav', localFile: saved.filename,
              sourceDuration: saved.duration, processingVersion: AUDIO_PROCESSING_VERSION, parentTrackId: source.id, operation: 'stem', stemName: stem.label, collectionId: source.collectionId });
          } else this.store.updateTrack(trackId, { localFile: saved.filename, duration: saved.duration });
          // The submitted source was already processed. Stems retain its full timeline.
          track = this.store.getTrack(trackId)!;
          const lyrics = await saveLyrics(this.storageDir, saved.filename, track.lyrics, track.lyricsSections, saved.duration);
          this.store.updateTrack(trackId, { ...lyrics, saveStatus: 'saved', saveError: null });
          this.queueFormats(trackId);
        }
        let scoreFiles = job.result?.scoreFiles || [];
        if (archives.midi && !scoreFiles.length) {
          await unlink(path.join(this.storageDir, archive)); archive = undefined;
          const midi = await this.archiveDownloader(archives.midi, this.storageDir, id);
          archive = midi.filename;
          scoreFiles = await saveScoreEntries(scoreEntries(await readFile(path.join(this.storageDir, archive)), true), this.storageDir, id);
        }
        this.store.updateJob(id, { status: 'succeeded', error: null, result: { title: job.input.title, lyrics: '', scoreFiles } });
      } catch {
        this.store.updateJob(id, { status: 'save_failed', error: '分轨已生成，但本机保存未完成。可重新保存，不会再次分轨；若下载链接已过期，请到 Mureka 账户核对。' });
      } finally { if (archive) await unlink(path.join(this.storageDir, archive)).catch(() => {}); this.saves.delete(id); }
    })();
    this.saves.set(id, work); return work;
  }
  saveScore(id: string): Promise<void> {
    if (this.saves.has(id)) return this.saves.get(id)!;
    const job = this.store.getJob(id);
    if (!job?.artifactUrl || job.kind !== 'transcribe' || job.status === 'succeeded') return Promise.resolve();
    this.store.updateJob(id, { status: 'saving', error: null });
    const work = (async () => {
      let archive: string | undefined;
      try {
        const downloaded = await this.archiveDownloader(job.artifactUrl!, this.storageDir, id);
        archive = downloaded.filename;
        const files = await saveScoreEntries(scoreEntries(await readFile(path.join(this.storageDir, archive))), this.storageDir, id);
        this.store.updateJob(id, { status: 'succeeded', error: null, result: { title: job.input.title, lyrics: '', scoreFiles: files } });
      } catch {
        this.store.updateJob(id, { status: 'save_failed', error: '乐谱已生成，但文件保存未完成。可重新保存已有结果；若链接过期，请联系管理员核对。' });
      } finally { if (archive) await unlink(path.join(this.storageDir, archive)).catch(() => {}); this.saves.delete(id); }
    })();
    this.saves.set(id, work); return work;
  }
  saveTrack(id: string): Promise<void> {
    if (this.saves.has(id)) return this.saves.get(id)!;
    const track = this.store.getTrack(id);
    if (!track || track.deletedAt) return Promise.resolve();
    if (track.saveStatus === 'saved' && track.processingVersion >= AUDIO_PROCESSING_VERSION && (!track.lyrics || track.lyricsFile)) {
      this.checkRegionResult(id); this.queueFormats(id); return Promise.resolve();
    }
    this.store.updateTrack(id, { saveStatus: 'saving', saveError: null });
    const work = (async () => {
      let phase: 'download' | 'audio' | 'lyrics' = 'download';
      try {
        let current = track;
        if (current.processingVersion < AUDIO_PROCESSING_VERSION) {
          let source = current.sourceFile || current.localFile;
          if (!source) {
            const result = await this.downloader(current.url, this.storageDir, id);
            source = result.filename;
            this.store.updateTrack(id, { contentType: result.contentType });
          }
          // Persist the immutable source before processing; retrying cannot trim a processed file.
          this.store.updateTrack(id, { sourceFile: source });
          phase = 'audio';
          const result = await this.processor(source, this.storageDir, id);
          this.store.updateTrack(id, { sourceDuration: result.sourceDuration, duration: result.duration, localFile: result.filename, processingVersion: AUDIO_PROCESSING_VERSION });
          current = this.store.getTrack(id)!;
        }
        if (!current.localFile) throw new Error('缺少已保存的音频');
        phase = 'lyrics';
        const lyrics = await saveLyrics(this.storageDir, current.localFile, current.lyrics, current.lyricsSections, current.duration);
        this.store.sqlite.transaction(() => {
          this.store.updateTrack(id, { ...lyrics, saveStatus: 'saved', saveError: null });
          this.checkRegionResult(id);
        })();
        this.queueFormats(id);
      } catch (error) {
        // Do not log upstream URLs, response bodies, credentials or command lines.
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        console.warn(JSON.stringify({ event: 'track_save_failed', trackId: id, phase, code: typeof code === 'number' || typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code) ? code : 'SAVE_ERROR' }));
        const stage = { download: '音频下载', audio: '音频处理', lyrics: '歌词保存' }[phase];
        this.store.updateTrack(id, { saveStatus: 'save_failed', saveError: `音乐已生成，但${stage}未完成。可重新保存，已有结果会保留。` });
      } finally { this.saves.delete(id); }
    })();
    this.saves.set(id, work);
    return work;
  }
  private checkRegionResult(id: string) {
    const track = this.store.getTrack(id);
    if (!track || track.operation !== 'region_edit' || track.saveStatus !== 'saved') return;
    const job = this.store.getJob(track.jobId);
    const source = job?.tool && this.store.getTrack(job.tool.sourceTrackId);
    if (!job?.tool || !source) return;
    const error = regionResultError(job.tool, source.duration, track.duration);
    if (error && job.error !== error) this.store.updateJob(job.id, { status: 'failed', error });
  }
  async storageBytes(store = this.store) {
    const files = store.storageFiles();
    const sizes = await Promise.all([...files].map(file => stat(path.join(this.storageDir, file)).then(s => s.size).catch(() => 0)));
    return sizes.reduce((sum, size) => sum + size, 0);
  }
  async adoptLyrics(trackId: string, result: LyricsResult) {
    if (this.lyricUpdates.has(trackId)) throw Object.assign(new Error('歌词正在保存，请稍后重试。'), { statusCode: 409 });
    this.lyricUpdates.add(trackId);
    try {
      const outputs = this.store.listExports().filter(output => output.trackId === trackId);
      await Promise.all([trackId, ...outputs.map(output => output.id)].map(id => this.saves.get(id)));
      const track = this.store.getTrack(trackId);
      if (!track || track.deletedAt || track.saveStatus !== 'saved' || !track.localFile) throw Object.assign(new Error('请先恢复并保存原作品。'), { statusCode: 409 });
      const sections = result.lyricsSections ?? null;
      const lyrics = await saveLyrics(this.storageDir, track.localFile, result.lyrics, sections, track.duration);
      const savedExports: { id: string; files: Awaited<ReturnType<typeof saveLyrics>> }[] = [];
      for (const output of this.store.listExports().filter(output => output.trackId === trackId && output.status === 'saved' && output.localFile)) {
        savedExports.push({ id: output.id, files: await saveLyrics(this.storageDir, output.localFile!, result.lyrics, sections, output.duration) });
      }
      this.store.sqlite.transaction(() => {
        this.store.updateTrack(trackId, { ...lyrics, lyricsSections: sections });
        for (const output of savedExports) this.store.updateExport(output.id, { lyricsFile: output.files.lyricsFile, timedLyricsFile: output.files.timedLyricsFile });
      })();
    } finally { this.lyricUpdates.delete(trackId); }
  }
  private queueFormats(trackId: string) {
    const track = this.store.getTrack(trackId);
    if (!track || track.deletedAt || track.saveStatus !== 'saved' || track.processingVersion < AUDIO_PROCESSING_VERSION) return;
    const outputs = this.store.listExports().filter(output => output.trackId === trackId);
    for (const format of ['wav', 'flac'] as const) {
      const available = (format === 'wav' ? track.wavUrl : track.flacUrl) || path.extname(track.localFile || '') === `.${format}` || track.origin === 'uploaded' && path.extname(track.sourceFile || '') === `.${format}`;
      if (available && !outputs.some(output => output.format === format)) this.store.addExport({ id: randomUUID(), trackId, format, status: 'saving' });
    }
  }
  async savePendingFormat() {
    if (this.stopped || this.formatBusy) return;
    const output = this.store.listExports().find(output => {
      const track = this.store.getTrack(output.trackId);
      return output.status === 'saving' && track?.saveStatus === 'saved' && !track.deletedAt && !this.lyricUpdates.has(output.trackId);
    });
    if (!output) return;
    // Large original files are saved one at a time; MP3 playback is already available.
    // The database queue survives restarts, and failed formats wait for an explicit retry.
    this.formatBusy = true;
    try { await this.saveFormat(output.id); } finally { this.formatBusy = false; }
  }
  saveFormat(id: string): Promise<void> {
    if (this.saves.has(id)) return this.saves.get(id)!;
    const output = this.store.getExport(id); if (!output || output.status === 'saved') return Promise.resolve();
    const track = this.store.getTrack(output.trackId); if (!track || track.deletedAt) return Promise.resolve();
    if (this.lyricUpdates.has(track.id)) return Promise.resolve();
    this.store.updateExport(id, { status: 'saving', error: null });
    const work = (async () => {
      try {
        let filename = output.localFile; let duration = output.duration;
        if (!filename) {
          if (track.origin === 'uploaded' && path.extname(track.sourceFile || '') === `.${output.format}`) {
            filename = track.sourceFile!; duration = track.sourceDuration || track.duration;
          } else if (track.saveStatus === 'saved' && path.extname(track.localFile || '') === `.${output.format}`) {
            filename = track.localFile!; duration = track.duration;
          } else {
            let source = output.sourceFile;
            if (!source) {
              const url = output.format === 'flac' ? track.flacUrl : track.wavUrl; if (!url) throw new Error('没有对应格式的下载地址');
              const downloaded = await this.downloader(url, this.storageDir, id); source = downloaded.filename;
              this.store.updateExport(id, { sourceFile: source });
            }
            const bytes = await readFile(path.join(this.storageDir, source));
            const valid = output.format === 'flac' ? bytes.subarray(0, 4).toString() === 'fLaC' : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE';
            if (!valid || path.extname(source) !== `.${output.format}`) {
              // A retry must fetch fresh bytes after an invalid upstream response.
              await unlink(path.join(this.storageDir, source));
              this.store.updateExport(id, { sourceFile: null });
              throw new Error('上游未提供请求的无损格式');
            }
            const processed = await this.processor(source, this.storageDir, id); filename = processed.filename; duration = processed.duration;
          }
          this.store.updateExport(id, { localFile: filename, duration });
        }
        const lyrics = await saveLyrics(this.storageDir, filename, track.lyrics, track.lyricsSections, duration);
        this.store.updateExport(id, { lyricsFile: lyrics.lyricsFile, timedLyricsFile: lyrics.timedLyricsFile, status: 'saved', error: null });
      } catch {
        this.store.updateExport(id, { status: 'save_failed', error: '此格式暂未保存完成。请检查网络与磁盘后重试；下载地址过期时需到 Mureka 核对。原作品仍可播放。' });
      } finally { this.saves.delete(id); }
    })(); this.saves.set(id, work); return work;
  }
}
