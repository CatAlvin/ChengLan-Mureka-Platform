import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CreativeInput } from '../../../packages/shared/src/index.js';
import { audioDuration } from './postprocess.js';
import type { Store } from './db.js';

const run = promisify(execFile);
const options = { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 };
const supported = ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.webm'];
export const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
export const MAX_MUSIC_BYTES = 100 * 1024 * 1024;
export async function importMaterial(data: Buffer, name: string, directory: string, id: string, maxBytes = MAX_MATERIAL_BYTES) {
  const ext = path.extname(name).toLowerCase();
  if (!supported.includes(ext) || !data.length || data.length > maxBytes) throw new Error(`请导入 ${maxBytes / 1024 / 1024} MB 以内的 MP3、M4A、WAV、FLAC、OGG 或 WebM 音频。`);
  if (ext === '.flac' && data.subarray(0, 4).toString() !== 'fLaC' || ext === '.wav' && (!['RIFF', 'RF64'].includes(data.subarray(0, 4).toString()) || data.subarray(8, 12).toString() !== 'WAVE')) throw new Error('请导入与文件扩展名一致的有效音频。');
  const originalFile = `${id}.source${ext}`; const previewFile = `${id}.preview.mp3`;
  const original = path.join(directory, originalFile); const preview = path.join(directory, previewFile);
  const temporary = path.join(directory, `${id}.preview.part.mp3`);
  let created = false;
  try {
    await writeFile(original, data, { flag: 'wx' });
    created = true;
    const duration = await audioDuration(original);
    if (duration < 5000 || duration > 600000) throw new Error('素材需要在 5 秒到 10 分钟之间。');
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', original,
      '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '128k', temporary], options);
    const decoded = await audioDuration(temporary);
    if (Math.abs(duration - decoded) > 100) throw new Error('素材转换未完整完成。');
    await rename(temporary, preview);
    return { originalFile, previewFile, duration: decoded, sourceDuration: duration };
  } catch (error) {
    if (created) await Promise.allSettled([unlink(original), unlink(preview)]);
    throw error;
  } finally { await unlink(temporary).catch(() => {}); }
}
export function sourceError(store: Store, input: CreativeInput): string | null {
  if (!input.source) return null;
  const asset = store.getMaterial(input.source.assetId);
  if (!asset || asset.deletedAt) return '所选素材已移除，请重新选择素材。';
  if (input.source.end > asset.duration) return '选择的片段超出了素材时长。';
  return null;
}
export async function prepareSource(store: Store, input: CreativeInput, directory: string) {
  const error = sourceError(store, input); if (error) throw new Error(error);
  const source = input.source!; const asset = store.getMaterial(source.assetId)!;
  const file = path.join(directory, `${randomUUID()}.reference.mp3`);
  try {
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', path.join(directory, asset.originalFile),
      '-ss', String(source.start / 1000), '-t', String((source.end - source.start) / 1000), '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '192k', file], options);
    const duration = await audioDuration(file);
    if (Math.abs(duration - (source.end - source.start)) > 5 || (await stat(file)).size > 10 * 1024 * 1024) throw new Error('素材片段转换未完成');
    return await readFile(file);
  } finally { await unlink(file).catch(() => {}); }
}
