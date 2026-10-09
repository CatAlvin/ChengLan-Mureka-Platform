import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import Database from 'better-sqlite3';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/restore.mjs "path/to/chenglan-backup.zip"');
const root = fileURLToPath(new URL('..', import.meta.url));
const archive = await readFile(path.resolve(source));
if (archive.length > 310 * 1024 * 1024) throw new Error('This backup exceeds the 300 MB restore limit.');
let bytes = 0;
const entries = unzipSync(archive, { filter(file) {
  if (!/^(manifest\.json|chenglan\.sqlite|storage\/[0-9a-f-]{36}(\.trimmed-v[1-9]\d*|\.source|\.preview)?\.(mp3|wav|m4a|flac|ogg|webm|txt|lrc|mid|midi|musicxml|xml|pdf|json))$/.test(file.name)) throw new Error('The archive contains an unexpected path.');
  bytes += file.originalSize;
  if (bytes > 300 * 1024 * 1024) throw new Error('The expanded archive is too large.');
  return true;
} });
const manifest = JSON.parse(strFromU8(entries['manifest.json'] || new Uint8Array()));
if (manifest.app !== 'chenglan-music' || ![1, 2, 3, 4, 5, 6, 7, 8].includes(manifest.version) || !entries['chenglan.sqlite']) throw new Error('This is not a supported ChengLan backup.');
await mkdir(path.join(root, 'backups'), { recursive: true });
const destination = await mkdtemp(path.join(root, 'backups', 'restored-'));
await mkdir(path.join(destination, 'data'));
await mkdir(path.join(destination, 'storage'));
for (const [name, data] of Object.entries(entries)) {
  if (name === 'manifest.json') continue;
  const target = path.resolve(destination, name === 'chenglan.sqlite' ? 'data/chenglan.sqlite' : name);
  if (!target.startsWith(destination + path.sep)) throw new Error('Unsafe backup path.');
  await writeFile(target, data, { flag: 'wx' });
}
const database = new Database(path.join(destination, 'data/chenglan.sqlite'), { readonly: true });
try {
  database.pragma('trusted_schema = OFF');
  const version = database.pragma('user_version', { simple: true });
  if (database.pragma('quick_check', { simple: true }) !== 'ok' || ![1, 2, 3, 4, 5, 6, 7, 8].includes(version)) throw new Error('The backup database did not pass validation.');
  const rows = database.prepare(version === 1 ? 'SELECT local_file FROM tracks' : 'SELECT local_file, source_file, lyrics_file, timed_lyrics_file FROM tracks').all();
  if (version >= 4) rows.push(...database.prepare('SELECT original_file, preview_file FROM materials').all(), ...database.prepare('SELECT local_file, source_file, lyrics_file, timed_lyrics_file FROM audio_exports').all());
  if (version >= 3) for (const { result } of database.prepare('SELECT result FROM generation_jobs WHERE result IS NOT NULL').all()) {
    const files = JSON.parse(result).scoreFiles || [];
    if (!Array.isArray(files) || files.length > 32) throw new Error('Invalid score file records.');
    for (const file of files) {
      if (!/^[0-9a-f-]{36}$/.test(file.id) || !['mid','midi','musicxml','xml','pdf','json'].includes(file.format)) throw new Error('Invalid score file record.');
      rows.push({ score_file: `${file.id}.${file.format}` });
    }
  }
  for (const row of rows) {
    for (const file of Object.values(row).filter(Boolean)) {
      if (!entries[`storage/${file}`]) throw new Error('The backup is missing an audio or lyric file.');
    }
  }
} finally { database.close(); }
console.log(`Backup verified and extracted to: ${destination}`);
console.log('Stop ChengLan, keep copies of the current data/storage folders, then replace them with these recovered folders. Your API key stays separate.');
