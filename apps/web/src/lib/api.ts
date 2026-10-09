import type { CreativeInput, Snapshot } from '../../../../packages/shared/src/index';
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
let token: string | null = null;
let session: Promise<void> | null = null;
export type SessionUser = { id: string; username: string; displayName: string; role: 'user' | 'admin'; disabled: boolean; mustChangePassword: boolean; createdAt: number; lastLoginAt: number | null };
export type SessionInfo = { user: SessionUser | null; hosted: boolean; csrfToken: string };
let currentSession: SessionInfo | null = null;
export const storageKey = (key: string) => `chenglan:${currentSession?.user?.id || 'guest'}:${key}`;
export async function readSession(refresh = false) { if (refresh) { token = null; session = null; } await connect(); return currentSession!; }
export function clearPrivateCache() {
  const prefix = `chenglan:${currentSession?.user?.id}:`;
  for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
  currentSession = null; token = null; session = null;
}
export async function connect() {
  if (!session) session = fetch('/api/session', { credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('工作台暂时没有响应，请稍后重试。');
    currentSession = await response.json(); token = currentSession!.csrfToken;
  }).catch(error => { session = null; throw error; });
  return session;
}
export async function api<T>(url: string, options: { method?: string; body?: unknown; binary?: boolean } = {}): Promise<T> {
  await connect();
  const response = await fetch(url, {
    method: options.method || 'GET', credentials: 'same-origin',
    headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-CSRF-Token': token } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (currentSession?.user && response.headers.get('X-Chenglan-User') && response.headers.get('X-Chenglan-User') !== currentSession.user.id) {
    window.dispatchEvent(new Event('chenglan-auth-changed')); throw new Error('登录账户已切换，正在更新你的工作区。');
  }
  if (response.status === 401 || response.status === 428) { token = null; session = null; if (url !== '/api/auth/login') window.dispatchEvent(new Event('chenglan-auth-changed')); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({ message: '操作暂时未完成，请重试。' }));
    throw new ApiError(data.message || '操作暂时未完成，请重试。', response.status);
  }
  return options.binary ? await response.blob() as T : response.json();
}
export async function importAudio(file: File, id: string) {
  await connect();
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
  const name = file.name.length > 80 ? file.name.slice(0, 80 - extension.length) + extension : file.name;
  const query = new URLSearchParams({ id, name });
  const response = await fetch(`/api/materials?${query}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': token! }, body: file });
  if (response.status === 401 || response.status === 428 || (currentSession?.user && response.headers.get('X-Chenglan-User') && response.headers.get('X-Chenglan-User') !== currentSession.user.id)) { token = null; session = null; window.dispatchEvent(new Event('chenglan-auth-changed')); throw new Error('登录状态已改变，请重新选择素材。'); }
  if (!response.ok) { const json = await response.json().catch(() => ({ message: '素材导入未完成，请重试。' })); throw new ApiError(json.message, response.status); }
  return response.json() as Promise<import('../../../../packages/shared/src/index').Material>;
}
export async function uploadMusic(file: File, id: string, title: string, onProgress: (percent: number) => void) {
  await connect();
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
  const name = file.name.length > 80 ? file.name.slice(0, 80 - extension.length) + extension : file.name;
  const owner = currentSession?.user?.id;
  return new Promise<import('../../../../packages/shared/src/index').Track>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/tracks/import?${new URLSearchParams({ id, name, ...(title.trim() ? { title: title.trim() } : {}) })}`);
    request.timeout = 600000;
    request.setRequestHeader('Content-Type', 'application/octet-stream'); request.setRequestHeader('X-CSRF-Token', token!);
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    request.onerror = request.ontimeout = () => reject(new Error('上传连接中断，请重试同一个文件；已保存的音乐不会重复创建。'));
    request.onload = () => {
      if (currentSession?.user?.id !== owner || request.status === 401 || request.status === 428 || request.getResponseHeader('X-Chenglan-User') && request.getResponseHeader('X-Chenglan-User') !== owner) {
        token = null; session = null; window.dispatchEvent(new Event('chenglan-auth-changed')); reject(new Error('登录状态已改变，请重新登录后上传。')); return;
      }
      try {
        const data = JSON.parse(request.responseText);
        if (request.status < 200 || request.status >= 300) reject(new ApiError(data.message || '上传未完成，请重试。', request.status));
        else resolve(data);
      } catch { reject(new Error('服务器暂时没有返回完整结果，请重试同一次上传。')); }
    };
    request.send(file);
  });
}
// Keep saves ordered across form unmounts and rapid mode switches.
const draftSaves = new Map<string, Promise<unknown>>();
export function saveDraft(input: CreativeInput) {
  const owner = currentSession?.user?.id;
  const previous = draftSaves.get(input.mode) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => { if (!owner || owner !== currentSession?.user?.id) return; return api('/api/drafts', { method: 'PUT', body: input }); });
  draftSaves.set(input.mode, next);
  return next;
}
export const snapshotQuery = {
  queryKey: ['snapshot'], queryFn: () => api<Snapshot>('/api/snapshot'),
  refetchInterval: 2500, refetchIntervalInBackground: false, retry: 1,
};
export function formatTime(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
export function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
