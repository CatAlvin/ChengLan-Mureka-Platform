import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const run = promisify(execFile);
export const AUDIO_PROCESSING_VERSION = 1;
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = () => process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');

export async function audioDuration(file: string): Promise<number> {
  // Count decoded samples. FFmpeg 4.4's null-muxer progress timestamp can be
  // shorter than the actual PCM timeline by part of an MP3 frame (~26 ms).
  // Using that timestamp made valid server-side saves fail the 5 ms check.
  const probe = await run(ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,duration:frame=nb_samples', '-of', 'json', file],
  { windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const info = JSON.parse(probe.stdout) as { streams?: { sample_rate?: string; duration?: string }[]; frames?: { nb_samples?: number }[] };
  const rate = Number(info.streams?.[0]?.sample_rate);
  const samples = info.frames?.reduce((sum, frame) => sum + (Number.isSafeInteger(frame.nb_samples) && frame.nb_samples! > 0 ? frame.nb_samples! : 0), 0) || 0;
  const duration = samples / rate * 1000;
  if (!Number.isFinite(duration) || duration <= 0 || rate <= 0) throw new Error('无法读取音频时长');
  const declared = Number(info.streams?.[0]?.duration) * 1000;
  // AAC packets may decode past the MP4 edit-list end; MP3 metadata may include padding.
  return Math.round(Number.isFinite(declared) && declared > 0 ? Math.min(duration, declared) : duration);
}

export type ProcessedAudio = { filename: string; duration: number; sourceDuration: number };
export type AudioProcessor = (source: string, directory: string, id: string) => Promise<ProcessedAudio>;

export const trimAudioEnd: AudioProcessor = async (source, directory, id) => {
  const sourcePath = path.join(directory, source);
  const sourceDuration = await audioDuration(sourcePath);
  const extension = path.extname(source).toLowerCase();
  const filename = `${id}.trimmed-v${AUDIO_PROCESSING_VERSION}${extension}`;
  const temporary = path.join(directory, `${id}-${randomUUID()}.processing${extension}`);
  const encoders: Record<string, string[]> = {
    '.mp3': ['-c:a', 'libmp3lame', '-q:a', '0'], '.wav': ['-c:a', 'pcm_s16le'],
    '.flac': ['-c:a', 'flac'], '.m4a': ['-c:a', 'aac', '-b:a', '256k'],
  };
  if (!encoders[extension]) throw new Error('不支持的音频格式');
  if (extension === '.wav') {
    const probe = await run(ffprobe(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0', '-show_entries', 'stream=sample_fmt,bits_per_raw_sample,bits_per_sample', '-of', 'json', sourcePath], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    const stream = JSON.parse(probe.stdout).streams?.[0];
    const bits = Number(stream?.bits_per_raw_sample) || Number(stream?.bits_per_sample);
    const format = String(stream?.sample_fmt || '').replace(/p$/, '');
    const codec = format === 'flt' ? 'pcm_f32le' : format === 'dbl' ? 'pcm_f64le' : bits > 24 ? 'pcm_s32le' : bits > 16 ? 'pcm_s24le' : bits === 8 ? 'pcm_u8' : 'pcm_s16le';
    encoders[extension] = ['-c:a', codec];
  }
  try {
    // Always use the immutable source, including after a crash between file and DB writes.
    // A clip of five seconds or less stays playable instead of being truncated to nothing.
    if (sourceDuration <= 5000) await copyFile(sourcePath, temporary);
    else {
      await run(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', sourcePath,
        '-map', '0:a:0', '-vn', '-map_metadata', '0', '-t', String((sourceDuration - 5000) / 1000),
        ...encoders[extension], temporary], { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    }
    const duration = await audioDuration(temporary);
    if (!(await stat(temporary)).size || (sourceDuration > 5000 && Math.abs(duration - (sourceDuration - 5000)) > 5)) throw new Error('音频处理结果不完整');
    await rename(temporary, path.join(directory, filename));
    return { filename, duration, sourceDuration };
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
};

type LyricLine = { text: string; start: number | null };
export function lyricLines(sections: unknown): LyricLine[] {
  if (!Array.isArray(sections)) return [];
  return sections.flatMap(section => {
    if (!section || !Array.isArray(section.lines)) return [];
    return section.lines.flatMap((line: unknown) => {
      if (!line || typeof line !== 'object' || !('text' in line) || typeof line.text !== 'string' || !line.text.trim()) return [];
      const start = 'start' in line && typeof line.start === 'number' && Number.isFinite(line.start) && line.start >= 0 ? line.start : null;
      return [{ text: line.text.trim(), start }];
    });
  });
}
export function lyricsText(sections: unknown, fallback: string): string {
  const lines = lyricLines(sections);
  return lines.length ? lines.map(line => line.text).join('\n') : fallback.trim();
}
export function lrcText(sections: unknown, duration: number): string {
  return lyricLines(sections).filter((line): line is { text: string; start: number } => line.start !== null && line.start < duration)
    .sort((a, b) => a.start - b.start).map(line => {
      const centiseconds = Math.floor(line.start / 10);
      const minutes = String(Math.floor(centiseconds / 6000)).padStart(2, '0');
      const seconds = String(Math.floor(centiseconds / 100) % 60).padStart(2, '0');
      const fraction = String(centiseconds % 100).padStart(2, '0');
      return `[${minutes}:${seconds}.${fraction}]${line.text.replace(/[\r\n]+/g, ' ')}`;
    }).join('\n');
}
async function saveText(directory: string, filename: string, contents: string) {
  const temporary = path.join(directory, `${randomUUID()}.lyrics.part`);
  try {
    await writeFile(temporary, '\ufeff' + contents.replace(/\r?\n/g, '\r\n') + '\r\n', { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path.join(directory, filename));
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function saveLyrics(directory: string, audioFile: string, lyrics: string, sections: unknown, duration: number) {
  const text = lyricsText(sections, lyrics);
  if (!text) return { lyrics: '', lyricsFile: null, timedLyricsFile: null };
  const basename = path.parse(audioFile).name;
  const lyricsFile = `${basename}.txt`;
  await saveText(directory, lyricsFile, text);
  const timed = lrcText(sections, duration);
  const timedLyricsFile = timed ? `${basename}.lrc` : null;
  if (timedLyricsFile) await saveText(directory, timedLyricsFile, timed);
  return { lyrics: text, lyricsFile, timedLyricsFile };
}
