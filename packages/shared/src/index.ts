import { z } from 'zod';

export const styles = [
  { value: 'pop', label: '流行' }, { value: 'folk', label: '民谣' },
  { value: 'lo-fi', label: 'Lo-fi' }, { value: 'jazz', label: '爵士' },
  { value: 'r&b', label: 'R&B' }, { value: 'rock', label: '摇滚' },
  { value: 'edm', label: '电子' }, { value: 'ambient', label: '氛围' },
  { value: 'latin', label: '拉丁' }, { value: 'k-pop', label: 'K-pop' },
  { value: 'j-pop', label: 'J-pop' }, { value: 'house', label: 'House' },
  { value: 'gospel', label: '福音' },
] as const;
export const moods = ['温暖治愈', '轻松愉快', '安静舒缓', '充满力量', '浪漫心动', '怀旧感伤'] as const;
export const modeSchema = z.enum(['easy', 'lyrics', 'instrumental']);
export type Mode = z.infer<typeof modeSchema>;
export const modeNames: Record<Mode, string> = { easy: '一句话写歌', lyrics: '用我的歌词', instrumental: '做段纯音乐' };
export const DEFAULT_MUREKA_MODEL = 'mureka-9.5';
export const sourceSchema = z.object({ assetId: z.string().uuid(), kind: z.enum(['reference', 'melody']), start: z.number().int().nonnegative(), end: z.number().int().positive() });
export type CreativeSource = z.infer<typeof sourceSchema>;
export const draftSchema = z.object({
  mode: modeSchema,
  model: z.enum(['mureka-8', 'mureka-9', 'mureka-9.5']).optional(),
  title: z.string().max(80).default(''),
  prompt: z.string().max(3000).default(''),
  lyrics: z.string().max(8000).default(''),
  styles: z.array(z.enum(styles.map(s => s.value))).max(5).default([]),
  mood: z.enum(['', ...moods]).default(''),
  language: z.enum(['中文', '英文', '日语', '韩语']).default('中文'),
  gender: z.enum(['auto', 'female', 'male']).default('auto'),
  count: z.number().int().min(1).max(3).default(1),
  source: sourceSchema.nullable().optional(), collectionId: z.string().uuid().nullable().optional(),
});
export type CreativeInput = z.infer<typeof draftSchema>;
export const emptyDraft = (mode: Mode): CreativeInput => draftSchema.parse({ mode });
export const creationModel = (input: Pick<CreativeInput, 'model' | 'source'>) => input.source?.kind === 'melody' ? 'mureka-8' : input.model || DEFAULT_MUREKA_MODEL;

export function buildPrompt(input: CreativeInput): string {
  const parts = [input.prompt.trim()];
  if (input.mode !== 'easy' && input.styles.length) parts.push(input.styles.join(', '));
  if (input.mood) parts.push(input.mood);
  if (input.mode !== 'instrumental') parts.push(`${input.language}歌词`);
  return parts.filter(Boolean).join('；');
}

export const generationSchema = draftSchema.superRefine((input, ctx) => {
  if (input.mode !== 'lyrics' && !input.prompt.trim() && !(input.mode === 'instrumental' && input.source)) {
    ctx.addIssue({ code: 'custom', path: ['prompt'], message: '先描述一下你想创作的音乐吧' });
  }
  if (input.mode === 'lyrics' && !input.lyrics.trim()) {
    ctx.addIssue({ code: 'custom', path: ['lyrics'], message: '请粘贴歌词，或先让 AI 帮你写一份' });
  }
  if (input.lyrics.length > 5000 && input.mode === 'lyrics') {
    ctx.addIssue({ code: 'custom', path: ['lyrics'], message: '歌词需要控制在 5000 字以内' });
  }
  const limit = input.mode === 'easy' ? 2000 : 1024;
  if ((!input.source || input.mode === 'easy') && buildPrompt(input).length > limit) {
    ctx.addIssue({ code: 'custom', path: ['prompt'], message: `描述和所选偏好合计不能超过 ${limit} 字，请稍作精简` });
  }
  if (input.source) {
    const length = input.source.end - input.source.start;
    if (input.source.kind === 'melody' && input.mode !== 'lyrics') ctx.addIssue({ code: 'custom', path: ['source'], message: '哼唱旋律请搭配“用我的歌词”模式' });
    if (input.source.kind === 'reference' ? length !== 30000 : length < 5000 || length > 60000) ctx.addIssue({ code: 'custom', path: ['source'], message: input.source.kind === 'reference' ? '参考曲请选择完整的 30 秒片段' : '哼唱旋律请选择 5–60 秒的片段' });
  }
});

export function toMurekaBody(input: CreativeInput, uploadId?: string): Record<string, unknown> {
  const base = { model: creationModel(input), n: input.count, prompt: buildPrompt(input), stream: false };
  if (input.source) {
    if (!uploadId) throw new Error('创作素材尚未上传');
    if (input.mode === 'easy') return { ...base, ...(input.styles.length ? { styles: input.styles } : {}), reference_id: uploadId };
    if (input.mode === 'instrumental') return { model: base.model, n: input.count, stream: false, instrumental_id: uploadId };
    return input.source.kind === 'melody'
      ? { model: 'mureka-8', n: input.count, stream: false, lyrics: input.lyrics.trim(), melody_id: uploadId }
      : { model: base.model, n: input.count, stream: false, lyrics: input.lyrics.trim(), reference_id: uploadId, ...(input.gender === 'auto' ? {} : { gender: input.gender }) };
  }
  if (input.mode === 'easy') return { ...base, ...(input.styles.length ? { styles: input.styles } : {}) };
  if (input.mode === 'instrumental') return base;
  return { ...base, lyrics: input.lyrics.trim(), ...(input.gender === 'auto' ? {} : { gender: input.gender }) };
}

export const statusNames: Record<string, string> = {
  preparing_source: '正在处理音频', saving: '正在保存音频', save_failed: '音频保存未完成',
  local_queued: '等待提交', submitting: '正在提交', submission_unknown: '提交待核实',
  preparing: '正在准备', queued: '云端排队', running: '正在创作', streaming: '正在创作',
  reviewing: '正在审核', succeeded: '已完成', failed: '生成失败', timeouted: '生成超时', cancelled: '已取消',
};
export const providerStatuses = ['preparing', 'queued', 'running', 'streaming', 'reviewing', 'succeeded', 'failed', 'timeouted', 'cancelled'] as const;
export type ProviderStatus = typeof providerStatuses[number];
export type JobStatus = ProviderStatus | 'local_queued' | 'preparing_source' | 'submitting' | 'submission_unknown' | 'saving' | 'save_failed';
export const terminalStatuses: string[] = ['succeeded', 'failed', 'timeouted', 'cancelled', 'save_failed'];
export type JobKind = 'song' | 'instrumental' | 'lyrics' | 'extend' | 'region_edit' | 'remix' | 'stem' | 'lyrics_extend' | 'import' | 'recognize' | 'describe' | 'crop' | 'track' | 'transcribe';
export const trackTypes = { Vocals: '人声', Instrumental: '伴奏', Drums: '鼓组', Bass: '贝斯', Guitar: '吉他', Keyboard: '键盘', Percussion: '打击乐', Strings: '弦乐', Synth: '合成器', FX: '音效', Brass: '铜管', Woodwinds: '木管' } as const;
const toolBase = { sourceTrackId: z.string().uuid(), title: z.string().trim().max(80).default('') };
const newLyrics = z.string().trim().min(1, '请写下希望唱出的歌词').max(3000, '歌词请控制在 3000 字以内');
export const toolInputSchema = z.discriminatedUnion('operation', [
  z.object({ ...toolBase, operation: z.literal('crop'), start: z.number().int().nonnegative(), end: z.number().int().positive() }),
  z.object({ ...toolBase, operation: z.literal('extend'), lyrics: newLyrics, at: z.number().int().nonnegative(), direction: z.enum(['tail', 'head']) }),
  z.object({ ...toolBase, operation: z.literal('region_edit'), lyrics: newLyrics, start: z.number().int().nonnegative(), end: z.number().int().positive() }),
  z.object({ ...toolBase, operation: z.literal('remix'), lyrics: z.string().trim().max(5000, '歌词请控制在 5000 字以内').default(''), prompt: z.string().trim().min(1, '请描述重制后的曲风和演唱方式').max(1024, '重制描述请控制在 1024 字以内') }),
  z.object({ ...toolBase, operation: z.literal('stem'), preset: z.enum(['vocals', 'band', 'detailed']) }),
  z.object({ ...toolBase, operation: z.literal('track'), generateType: z.enum(Object.keys(trackTypes) as [keyof typeof trackTypes, ...(keyof typeof trackTypes)[]]), prompt: z.string().trim().min(1, '请描述希望生成的声音').max(1024), lyrics: z.string().trim().max(5000).default(''), vocalGender: z.enum(['auto', 'female', 'male']).default('auto'), start: z.number().int().nonnegative(), end: z.number().int().positive() }).refine(input => input.generateType !== 'Vocals' || !!input.lyrics, { path: ['lyrics'], message: '生成人声时请填写歌词' }),
  z.object({ ...toolBase, operation: z.literal('transcribe'), title: z.string().trim().max(50, '乐谱标题请控制在 50 字以内').default('') }),
  z.object({ ...toolBase, operation: z.literal('lyrics_extend'), lyrics: z.string().trim().min(1, '先写几句歌词，再让 AI 接下一句').max(8000) }),
  z.object({ ...toolBase, operation: z.literal('recognize') }),
  z.object({ ...toolBase, operation: z.literal('describe') }),
]);
export type ToolInput = z.infer<typeof toolInputSchema>;
export const toolNames = { crop: '音频裁剪', extend: '歌曲续写', region_edit: '局部重唱', remix: '整首重制', stem: '分离音轨', lyrics_extend: '歌词接写', recognize: '识别歌词', describe: '分析音乐', track: '生成单轨', transcribe: '音乐转谱' } as const;
export function toolRangeError(input: ToolInput, duration: number): string | null {
  if (input.operation === 'crop' && (input.end - input.start < 100 || input.end > duration)) return '保留片段至少 0.1 秒，开始和结束时间不能超出音频时长';
  if (input.operation === 'extend' && (input.at <= 0 || input.at >= duration)) return '续写位置需要在歌曲开始和结束之间';
  if (input.operation === 'region_edit' && (input.end - input.start < 3000 || input.end > duration)) return '选区至少 3 秒，且不能超出歌曲时长';
  // Application safeguard: retain some original audio for a local edit. Full
  // replacements belong to remix, even if the upstream accepts their timestamps.
  if (input.operation === 'region_edit' && duration - (input.end - input.start) < 3000) return '局部重唱需要保留至少 3 秒原曲。替换整首歌词请使用“整首重制”。';
  if (input.operation === 'remix' && (duration < 10000 || duration > 480000)) return '整首重制支持 10–480 秒的音频，请先裁剪到这个范围';
  if (input.operation === 'track' && (input.end <= input.start || input.end > duration)) return '请选择原曲时长内的有效片段';
  if (input.operation === 'transcribe' && (duration < 10000 || duration > 600000)) return '音乐转谱支持 10 秒至 10 分钟的音频，请先选择合适作品或裁剪';
  return null;
}
export function toMurekaToolBody(input: ToolInput, uploadId: string): Record<string, unknown> {
  if (input.operation === 'extend') return { upload_audio_id: uploadId, lyrics: input.lyrics, extend_at: input.at, extend_type: input.direction, model: 'mureka-8' };
  if (input.operation === 'region_edit') return { upload_audio_id: uploadId, lyrics: input.lyrics, edit_start: input.start, edit_end: input.end };
  if (input.operation === 'remix') return { upload_audio_id: uploadId, model: DEFAULT_MUREKA_MODEL, ...(input.lyrics ? { lyrics: input.lyrics } : {}), prompt: input.prompt, n: 1 };
  if (input.operation === 'track') return { upload_audio_id: uploadId, generate_type: input.generateType, prompt: input.prompt, generate_start: input.start, generate_end: input.end, ...(input.generateType === 'Vocals' ? { lyrics: input.lyrics, ...(input.vocalGender === 'auto' ? {} : { vocal_gender: input.vocalGender }) } : {}) };
  throw new Error('此操作不生成歌曲');
}
export const scoreFileSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), format: z.enum(['mid', 'midi', 'musicxml', 'xml', 'pdf', 'json']), bytes: z.number().int().positive().max(50 * 1024 * 1024) });
export type ScoreFile = z.infer<typeof scoreFileSchema>;
export type LyricsResult = { title: string; lyrics: string; lyricsSections?: unknown; timedLyrics?: string; duration?: number; description?: string; instruments?: string[]; genres?: string[]; tags?: string[]; scoreFiles?: ScoreFile[] };
export type Job = {
  id: string; submissionId: string; kind: JobKind; input: CreativeInput;
  status: JobStatus; providerId: string | null; error: string | null; traceId: string | null;
  result: LyricsResult | null; createdAt: number; updatedAt: number; pollAfter: number;
  tool?: ToolInput | null;
};
export type Track = {
  id: string; jobId: string; providerId: string; title: string; mode: Mode;
  duration: number; model: string; lyrics: string; lyricsSections: unknown;
  favorite: boolean; deletedAt: number | null; createdAt: number;
  saveStatus: 'saving' | 'saved' | 'save_failed'; saveError: string | null;
  playbackUrl: string | null; hasFlac: boolean; hasWav: boolean; watermarked: boolean;
  lyricsUrl: string | null; timedLyricsUrl: string | null;
  input: CreativeInput;
  parentTrackId?: string | null; operation?: 'extend' | 'region_edit' | 'remix' | 'stem' | 'crop' | 'track' | null; stemName?: string | null;
  collectionId?: string | null; exports?: AudioExport[]; downloadUrl?: string;
  origin?: 'generated' | 'uploaded'; originalUrl?: string | null;
};
export type Material = { id: string; name: string; duration: number; createdAt: number; deletedAt: number | null; playbackUrl: string };
export type Collection = { id: string; name: string; createdAt: number; archivedAt: number | null };
export type AudioExport = { id: string; trackId: string; format: 'flac' | 'wav'; status: 'saving' | 'saved' | 'save_failed'; error: string | null; duration: number; downloadUrl: string | null };
export type Account = {
  connected: boolean; configured: boolean; balance: number | null; totalSpending: number | null;
  concurrency: number; checkedAt: number | null; error: string | null;
};
export type Snapshot = { jobs: Job[]; tracks: Track[]; account: Account; storageBytes: number; materials?: Material[]; collections?: Collection[]; credits?: import('./credits.js').CreditBalance };

export const templates = [
  { id: 'travel', title: '把旅行写成歌', tag: '旅行 · 轻快民谣', color: 'blue', mode: 'easy', style: 'folk', mood: '轻松愉快', prompt: '写一首关于夏日公路旅行的中文歌。海风、落日、朋友和沿途的小镇，轻快的木吉他，副歌朗朗上口。' },
  { id: 'birthday', title: '送一份特别的祝福', tag: '生日 · 温暖流行', color: 'orange', mode: 'easy', style: 'pop', mood: '温暖治愈', prompt: '给最好的朋友写一首中文生日祝福歌，感谢一路的陪伴，期待新的冒险。温暖自然的表达，轻快的节奏，适合一起合唱。' },
  { id: 'focus', title: '给专注一点节奏', tag: '专注 · Lo-fi 纯音乐', color: 'green', mode: 'instrumental', style: 'lo-fi', mood: '安静舒缓', prompt: '适合午后阅读和专注工作的 Lo-fi 纯音乐。柔和电钢琴、温暖的低音和轻轻的鼓点，平静、连贯，不要人声。' },
  { id: 'night', title: '留住城市的夜色', tag: '夜晚 · 氛围电子', color: 'violet', mode: 'instrumental', style: 'ambient', mood: '安静舒缓', prompt: '为雨夜城市短片创作一段氛围纯音乐。缓慢的合成器、细腻的钢琴和深远的空间感，像车窗外缓缓后退的霓虹灯。' },
] as const;
