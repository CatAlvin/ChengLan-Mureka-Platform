import { z } from 'zod';
import { providerStatuses, toMurekaBody, toMurekaToolBody, type ToolInput, type CreativeInput, type JobKind, type LyricsResult } from '../../../packages/shared/src/index.js';

export const songTaskSchema = z.object({
  id: z.union([z.string().min(1), z.number()]).transform(String),
  status: z.enum(providerStatuses), model: z.string().optional(),
  failed_reason: z.string().optional(), trace_id: z.string().optional(), watermarked: z.boolean().optional(),
  choices: z.array(z.object({
    id: z.union([z.string().min(1), z.number()]).transform(String),
    url: z.string().url(), flac_url: z.string().optional(), wav_url: z.string().optional(),
    duration: z.number().nonnegative().optional(), lyrics_sections: z.unknown().optional(),
  })).optional(),
});
export type SongTask = z.infer<typeof songTaskSchema>;
export type Billing = { balance: number; total_spending: number; concurrent_request_limit: number };
export interface MusicProvider {
  configured: boolean;
  billing(): Promise<Billing>;
  submit(input: CreativeInput, uploadId?: string): Promise<SongTask>;
  query(id: string, kind: JobKind): Promise<SongTask>;
  lyrics(prompt: string): Promise<LyricsResult>;
  uploadAudio(data: Uint8Array, purpose?: 'audio' | 'reference' | 'melody' | 'instrumental' | 'remix'): Promise<string>;
  createVersion(input: ToolInput, uploadId: string): Promise<SongTask>;
  extendLyrics(lyrics: string): Promise<LyricsResult>;
  separate(data: Uint8Array, preset: 'vocals' | 'band' | 'detailed'): Promise<string | { audio: string; midi?: string }>;
  transcribe(uploadId: string, title: string): Promise<string>;
  recognize(uploadId: string): Promise<{ duration: number; lyrics_sections: unknown }>;
  describe(data: Uint8Array): Promise<{ instrument: string[]; genres: string[]; tags: string[]; description: string }>;
}
export class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly traceId: string | null = null, readonly ambiguous = false) { super(message); }
}
export function errorText(status: number, upstream: string): string {
  if (status === 400) return '创作参数未被接受，请修改描述或歌词后再试。';
  if (status === 401) return 'Mureka 密钥无效，请检查本机连接配置。';
  if (status === 403) return 'Mureka 暂不支持当前访问地区。';
  if (status === 451) return '这次内容未通过审核，请调整描述或歌词。';
  if (status === 429) return /quota|balance|credit|余额|额度/i.test(upstream)
    ? 'Mureka 账户额度不足，请检查余额后再提交。' : 'Mureka 当前请求较多，请稍后再试。';
  return 'Mureka 暂时无法响应，请稍后更新任务状态。';
}
export class MurekaProvider implements MusicProvider {
  readonly configured: boolean;
  constructor(private readonly key: string, private readonly baseUrl = 'https://api.mureka.cn') { this.configured = !!key; }
  private async request(endpoint: string, body?: unknown, timeout = 60000): Promise<unknown> {
    if (!this.key) throw new ProviderError('尚未找到密钥，请将密钥放入项目的 Mureka-API-Key.txt。', 401);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.key}`, ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(body === undefined ? 20000 : timeout), redirect: 'error',
      });
    } catch { throw new ProviderError(body === undefined ? '暂时连接不到 Mureka，请检查网络。' : '提交结果待核实，请勿重复提交以免再次计费。', 0, null, body !== undefined); }
    const json = await response.json().catch(() => null) as { error?: { message?: string }; trace_id?: string } | null;
    const trace = typeof json?.trace_id === 'string' && /^[\w-]{1,128}$/.test(json.trace_id) ? json.trace_id : null;
    if (!response.ok) throw new ProviderError(errorText(response.status, json?.error?.message ?? ''), response.status, trace, body !== undefined && response.status >= 500);
    if (!json) throw new ProviderError('Mureka 返回了暂时无法识别的结果，请保留任务等待核实。', 0, trace, body !== undefined);
    return json;
  }
  async billing() {
    return z.object({ balance: z.number().int(), total_spending: z.number().int(), concurrent_request_limit: z.number().int().min(1) })
      .parse(await this.request('/v1/account/billing'));
  }
  async submit(input: CreativeInput, uploadId?: string) {
    const endpoint = input.mode === 'easy' ? '/v1/song/easy-generate' : input.mode === 'lyrics' ? '/v1/song/generate' : '/v1/instrumental/generate';
    const result = songTaskSchema.safeParse(await this.request(endpoint, toMurekaBody(input, uploadId)));
    if (!result.success) throw new ProviderError('生成请求已发出，但返回结构无法识别，请核实任务后再操作。', 0, null, true);
    return result.data;
  }
  async query(id: string, kind: JobKind) {
    return songTaskSchema.parse(await this.request(`/v1/${kind === 'instrumental' ? 'instrumental' : 'song'}/query/${encodeURIComponent(id)}`));
  }
  async lyrics(prompt: string) {
    const result = z.object({ title: z.string(), lyrics: z.string() }).safeParse(await this.request('/v1/lyrics/generate', { prompt }));
    if (!result.success) throw new ProviderError('歌词请求已发出，但结果无法识别，请核实后再操作。', 0, null, true);
    return result.data;
  }
  async uploadAudio(data: Uint8Array, purpose: 'audio' | 'reference' | 'melody' | 'instrumental' | 'remix' = 'audio') {
    const form = new FormData();
    form.set('purpose', purpose); form.set('file', new Blob([new Uint8Array(data)], { type: 'audio/mpeg' }), 'source.mp3');
    const result = z.object({ id: z.string().min(1) }).safeParse(await this.request('/v1/files/upload', form, 180000));
    if (!result.success) throw new Error('素材上传结果无法识别');
    return result.data.id;
  }
  async createVersion(input: ToolInput, uploadId: string) {
    const endpoint = input.operation === 'track' ? '/v1/track/generate' : input.operation === 'extend' ? '/v1/song/extend' : input.operation === 'remix' ? '/v1/song/remix' : '/v1/song/region-edit';
    const result = songTaskSchema.safeParse(await this.request(endpoint, toMurekaToolBody(input, uploadId)));
    if (!result.success) throw new ProviderError('创作请求已发出，但结果待核实。', 0, null, true);
    return result.data;
  }
  async extendLyrics(lyrics: string) {
    const result = z.object({ lyrics: z.string().min(1) }).safeParse(await this.request('/v1/lyrics/extend', { lyrics }));
    if (!result.success) throw new ProviderError('接写请求已发出，但结果待核实。', 0, null, true);
    return { title: '下一句歌词', lyrics: result.data.lyrics };
  }
  async separate(data: Uint8Array, preset: 'vocals' | 'band' | 'detailed') {
    const result = z.object({ zip_url: z.string().url(), midi_zip_url: z.string().url().nullish() }).safeParse(await this.request('/v1/song/stem', {
      url: `data:audio/mp3;base64,${Buffer.from(data).toString('base64')}`,
      model: preset === 'vocals' ? 'audio-separation-3' : preset === 'detailed' ? 'audio-separation-2' : 'audio-separation-1',
    }, 600000));
    if (!result.success) throw new ProviderError('分轨请求已发出，但结果待核实。', 0, null, true);
    return { audio: result.data.zip_url, ...(result.data.midi_zip_url ? { midi: result.data.midi_zip_url } : {}) };
  }
  async transcribe(uploadId: string, title: string) {
    const result = z.object({ zip_url: z.string().url() }).safeParse(await this.request('/v1/song/transcribe', { upload_audio_id: uploadId, title: title.slice(0, 50) }, 600000));
    if (!result.success) throw new ProviderError('转谱请求已发出，但结果待核实。', 0, null, true);
    return result.data.zip_url;
  }
  async recognize(uploadId: string) {
    const line = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string() });
    const result = z.object({ duration: z.number().positive(), lyrics_sections: z.array(z.object({ start: z.number().optional(), end: z.number().optional(), lines: z.array(line) })) })
      .safeParse(await this.request('/v1/song/recognize', { upload_audio_id: uploadId }, 180000));
    if (!result.success) throw new ProviderError('歌词识别请求已发出，但结果待核实。', 0, null, true);
    return result.data;
  }
  async describe(data: Uint8Array) {
    const result = z.object({ instrument: z.array(z.string()), genres: z.array(z.string()), tags: z.array(z.string()), description: z.string() })
      .safeParse(await this.request('/v1/song/describe', { url: `data:audio/mp3;base64,${Buffer.from(data).toString('base64')}` }, 180000));
    if (!result.success) throw new ProviderError('音乐分析请求已发出，但结果待核实。', 0, null, true);
    return result.data;
  }
}
