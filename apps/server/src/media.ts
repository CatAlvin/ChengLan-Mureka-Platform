import { Agent, fetch } from 'undici';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { open, rename, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function validateMediaUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('不支持的媒体地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !publicAddress(host))) throw new Error('不允许访问本机或内网媒体地址');
  return url;
}
const agent = new Agent({ connect: {
  lookup(hostname, options, callback) {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 4);
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return callback(new Error('不允许下载内网资源'), '', 4);
      // Validate the actual DNS result used for this connection to avoid a second lookup.
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  },
} });
const MAX_BYTES = 150 * 1024 * 1024;
export type SavedMedia = { filename: string; contentType: string; bytes: number };
export type Downloader = (url: string, directory: string, id: string) => Promise<SavedMedia>;

async function download(source: string, directory: string, id: string, archive = false): Promise<SavedMedia> {
  let url = validateMediaUrl(source);
  const signal = AbortSignal.timeout(180000);
  let response;
  for (let hop = 0; hop < 4; hop++) {
    response = await fetch(url, { dispatcher: agent, redirect: 'manual', signal, headers: { 'Accept-Encoding': 'identity' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('媒体重定向无效');
      url = validateMediaUrl(new URL(location, url).href);
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body) throw new Error('音频暂时无法下载，请稍后重新保存。');
  const size = Number(response.headers.get('content-length') || 0);
  if (size > MAX_BYTES) { await response.body.cancel(); throw new Error('文件超过本机单次保存上限 150 MB。'); }
  const type = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  if (!(archive ? ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(type) : type.startsWith('audio/') || type === 'application/octet-stream')) { await response.body.cancel(); throw new Error('返回内容不是可识别的媒体文件。'); }
  await mkdir(directory, { recursive: true });
  const extensions: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a' };
  let extension = extensions[type];
  if (!extension) { const candidate = path.extname(url.pathname).slice(1).toLowerCase(); extension = ['mp3', 'm4a', 'wav', 'flac'].includes(candidate) ? candidate : 'mp3'; }
  if (archive) extension = 'zip';
  const filename = `${id}.${extension}`;
  const temporary = path.join(directory, `${id}-${randomUUID()}.part`);
  const file = await open(temporary, 'wx');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) throw new Error('文件超过本机保存上限。');
      await file.writeFile(chunk);
    }
    if (bytes === 0 || (size && bytes !== size)) throw new Error('文件未完整下载，请重新保存。');
    await file.sync(); await file.close();
    await rename(temporary, path.join(directory, filename));
    return { filename, bytes, contentType: type === 'application/octet-stream' ? ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac' }[extension] || type) : type };
  } catch (error) {
    await file.close().catch(() => {}); await unlink(temporary).catch(() => {});
    throw error;
  }
}
export const downloadMedia: Downloader = (source, directory, id) => download(source, directory, id);
export const downloadArchive: Downloader = (source, directory, id) => download(source, directory, id, true);
