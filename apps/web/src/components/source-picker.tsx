import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MusicNotesIcon, MicrophoneIcon, UploadSimpleIcon, PlayIcon, PauseIcon, TrashIcon, ArrowCounterClockwiseIcon, XIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { emptyDraft, type CreativeSource, type Material, type Mode, type Track } from '../../../../packages/shared/src/index';
import { api, importAudio, formatTime } from '../lib/api';
import { Modal } from './modal';
import { Button } from './ui/button';
import { usePlayer } from './player';
import { WaveSelection } from './creative-tools';
import './library-tools.css';

function asTrack(asset: Material): Track {
  return { id: asset.id, jobId: '', providerId: '', title: asset.name, mode: 'instrumental', duration: asset.duration, model: '', lyrics: '', lyricsSections: null, favorite: false, deletedAt: null, createdAt: asset.createdAt, saveStatus: 'saved', saveError: null, playbackUrl: asset.playbackUrl, downloadUrl: `${asset.playbackUrl}?download=1`, hasFlac: false, hasWav: false, watermarked: false, lyricsUrl: null, timedLyricsUrl: null, input: emptyDraft('instrumental') };
}
export function SourcePicker({ mode, value, materials = [], disabled, onChange }: { mode: Mode; value?: CreativeSource | null; materials?: Material[]; disabled?: boolean; onChange: (source: CreativeSource | null) => void }) {
  const client = useQueryClient(); const player = usePlayer();
  const [open, setOpen] = useState(false); const [kind, setKind] = useState<'reference' | 'melody'>('reference');
  const [selection, setSelection] = useState<CreativeSource | null>(null); const [fresh, setFresh] = useState<Material | null>(null);
  const [uploading, setUploading] = useState(false); const uploadingRef = useRef(false); const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState<{ file: File; id: string } | null>(null); const [showRemoved, setShowRemoved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false); const [seconds, setSeconds] = useState(0); const recorder = useRef<MediaRecorder | null>(null);
  const [micPending, setMicPending] = useState(false); const micLock = useRef(false);
  const stream = useRef<MediaStream | null>(null); const recordingTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop(); stream.current?.getTracks().forEach(t => t.stop()); clearInterval(recordingTimer.current); }; }, []);
  const all = fresh && !materials.some(m => m.id === fresh.id) ? [fresh, ...materials] : materials;
  const selected = all.find(m => m.id === selection?.assetId && !m.deletedAt);
  const active = materials.find(m => m.id === value?.assetId && !m.deletedAt);
  function choose(asset: Material) {
    const minimum = kind === 'reference' ? 30000 : 5000;
    if (asset.duration < minimum) { setFailure(`这段素材不足 ${minimum / 1000} 秒，请选择更长的音频。`); return; }
    setSelection({ assetId: asset.id, kind, start: 0, end: kind === 'reference' ? 30000 : Math.min(60000, asset.duration) }); setFailure('');
  }
  async function upload(file: File, existingId?: string) {
    if (uploadingRef.current) return;
    if (file.size > 25 * 1024 * 1024) { setFailure('文件超过 25 MB，请选择较小的音频。'); return; }
    const entry = { file, id: existingId || crypto.randomUUID() }; setRetry(entry); setFailure(''); setUploading(true); uploadingRef.current = true;
    try { const asset = await importAudio(file, entry.id); if (!alive.current) return; setFresh(asset); choose(asset); setRetry(null); await client.invalidateQueries({ queryKey: ['snapshot'] }); toast.success('素材已保存在你的工作区，请选择要参考的片段'); }
    catch (error) { if (alive.current) setFailure((error as Error).message); }
    finally { uploadingRef.current = false; if (alive.current) setUploading(false); }
  }
  async function startRecording() {
    if (recording || uploading || recorder.current || micLock.current) return;
    micLock.current = true; setMicPending(true); setFailure(''); player.pause();
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error();
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { stream.current.getTracks().forEach(t => t.stop()); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error();
      const capture = new MediaRecorder(stream.current, { mimeType: mime }); recorder.current = capture;
      const chunks: BlobPart[] = []; const started = Date.now();
      capture.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      capture.onstop = () => {
        clearInterval(recordingTimer.current); stream.current?.getTracks().forEach(t => t.stop()); recorder.current = null;
        if (!alive.current) return; setRecording(false);
        if (Date.now() - started < 5000) { setFailure('录音不足 5 秒，请再哼唱一段，或导入已有录音。'); return; }
        const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        void upload(new File(chunks, `哼唱-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, { type: mime }));
      };
      capture.onerror = () => { capture.onstop = null; clearInterval(recordingTimer.current); stream.current?.getTracks().forEach(t => t.stop()); recorder.current = null; if (alive.current) { setRecording(false); setFailure('录音中断了，请重新录制，或导入已有录音。'); } };
      capture.start(); setRecording(true); setSeconds(0);
      recordingTimer.current = setInterval(() => { const elapsed = Math.floor((Date.now() - started) / 1000); setSeconds(elapsed); if (elapsed >= 60 && capture.state === 'recording') capture.stop(); }, 250);
    } catch { stream.current?.getTracks().forEach(t => t.stop()); recorder.current = null; if (alive.current) setFailure('暂时无法使用麦克风。请检查浏览器权限，或直接导入录音文件。'); }
    finally { micLock.current = false; if (alive.current) setMicPending(false); }
  }
  function begin(next: 'reference' | 'melody') { setKind(next); setSelection(value?.kind === next ? value : null); setFailure(''); setShowRemoved(false); setOpen(true); }
  return <section className="source-picker">
    <div className="label-row"><label>从一段声音获得灵感</label><span>选填</span></div>
    <div className="source-entry-buttons"><button type="button" disabled={disabled} onClick={() => begin('reference')}><MusicNotesIcon />参考曲</button>{mode === 'lyrics' && <button type="button" disabled={disabled} onClick={() => begin('melody')}><MicrophoneIcon />哼唱旋律</button>}</div>
    {value && <div className={`source-selected ${!active ? 'source-missing' : ''}`}><MusicNotesIcon /><div><strong>{active?.name || '素材已移除，请重新选择'}</strong><span>{value.kind === 'melody' ? '哼唱旋律' : '参考曲'} · {formatTime(value.start)}–{formatTime(value.end)}</span></div><button type="button" className="text-button" disabled={disabled} onClick={() => begin(value.kind)}>调整</button><button type="button" className="icon-button" aria-label="移除本次参考素材" disabled={disabled} onClick={() => onChange(null)}><XIcon /></button></div>}
    {!value && <p className="field-help">导入自己已有的音频，试听后选择最有感觉的一段。</p>}
    <Modal open={open} onOpenChange={next => { if (recording || uploading || micPending) return; if (!next && player.track?.id === selection?.assetId) player.pause(); setOpen(next); }} title={kind === 'melody' ? '把哼唱变成一首歌' : '选一段喜欢的音乐'} description={kind === 'melody' ? '选择 5–60 秒清晰的哼唱录音，再配上你的歌词。素材先保存在你的工作区。' : '选择 30 秒片段，用它传达想要的音乐风格。素材先保存在你的工作区。'} wide>
      <div className="material-import" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!recording && !micPending && event.dataTransfer.files[0]) void upload(event.dataTransfer.files[0]); }}>
        <UploadSimpleIcon size={27} /><strong>{uploading ? '正在读取音频并准备试听…' : '拖入音频，或从电脑里选择'}</strong><span>MP3 / M4A / WAV / FLAC / OGG / WebM · 最多 25 MB</span>
        <input ref={fileInput} className="sr-only" aria-label="导入音频文件" type="file" accept=".mp3,.m4a,.wav,.flac,.ogg,.webm" disabled={uploading || recording || micPending} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
        <Button type="button" className="secondary-button" disabled={uploading || recording || micPending} onClick={() => fileInput.current?.click()}>选择音频文件</Button>
        {kind === 'melody' && <Button type="button" className="secondary-button" disabled={uploading || micPending} onClick={() => recording ? recorder.current?.stop() : void startRecording()}><MicrophoneIcon />{recording ? `停止并保存 · ${seconds} 秒` : micPending ? '正在连接麦克风…' : '直接录一段哼唱'}</Button>}
        {recording && <span role="status">正在录音，最多 60 秒；至少录制 5 秒。</span>}
      </div>
      {failure && <div role="alert" className="notice warning">{failure}{retry && !uploading && <button type="button" onClick={() => void upload(retry.file, retry.id)}>重试本次导入</button>}</div>}
      <div className="material-list-heading"><h3>我的声音素材</h3><button type="button" className="text-button" onClick={() => setShowRemoved(!showRemoved)}>{showRemoved ? '查看可用素材' : '已移除的素材'}</button></div>
      <div className="material-list">{all.filter(asset => showRemoved ? asset.deletedAt : !asset.deletedAt).map(asset => <div className={`material-row ${selection?.assetId === asset.id ? 'selected' : ''}`} key={asset.id}>
        <button type="button" disabled={!!asset.deletedAt || uploading || recording || micPending} onClick={() => choose(asset)}><strong>{asset.name}</strong><span>{formatTime(asset.duration)}{kind === 'reference' && asset.duration < 30000 ? ' · 不足 30 秒，可用于哼唱' : ''}</span></button>
        <button type="button" className="icon-button" disabled={uploading || recording || micPending} aria-label={asset.deletedAt ? `恢复素材${asset.name}` : `移除素材${asset.name}`} onClick={async () => { try { await api(`/api/materials/${asset.id}`, { method: 'PATCH', body: { deleted: !asset.deletedAt } }); if (player.track?.id === asset.id) player.pause(); if (!asset.deletedAt && selection?.assetId === asset.id) setSelection(null); await client.invalidateQueries({ queryKey: ['snapshot'] }); } catch (error) { toast.error((error as Error).message); } }}>{asset.deletedAt ? <ArrowCounterClockwiseIcon /> : <TrashIcon />}</button>
      </div>)}{!all.filter(asset => showRemoved ? asset.deletedAt : !asset.deletedAt).length && <p className="field-help">{showRemoved ? '没有已移除的素材。' : '还没有素材。导入一次，就可以反复选段使用。'}</p>}</div>
      {selected && selection && !showRemoved && <div className="material-selection"><WaveSelection track={asTrack(selected)} start={selection.start} end={selection.end} fixedLength={kind === 'reference' ? 30 : undefined} minLength={5} maxLength={60} onChange={(start, end) => {
        const from = Math.max(0, Math.min(start, selected.duration - (kind === 'reference' ? 30000 : 5000)));
        setSelection({ ...selection, start: from, end: kind === 'reference' ? from + 30000 : Math.min(selected.duration, Math.max(from + 5000, Math.min(end ?? selection.end, from + 60000))) });
      }} /><div className="selection-controls"><label>片段开始（秒）<input type="number" min={0} max={(selected.duration - (kind === 'reference' ? 30000 : 5000)) / 1000} step={0.1} value={selection.start / 1000} onChange={event => { const start = Math.max(0, Math.min(Math.round(Number(event.target.value) * 1000), selected.duration - (kind === 'reference' ? 30000 : 5000))); setSelection({ ...selection, start, end: kind === 'reference' ? start + 30000 : Math.min(selected.duration, start + selection.end - selection.start) }); }} /></label>{kind === 'melody' && <label>片段结束（秒）<input type="number" min={(selection.start + 5000) / 1000} max={Math.min(selected.duration, selection.start + 60000) / 1000} step={0.1} value={selection.end / 1000} onChange={event => setSelection({ ...selection, end: Math.min(selected.duration, selection.start + 60000, Math.max(selection.start + 5000, Math.round(Number(event.target.value) * 1000))) })} /></label>}<Button type="button" className="secondary-button" onClick={() => player.track?.id === selected.id && player.playing ? player.pause() : player.audition(asTrack(selected), selection.start, selection.end)}>{player.track?.id === selected.id && player.playing ? <><PauseIcon />暂停试听</> : <><PlayIcon />试听片段</>}</Button></div><p className="field-help">已选 {((selection.end - selection.start) / 1000).toFixed(1)} 秒{kind === 'reference' ? '，拖动选区可更换位置。' : '，拖动两端可调整长度。'}</p></div>}
      <div className="material-footer"><span>点击开始创作时，所选片段才会提交至 Mureka。</span><Button type="button" className="primary-button" disabled={!selection || !selected || uploading || recording || micPending || showRemoved} onClick={() => { onChange(selection); player.pause(); setOpen(false); }}>使用这个片段</Button></div>
    </Modal>
  </section>;
}
