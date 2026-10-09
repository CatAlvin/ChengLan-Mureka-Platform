import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, rmdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { audioDuration, trimAudioEnd, saveLyrics, lrcText } from '../apps/server/src/postprocess.js';
import { buildApp } from '../apps/server/src/app.js';
import { FakeProvider, fakeDownload, sampleJob, testWav } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function directory() {
  const folder = await mkdtemp(path.join(tmpdir(), 'chenglan-audio-'));
  cleanup.push(() => rm(folder, { force: true, recursive: true }));
  return folder;
}
const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

describe('audio and lyric postprocessing', () => {
  it.each([44100, 48000])('measures %i Hz MP3 by playable samples, independent of encoder progress timestamps', async rate => {
    const folder = await directory(); const id = randomUUID(); const source = `${id}.mp3`;
    const execute = promisify(execFile); const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=8.137`, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '256k', path.join(folder, source)], { windowsHide: true });
    const pcm = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path.join(folder, source), '-f', 's16le', '-ar', String(rate), '-ac', '2', 'pipe:1'], { windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    const measured = Math.round(pcm.stdout.byteLength / (2 * 2 * rate) * 1000);
    expect(await audioDuration(path.join(folder, source))).toBe(measured);
    const result = await trimAudioEnd(source, folder, id);
    expect(result.sourceDuration - result.duration).toBe(5000);
  });
  it.each(['wav', 'mp3', 'flac', 'm4a'])('removes five seconds from %s and preserves the immutable source', async extension => {
    const folder = await directory(); const id = randomUUID();
    await writeFile(path.join(folder, 'fixture.wav'), testWav());
    const source = `${id}.${extension}`;
    await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-i', path.join(folder, 'fixture.wav'), path.join(folder, source)], { windowsHide: true });
    const before = digest(await readFile(path.join(folder, source)));
    const processed = await trimAudioEnd(source, folder, id);
    expect(processed.sourceDuration - processed.duration).toBeCloseTo(5000, -2);
    expect(digest(await readFile(path.join(folder, source)))).toBe(before);
    expect(processed.filename).not.toBe(source);
    expect(await audioDuration(path.join(folder, processed.filename))).toBe(processed.duration);
  });
  it('keeps a very short clip playable', async () => {
    const folder = await directory(); const id = randomUUID();
    await writeFile(path.join(folder, 'long.wav'), testWav());
    await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-i', path.join(folder, 'long.wav'), '-t', '2', path.join(folder, 'short.wav')], { windowsHide: true });
    const processed = await trimAudioEnd('short.wav', folder, id);
    expect(processed.duration).toBe(2000);
  });
  it('writes UTF-8 text and clips timed lyrics to the saved audio without inventing timestamps', async () => {
    const folder = await directory();
    const sections = [{ lines: [{ text: '第二句', start: 2020 }, { text: '第一句', start: 0 }, { text: '已移除尾部', start: 7000 }] }];
    expect(lrcText(sections, 3000)).toBe('[00:00.00]第一句\n[00:02.02]第二句');
    const files = await saveLyrics(folder, 'song.mp3', '', sections, 3000);
    expect((await readFile(path.join(folder, files.lyricsFile!), 'utf8')).startsWith('\ufeff')).toBe(true);
    expect(await readFile(path.join(folder, files.timedLyricsFile!), 'utf8')).not.toContain('已移除尾部');
    expect((await saveLyrics(folder, 'untimed.mp3', '没有时间轴的歌词', null, 3000)).timedLyricsFile).toBeNull();
    expect((await saveLyrics(folder, 'instrumental.mp3', '', null, 3000)).lyricsFile).toBeNull();
  });
  it('processes an existing saved track once, including retries after the file was already produced', async () => {
    const root = await directory(); const provider = new FakeProvider();
    const app = await buildApp({ root, provider, downloader: async () => { throw new Error('Existing audio must not be downloaded again'); } });
    cleanup.push(() => app.app.close());
    const job = sampleJob({ status: 'succeeded' }); app.store.createJob(job);
    const id = randomUUID(); const source = await fakeDownload('', path.join(root, 'storage'), id);
    app.store.addTrack({ id, jobId: job.id, providerId: 'existing', title: '已有作品', mode: 'easy', duration: 8000, model: 'test', lyrics: '原有歌词', lyricsSections: null, createdAt: Date.now(), saveStatus: 'saved', url: 'https://example.com/test.wav', localFile: source.filename, contentType: 'audio/wav' });
    await trimAudioEnd(source.filename, path.join(root, 'storage'), id); // Simulate a crash before the DB update.
    await app.runner.saveTrack(id); const first = app.store.getTrack(id)!;
    const before = await stat(path.join(root, 'storage', first.localFile!));
    await app.runner.saveTrack(id); const second = app.store.getTrack(id)!;
    expect(second.duration).toBe(3000); expect(second.sourceDuration).toBe(8000); expect(second.processingVersion).toBe(1);
    expect(second.lyricsFile).toBeTruthy(); expect(provider.submissions).toBe(0);
    expect((await stat(path.join(root, 'storage', second.localFile!))).mtimeMs).toBe(before.mtimeMs);
  });
  it('retries a failed lyric write without cutting the already processed audio again', async () => {
    const root = await directory(); let calls = 0;
    const server = await buildApp({ root, provider: new FakeProvider(), downloader: fakeDownload, processor: async (...args) => { calls++; return trimAudioEnd(...args); } });
    cleanup.push(() => server.app.close());
    const job = sampleJob({ status: 'succeeded' }); server.store.createJob(job); const id = randomUUID();
    server.store.addTrack({ id, jobId: job.id, providerId: 'failed-lyric', title: '歌词重试', mode: 'easy', duration: 8000, model: 'test', lyrics: '歌词', lyricsSections: null, createdAt: Date.now(), saveStatus: 'saving', url: 'https://example.com/test.wav' });
    const blockingPath = path.join(root, 'storage', `${id}.trimmed-v1.txt`); await mkdir(blockingPath);
    await server.runner.saveTrack(id); expect(server.store.getTrack(id)?.saveStatus).toBe('save_failed');
    await rmdir(blockingPath); await server.runner.saveTrack(id);
    expect(server.store.getTrack(id)?.saveStatus).toBe('saved'); expect(calls).toBe(1); expect(server.store.getTrack(id)?.duration).toBe(3000);
  });
});
