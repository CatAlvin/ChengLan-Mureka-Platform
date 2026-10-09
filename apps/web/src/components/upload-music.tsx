import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { UploadSimpleIcon, MusicNotesIcon, CircleNotchIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { uploadMusic } from '../lib/api';
import { Modal } from './modal';
import { Button } from './ui/button';
import './upload-music.css';

export function UploadMusic() {
  const navigate = useNavigate(); const client = useQueryClient(); const picker = useRef<HTMLInputElement>(null); const lock = useRef(false);
  const [open, setOpen] = useState(false); const [entry, setEntry] = useState<{ file: File; id: string } | null>(null);
  const [title, setTitle] = useState(''); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0); const [error, setError] = useState('');
  function choose(file: File) {
    if (lock.current) return;
    if (!/\.(mp3|m4a|wav|flac|ogg|webm)$/i.test(file.name)) { setError('请选择 MP3、M4A、WAV、FLAC、OGG 或 WebM 音频。'); return; }
    if (!file.size || file.size > 100 * 1024 * 1024) { setError('请选择 100 MB 以内的非空音频文件。'); return; }
    setEntry({ file, id: crypto.randomUUID() }); setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 80)); setError(''); setProgress(0);
  }
  async function upload() {
    if (!entry || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setProgress(0);
    try {
      const track = await uploadMusic(entry.file, entry.id, title, setProgress);
      await client.invalidateQueries({ queryKey: ['snapshot'] });
      setOpen(false); setEntry(null); toast.success('音乐已保存，可以开始继续创作'); navigate(`/tools/${track.id}`);
    } catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <Button className="secondary-button" onClick={() => setOpen(true)}><UploadSimpleIcon />上传我的音乐</Button>
    <Modal open={open} onOpenChange={next => { if (!lock.current) setOpen(next); }} title="让自己的音乐，继续生长" description="整首上传到你的作品库，再选择续写、局部重唱、分轨或识别歌词。">
      <div className="music-upload-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) choose(file); }}>
        <MusicNotesIcon size={34} weight="duotone" /><strong>{entry ? entry.file.name : '选择手机或电脑里的音频'}</strong>
        <span>{entry ? `${(entry.file.size / 1024 / 1024).toFixed(1)} MB` : 'MP3 / M4A / WAV / FLAC / OGG / WebM'}</span>
        <input ref={picker} type="file" className="sr-only" aria-label="选择整首音乐文件" accept=".mp3,.m4a,.wav,.flac,.ogg,.webm" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) choose(file); event.target.value = ''; }} />
        <Button className="secondary-button" disabled={busy} onClick={() => picker.current?.click()}><UploadSimpleIcon />{entry ? '换一个文件' : '选择音频文件'}</Button>
      </div>
      <p className="field-help">最多 100 MB，时长 5 秒–10 分钟。原文件完整保留，只有你能查看；上传本身不调用付费创作接口。</p>
      {entry && <label className="tool-label">作品名称<input aria-label="上传作品名称" disabled={busy} maxLength={80} value={title} onChange={event => setTitle(event.target.value)} /></label>}
      {busy && <div className="music-upload-progress" role="status"><span>{progress < 100 ? `正在上传 ${progress}%` : '上传完成，正在准备试听…'}</span><progress value={progress} max={100} /><small>请保持此页面打开。保存完成后可以在任意设备继续使用。</small></div>}
      {error && <p className="notice warning" role="alert">{error}</p>}
      <div className="music-upload-actions"><Button className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>稍后再说</Button><Button className="primary-button" disabled={!entry || busy} onClick={() => void upload()}>{busy ? <CircleNotchIcon className="spin" /> : <UploadSimpleIcon />}{busy ? '正在保存…' : error && entry ? '重新上传并继续' : '上传并继续创作'}</Button></div>
    </Modal>
  </>;
}
