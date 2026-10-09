import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { scoreFileSchema, type ScoreFile } from '../../../packages/shared/src/index.js';

// Downloads are treated as untrusted archives. Never use their paths on disk.
export function scoreEntries(archive: Uint8Array, midiOnly = false): [string, Uint8Array][] {
  let total = 0; let count = 0;
  const entries = unzipSync(archive, { filter(file) {
    if (++count > 64 || file.name.includes('\\') || file.name.startsWith('/') || file.name.split('/').some(p => p === '..' || p.includes(':') || Array.from(p).some(c => c.charCodeAt(0) < 32))) throw new Error('结果文件路径无效');
    total += file.originalSize;
    if (total > 100 * 1024 * 1024 || file.originalSize > 50 * 1024 * 1024) throw new Error('结果文件过大');
    return !file.name.startsWith('__MACOSX/') && (midiOnly ? /\.midi?$/i : /\.(musicxml|xml|pdf|json)$/i).test(file.name);
  } });
  const files = Object.entries(entries);
  if (!files.length || files.length > 32) throw new Error('压缩包没有可用结果文件');
  for (const [name, data] of files) {
    const format = path.posix.extname(name).slice(1).toLowerCase();
    if (!data.length) throw new Error('结果文件为空');
    if (/^midi?$/.test(format) && (data.length < 14 || Buffer.from(data.subarray(0, 4)).toString() !== 'MThd')) throw new Error('MIDI 文件无效');
    if (format === 'pdf' && !Buffer.from(data.subarray(0, 1024)).toString().includes('%PDF-')) throw new Error('PDF 文件无效');
    if (format === 'xml' || format === 'musicxml') {
      const text = Buffer.from(data).toString('utf8');
      if (!/<score-(partwise|timewise)(\s|>)/.test(text) || /<!ENTITY/i.test(text)) throw new Error('MusicXML 文件无效');
    }
    if (format === 'json') JSON.parse(Buffer.from(data).toString('utf8'));
  }
  if (!midiOnly && !files.some(([name]) => /\.(musicxml|xml|pdf)$/i.test(name))) throw new Error('压缩包没有乐谱');
  return files;
}

export function scoreFilename(file: ScoreFile): string {
  const parsed = scoreFileSchema.parse(file);
  return `${parsed.id}.${parsed.format}`;
}

export async function saveScoreEntries(entries: [string, Uint8Array][], directory: string, jobId: string): Promise<ScoreFile[]> {
  const files: ScoreFile[] = [];
  for (const [name, data] of entries) {
    const hash = createHash('sha256').update(jobId).update('\0').update(name).digest('hex');
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const file = scoreFileSchema.parse({ id, name: path.posix.basename(name).slice(0, 120), format: path.posix.extname(name).slice(1).toLowerCase(), bytes: data.byteLength });
    const target = path.join(directory, scoreFilename(file));
    const temporary = path.join(directory, `${id}.${randomUUID()}.part`);
    try { await writeFile(temporary, data, { flag: 'wx' }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => {}); }
    files.push(file);
  }
  return files;
}
