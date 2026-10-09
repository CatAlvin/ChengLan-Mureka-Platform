import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { audioDuration, lyricLines, lyricsText } from './postprocess.js';
import type { ToolInput } from '../../../packages/shared/src/index.js';

const run = promisify(execFile);
// Keep the complete base64 request below the upstream 10 MB limit.
const MAX_SOURCE = 7 * 1024 * 1024;

export function regionResultError(tool: ToolInput, sourceDuration: number, duration: number): string | null {
  if (tool.operation !== 'region_edit') return null;
  // An edited song must still contain its untouched audio. A half-length floor
  // also catches grossly truncated results from legacy whole-song selections.
  // Allow one second for codec padding and transitions; this is a local check,
  // not a promise that a result matching the duration will sound correct.
  const minimum = Math.max(sourceDuration / 2, sourceDuration - (tool.end - tool.start));
  if (duration + 1000 >= minimum) return null;
  return `局部重唱结果异常：原曲 ${(sourceDuration / 1000).toFixed(2)} 秒，返回音频处理后仅 ${(duration / 1000).toFixed(2)} 秒，未保留完整歌曲。音频与云端编号已保留，请核对 Mureka；替换整首歌词请使用“整首重制”。`;
}

// Decode before trimming: compressed packet boundaries are not exact user selections.
// Native WAV/FLAC crops keep their sample rate, channel layout and PCM precision.
export async function cropAudio(directory: string, source: string, id: string, start: number, end: number, format: 'mp3' | 'wav' | 'flac') {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end - start < 100) throw new Error('裁剪范围无效');
  const input = path.join(directory, source);
  const filename = `${id}.${format}`;
  const temporary = path.join(directory, `${randomUUID()}.crop.part.${format}`);
  const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
  const probe = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,sample_fmt,bits_per_raw_sample,bits_per_sample', '-of', 'json', input], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const stream = JSON.parse(probe.stdout).streams?.[0];
  const rate = Number(stream?.sample_rate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('无法读取音频');
  const bits = Number(stream?.bits_per_raw_sample) || Number(stream?.bits_per_sample);
  const sampleFormat = String(stream?.sample_fmt || '').replace(/p$/, '');
  const pcm = sampleFormat === 'flt' ? 'pcm_f32le' : sampleFormat === 'dbl' ? 'pcm_f64le' : bits > 24 ? 'pcm_s32le' : bits > 16 ? 'pcm_s24le' : bits === 8 ? 'pcm_u8' : 'pcm_s16le';
  const encoder = format === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '0'] : format === 'wav' ? ['-c:a', pcm] : ['-c:a', 'flac'];
  try {
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', input,
      '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-af', `atrim=start_sample=${Math.round(start * rate / 1000)}:end_sample=${Math.round(end * rate / 1000)},asetpts=PTS-STARTPTS`, ...encoder, temporary],
    { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    const duration = await audioDuration(temporary);
    if (!(await stat(temporary)).size || Math.abs(duration - (end - start)) > 5) throw new Error('裁剪结果时长不完整');
    await rename(temporary, path.join(directory, filename));
    return { filename, duration };
  } finally { await unlink(temporary).catch(() => {}); }
}

export function cropLyrics(sections: unknown, fallback: string, start: number, end: number, sourceDuration: number) {
  const times = lyricLines(sections).flatMap(line => line.start === null ? [] : [line.start]).sort((a, b) => a - b);
  if (!times.length) return { lyrics: fallback.trim() ? `歌词参考（原曲歌词，未提供时间信息）\n\n${fallback.trim()}` : '', sections: null };
  const shift = (entry: Record<string, unknown>, from: number, to: number) => ({ ...entry, start: Math.max(0, from - start), end: Math.min(end, to) - start });
  const output = (sections as { lines?: Record<string, unknown>[] }[]).flatMap(section => {
    if (!Array.isArray(section?.lines)) return [];
    const lines = section.lines.flatMap(line => {
      if (typeof line?.start !== 'number' || !Number.isFinite(line.start) || typeof line.text !== 'string') return [];
      const from = line.start;
      const to = typeof line.end === 'number' && Number.isFinite(line.end) && line.end > from ? line.end : times.find(time => time > from) ?? sourceDuration;
      if (line.start >= end || to <= start) return [];
      // Retain only line timestamps. Word timestamps and section boundaries refer to
      // the original timeline and must not leak into the shorter clip.
      return [shift({ text: line.text }, line.start, to)];
    });
    return lines.length ? [{ lines }] : [];
  });
  return { lyrics: lyricsText(output, ''), sections: output.length ? output : null };
}
export async function prepareToolAudio(directory: string, filename: string, duration: number): Promise<Uint8Array> {
  const source = path.join(directory, filename);
  if (path.extname(filename) === '.mp3' && (await stat(source)).size <= MAX_SOURCE) return readFile(source);
  const target = path.join(directory, `${randomUUID()}.tool-source.mp3`);
  const rate = Math.min(160, Math.floor(MAX_SOURCE * 8 / (duration / 1000) / 1000 * 0.9));
  if (rate < 32) throw new Error('这段音频过长');
  try {
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', source,
      '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', `${rate}k`, target],
    { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    if ((await stat(target)).size > MAX_SOURCE) throw new Error('素材超过上传大小限制');
    return await readFile(target);
  } finally { await unlink(target).catch(() => {}); }
}

export function stemEntries(archive: Uint8Array): [string, Uint8Array][] {
  let bytes = 0; let count = 0;
  const entries = unzipSync(archive, { filter(file) {
    if (++count > 64 || file.name.includes('\\') || file.name.startsWith('/') || file.name.split('/').some(p => p === '..' || p.includes(':'))) throw new Error('分轨压缩包路径无效');
    bytes += file.originalSize;
    if (bytes > 300 * 1024 * 1024 || file.originalSize > 100 * 1024 * 1024) throw new Error('分轨文件超过本机保存上限');
    return /\.wav$/i.test(file.name) && !file.name.startsWith('__MACOSX/');
  } });
  const files = Object.entries(entries);
  if (!files.length || files.length > 12) throw new Error('压缩包内没有可用的分轨音频');
  return files;
}
export function stemLabel(name: string): { label: string; vocal: boolean } {
  const raw = path.posix.parse(name).name;
  const lower = raw.toLowerCase();
  // Check negative vocal names first: "no_vocals" is accompaniment.
  if (/instrumental|accompaniment|no[_ -]?vocals?|伴奏/.test(lower)) return { label: '伴奏', vocal: false };
  const labels: [RegExp, string][] = [[/vocal|人声/, '人声'], [/drum|鼓/, '鼓组'], [/bass|贝斯/, '贝斯'], [/piano|钢琴/, '钢琴'], [/guitar|吉他/, '吉他'], [/flute|长笛/, '长笛'], [/woodwind|木管/, '木管'], [/brass|铜管/, '铜管'], [/string|弦乐/, '弦乐'], [/synth|合成器/, '合成器'], [/keyboard|键盘/, '键盘'], [/percussion|打击/, '打击乐'], [/^fx$|sound.effect|音效/, '音效'], [/other|其他/, '其他乐器']];
  for (const [match, label] of labels) if (match.test(lower)) return { label, vocal: label === '人声' };
  return { label: Array.from(raw).filter(char => char.charCodeAt(0) >= 32).join('').slice(0, 40) || '音轨', vocal: false };
}
export async function saveStemWav(data: Uint8Array, directory: string, id: string) {
  const filename = `${id}.wav`; const temporary = path.join(directory, `${id}.stem.part.wav`);
  try {
    await writeFile(temporary, data);
    const duration = await audioDuration(temporary);
    await rename(temporary, path.join(directory, filename));
    return { filename, duration };
  } finally { await unlink(temporary).catch(() => {}); }
}
