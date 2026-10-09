import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { emptyDraft, type CreativeInput, type Job, type ToolInput } from '../packages/shared/src/index.js';
import type { MusicProvider, SongTask } from '../apps/server/src/provider.js';
import type { Downloader } from '../apps/server/src/media.js';
import type { FastifyInstance } from 'fastify';
export const testCredentials = { username: 'testadmin', password: 'Test-only-password-123' };
export async function loginAs(app: FastifyInstance, credentials = testCredentials, host = '127.0.0.1:4173') {
  const session = await app.inject({ url: '/api/session', headers: { host } });
  const headers = { host, cookie: session.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': session.json().csrfToken };
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: credentials });
  if (login.statusCode !== 200) throw new Error(`Test login failed: ${login.body}`);
  return { host, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
}

export const sampleInput = (): CreativeInput => ({ ...emptyDraft('easy'), prompt: '一首关于海边散步的温暖民谣', title: '测试 · 海边散步' });
export const sampleJob = (patch: Partial<Job> = {}): Job => ({ id: randomUUID(), submissionId: randomUUID(), input: sampleInput(), kind: 'song', status: 'local_queued', providerId: null, result: null, traceId: null, error: null, createdAt: Date.now(), updatedAt: Date.now(), pollAfter: 0, ...patch });

export class FakeProvider implements MusicProvider {
  configured = true;
  submissions = 0;
  queries = 0;
  lyricCalls = 0;
  balance = 10000;
  limit = 1;
  submitError: Error | null = null;
  queryError: Error | null = null;
  queryStatus: SongTask['status'] = 'succeeded';
  toolCalls = 0; uploadCalls = 0; stemCalls = 0; extendCalls = 0;
  recognizeCalls = 0; describeCalls = 0;
  transcribeCalls = 0;
  async transcribe(_uploadId: string, _title: string) { this.transcribeCalls++; if (this.submitError) throw this.submitError; return 'https://example.com/score.zip'; }
  async recognize(_uploadId: string) { this.recognizeCalls++; if (this.submitError) throw this.submitError; return { duration: 8000, lyrics_sections: [{ lines: [{ start: 0, end: 3000, text: '海风穿过窗台' }, { start: 3000, end: 7000, text: '和你一起走向未来' }] }] }; }
  async describe(_data: Uint8Array) { this.describeCalls++; if (this.submitError) throw this.submitError; return { instrument: ['钢琴', '吉他'], genres: ['民谣'], tags: ['温暖'], description: '柔和的吉他与钢琴，轻松温暖的民谣氛围。' }; }
  async uploadAudio(_data: Uint8Array) { this.uploadCalls++; return 'fixture-upload'; }
  async createVersion(_input: ToolInput, _uploadId: string): Promise<SongTask> { this.toolCalls++; if (this.submitError) throw this.submitError; return { id: `tool-${this.toolCalls}`, status: 'running' }; }
  async extendLyrics(_lyrics: string) { this.extendCalls++; return { title: '下一句歌词', lyrics: '让明天的风带我们去远方' }; }
  async separate(_data: Uint8Array, preset: 'vocals' | 'band' | 'detailed'): Promise<string | { audio: string; midi?: string }> { this.stemCalls++; if (this.submitError) throw this.submitError; return preset === 'detailed' ? { audio: 'https://example.com/stems.zip', midi: 'https://example.com/midi.zip' } : 'https://example.com/stems.zip'; }
  async billing() { return { balance: this.balance, total_spending: 0, concurrent_request_limit: this.limit }; }
  async submit(_input: CreativeInput): Promise<SongTask> {
    this.submissions++;
    if (this.submitError) throw this.submitError;
    return { id: `fake-${this.submissions}`, status: 'running' };
  }
  async query(id: string): Promise<SongTask> {
    this.queries++;
    if (this.queryError) throw this.queryError;
    return { id, status: this.queryStatus, model: 'fixture', choices: this.queryStatus === 'succeeded' ? [{ id: `choice-${id}`, url: 'https://example.com/fixture.wav', duration: 8000, lyrics_sections: [{ lines: [{ text: '这是一段本地测试旋律', start: 0, end: 2000 }] }] }] : undefined };
  }
  async lyrics(_prompt: string) { this.lyricCalls++; return { title: '测试歌词', lyrics: '[Verse]\n海风穿过窗台\n[Chorus]\n和你一起走向未来' }; }
}

export function testWav(seconds = 8) {
  const rate = 16000; const samples = rate * seconds; const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / rate) * 1000), 44 + i * 2);
  return wav;
}
export const fakeDownload: Downloader = async (_url, directory, id) => {
  await mkdir(directory, { recursive: true }); const wav = testWav(); const filename = `${id}.wav`;
  await writeFile(path.join(directory, filename), wav);
  return { filename, bytes: wav.length, contentType: 'audio/wav' };
};
export const fakeArchiveDownload: Downloader = async (_url, directory, id) => {
  await mkdir(directory, { recursive: true }); const filename = `${id}.zip`;
  const data = _url.includes('score') ? zipSync({ '旋律.musicxml': Buffer.from('<?xml version="1.0"?><score-partwise version="4.0"><part-list/></score-partwise>'), '旋律.pdf': Buffer.from('%PDF-1.4\n%%EOF'), 'lyrics.json': Buffer.from('{"lyrics_sections":[]}') }) : _url.includes('midi') ? zipSync({ 'vocals.mid': new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,0,96,77,84,114,107,0,0,0,4,0,255,47,0]) }) : zipSync({ 'stems/vocals.wav': testWav(), 'stems/instrumental.wav': testWav() });
  await writeFile(path.join(directory, filename), data);
  return { filename, contentType: 'application/zip', bytes: data.byteLength };
};
