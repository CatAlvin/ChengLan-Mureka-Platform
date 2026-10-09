import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DownloadSimpleIcon, FolderPlusIcon, CheckCircleIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { Collection, Track } from '../../../../packages/shared/src/index';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Modal } from './modal';
import './library-tools.css';

export function CollectionSelect({ collections = [], value, onChange, disabled }: { collections?: Collection[]; value?: string | null; onChange: (id: string | null) => void; disabled?: boolean }) {
  return <label className="collection-field">保存到作品集<select aria-label="保存到作品集" disabled={disabled} value={value || ''} onChange={event => onChange(event.target.value || null)}><option value="">暂不分组</option>{collections.filter(c => !c.archivedAt || c.id === value).map(c => <option key={c.id} value={c.id} disabled={!!c.archivedAt}>{c.name}{c.archivedAt ? '（已归档，请重新选择）' : ''}</option>)}</select></label>;
}
export function CollectionManager({ collections = [], onCreated }: { collections?: Collection[]; onCreated?: (id: string) => void }) {
  const [open, setOpen] = useState(false); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const client = useQueryClient();
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);
  return <><button className="text-button" type="button" onClick={() => setOpen(true)}><FolderPlusIcon />管理作品集</button><Modal open={open} onOpenChange={setOpen} title="让音乐各有归处" description="按专辑、视频项目或心情整理作品。归档的作品集可以恢复，其中的音乐仍保留在作品库。">
    <label className="collection-field">新作品集名称<input aria-label="新作品集名称" value={name} maxLength={80} placeholder="例如：海边旅行 / 第一张专辑" disabled={busy || !!pending} onChange={event => setName(event.target.value)} /></label>
    <Button type="button" className="primary-button" disabled={busy || !name.trim()} onClick={async () => {
      const entry = pending || { id: crypto.randomUUID(), name: name.trim() }; setPending(entry); setBusy(true);
      try { await api('/api/collections', { method: 'POST', body: entry }); setPending(null); setName(''); await client.invalidateQueries({ queryKey: ['snapshot'] }); onCreated?.(entry.id); toast.success('作品集已创建'); }
      catch (error) { toast.error((error as Error).message); }
      finally { setBusy(false); }
    }}>{busy ? '正在创建…' : pending ? '确认上次创建' : '新建作品集'}</Button>
    <div className="collection-list">{collections.map(collection => <CollectionRow key={collection.id} collection={collection} />)}{!collections.length && <p className="field-help">给第一组音乐起个名字吧。</p>}</div>
  </Modal></>;
}
function CollectionRow({ collection }: { collection: Collection }) {
  const client = useQueryClient(); const [name, setName] = useState(collection.name); const [busy, setBusy] = useState(false);
  useEffect(() => setName(collection.name), [collection.name]);
  async function update(body: unknown) {
    setBusy(true);
    try { await api(`/api/collections/${collection.id}`, { method: 'PATCH', body }); await client.invalidateQueries({ queryKey: ['snapshot'] }); }
    catch (error) { toast.error((error as Error).message); } finally { setBusy(false); }
  }
  return <div className="collection-row"><input aria-label={`重命名作品集${collection.name}`} value={name} maxLength={80} onChange={event => setName(event.target.value)} disabled={busy} /><button type="button" className="text-button" disabled={busy || !name.trim() || name === collection.name} onClick={() => void update({ name })}>保存名称</button><button type="button" className="text-button" disabled={busy} onClick={() => void update({ archived: !collection.archivedAt })}>{collection.archivedAt ? '恢复' : '归档'}</button></div>;
}
export function ExportControls({ track }: { track: Track }) {
  const client = useQueryClient(); const [busy, setBusy] = useState<string | null>(null);
  if (track.deletedAt || (!track.hasFlac && !track.hasWav)) return null;
  return <div className="format-downloads"><h3>选择下载格式</h3><p>默认单独下载音频，可用的 WAV、FLAC 会自动保存。歌词可单独下载或打包下载。</p><div>{(['flac', 'wav'] as const).filter(format => format === 'flac' ? track.hasFlac : track.hasWav).map(format => {
    const output = track.exports?.find(e => e.format === format);
    return <section className="format-option" key={format}><div><strong>{format.toUpperCase()}</strong><span>{format === 'flac' ? '无损音频 · 文件更小' : '无损音频 · 方便剪辑'}</span></div>{output?.status === 'saved' && output.downloadUrl ? <><a className="secondary-link" href={output.downloadUrl} download><DownloadSimpleIcon />下载 {format.toUpperCase()}</a>{track.lyrics && <a className="text-button" href={`${output.downloadUrl}?bundle=1`} download aria-label={`打包下载 ${format.toUpperCase()} 与歌词`}>含歌词打包</a>}</> : <Button type="button" className="secondary-button" disabled={busy === format || output?.status === 'saving' || track.saveStatus !== 'saved' || !!track.deletedAt} onClick={async () => {
      setBusy(format); try { await api(`/api/tracks/${track.id}/exports`, { method: 'POST', body: { format } }); await client.invalidateQueries({ queryKey: ['snapshot'] }); } catch (error) { toast.error((error as Error).message); } finally { setBusy(null); }
    }}>{busy === format || output?.status === 'saving' ? '自动保存中…' : output?.status === 'save_failed' ? '重新保存' : `保存 ${format.toUpperCase()}`}</Button>}{output?.error && <p role="status" className="format-error">{output.error}</p>}{output?.status === 'saved' && <span className="format-saved"><CheckCircleIcon /> 已保存在你的工作区</span>}</section>;
  })}</div></div>;
}
