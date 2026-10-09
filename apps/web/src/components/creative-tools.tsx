import { CostHint } from './credits';
import { canUseCredits, quoteCredits } from '../../../../packages/shared/src/credits';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, ArrowRightIcon, DownloadSimpleIcon, PlayIcon, PauseIcon, WaveformIcon, PencilSimpleIcon, ScissorsIcon, StackIcon, SparkleIcon, CheckCircleIcon, MusicNotesIcon } from '@phosphor-icons/react';
import type WaveSurfer from 'wavesurfer.js';
import type { Region } from 'wavesurfer.js/dist/plugins/regions.js';
import { toast } from 'sonner';
import { trackTypes, toolInputSchema, toolRangeError, toolNames, statusNames, terminalStatuses, type ToolInput, type Track, type Snapshot, type Job } from '../../../../packages/shared/src/index';
import { api, ApiError, storageKey, downloadBlob, formatTime, formatDate } from '../lib/api';
import { Button } from './ui/button';
import { usePlayer } from './player';
import './creative-tools.css';

type Operation = ToolInput['operation'];
const choices = [
  { id: 'crop', title: '只留喜欢的一段', description: '自定义起止时间或保留时长', icon: ScissorsIcon },
  { id: 'extend', title: '把歌继续写下去', description: '延续旋律，添一个新的段落', icon: WaveformIcon },
  { id: 'region_edit', title: '改好其中一段', description: '选一段，换上更合适的歌词', icon: ScissorsIcon },
  { id: 'remix', title: '把整首重新唱', description: '以原曲为基础，替换整首歌词', icon: SparkleIcon },
  { id: 'stem', title: '拆开听，分别用', description: '提取人声、伴奏或乐器', icon: StackIcon },
  { id: 'track', title: '添一种新的声音', description: '按原曲生成人声、伴奏或乐器', icon: WaveformIcon },
  { id: 'transcribe', title: '把音乐变成乐谱', description: '保存 PDF 乐谱与 MusicXML', icon: MusicNotesIcon },
  { id: 'lyrics_extend', title: '帮我接下一句', description: '沿着你的歌词，继续找灵感', icon: PencilSimpleIcon },
  { id: 'recognize', title: '把歌词听出来', description: '识别演唱内容，生成同步歌词', icon: MusicNotesIcon },
  { id: 'describe', title: '读懂这首音乐', description: '了解曲风、乐器和音乐氛围', icon: SparkleIcon },
] as const;
const groups: { name: string; tools: Operation[] }[] = [
  { name: '剪辑与改编', tools: ['crop', 'extend', 'region_edit', 'remix'] },
  { name: '声音与配器', tools: ['stem', 'track'] },
  { name: '歌词与乐谱', tools: ['recognize', 'lyrics_extend', 'describe', 'transcribe'] },
];
const draftKey = (id: string) => storageKey(`chenglan-tools-v1-${id}`);
const pendingKey = (id: string) => storageKey(`chenglan-tools-pending-${id}`);
function readLocal(key: string): unknown { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function writeLocal(key: string, value: unknown) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* The current form remains usable if browser storage is unavailable. */ } }
function savedDrafts(track: Track): Partial<Record<Operation, ToolInput>> {
  const raw = readLocal(draftKey(track.id)); const valid: Partial<Record<Operation, ToolInput>> = {};
  if (raw && typeof raw === 'object') for (const value of Object.values(raw)) {
    // Empty lyrics are a valid in-progress draft, so temporarily satisfy the submit-only minimum.
    const draft = value && typeof value === 'object' ? { ...value, ...('lyrics' in value && value.lyrics === '' ? { lyrics: 'draft' } : {}), ...('prompt' in value && value.prompt === '' ? { prompt: 'draft' } : {}) } : value;
    const parsed = toolInputSchema.safeParse(draft);
    if (parsed.success && parsed.data.sourceTrackId === track.id) valid[parsed.data.operation] = value as ToolInput;
  }
  return valid;
}
function defaultInput(track: Track, operation: Operation): ToolInput {
  const base = { sourceTrackId: track.id, title: '' };
  if (operation === 'crop') return { ...base, operation, start: 0, end: track.duration };
  if (operation === 'extend') return { ...base, operation, at: Math.max(1, Math.round(track.duration - Math.min(10000, track.duration / 2))), direction: 'tail', lyrics: '' };
  if (operation === 'region_edit') { const start = Math.min(12000, Math.floor(track.duration / 4)); return { ...base, operation, start, end: Math.min(start + 15000, track.duration - start), lyrics: '' }; }
  if (operation === 'remix') return { ...base, operation, lyrics: '', prompt: '' };
  if (operation === 'stem') return { ...base, operation, preset: 'vocals' };
  if (operation === 'track') return { ...base, operation, generateType: 'Guitar', prompt: '', lyrics: '', vocalGender: 'auto', start: 0, end: track.duration };
  if (operation === 'lyrics_extend') return { ...base, operation, lyrics: track.lyrics };
  return { ...base, operation };
}

export function CreativeTools({ snapshot }: { snapshot?: Snapshot }) {
  const { trackId } = useParams();
  if (!snapshot) return <div className="page"><p>正在找回作品…</p></div>;
  const track = snapshot.tracks.find(t => t.id === trackId && !t.deletedAt);
  if (!track) return <div className="page"><h1>选择一首作品，继续创作</h1><p className="tool-intro">打开作品详情，就能进入续写、改词和分轨工具。</p><Link className="secondary-link" to="/library">去我的作品 <ArrowRightIcon /></Link></div>;
  if (!track.playbackUrl) return <div className="page"><h1>{track.title}</h1><p className="tool-intro">这首作品还未保存完整，请先在作品库完成保存。</p><Link to="/library">回到我的作品</Link></div>;
  return <ToolWorkspace key={track.id} track={track} snapshot={snapshot} />;
}

function ToolWorkspace({ track, snapshot }: { track: Track; snapshot: Snapshot }) {
  const client = useQueryClient(); const player = usePlayer();
  useEffect(() => { window.scrollTo(0, 0); }, [track.id]);
  const [operation, setOperation] = useState<Operation>('crop');
  const [drafts, setDrafts] = useState(() => savedDrafts(track));
  const input = drafts[operation] || defaultInput(track, operation);
  const currentGroup = groups.find(group => group.tools.includes(operation))!;
  const groupChoices = currentGroup.tools.map(id => choices.find(choice => choice.id === id)!);
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ submissionId: string; tool: ToolInput } | null>(() => {
    const raw = readLocal(pendingKey(track.id)) as { submissionId?: string; tool?: unknown } | null;
    const parsed = toolInputSchema.safeParse(raw?.tool);
    return raw && typeof raw.submissionId === 'string' && /^[0-9a-f-]{36}$/.test(raw.submissionId) && parsed.success && parsed.data.sourceTrackId === track.id ? { submissionId: raw.submissionId, tool: parsed.data } : null;
  });
  const [undoLyrics, setUndoLyrics] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<string | null>(null);
  const [comparison, setComparison] = useState<string>('');
  const related = snapshot.tracks.filter(t => t.parentTrackId === track.id && !t.deletedAt);
  const jobs = snapshot.jobs.filter(j => j.tool?.sourceTrackId === track.id);
  const failedRegion = jobs.find(j => j.kind === 'region_edit' && j.status === 'failed' && j.tool?.operation === 'region_edit');
  const lyricJob = jobs.find(j => j.kind === 'lyrics_extend' && j.result);
  const recognized = jobs.find(j => j.kind === 'recognize' && j.status === 'succeeded' && j.result);
  const described = jobs.find(j => j.kind === 'describe' && j.status === 'succeeded' && j.result);
  const [savingLyrics, setSavingLyrics] = useState(false);
  const versions = related.filter(t => t.operation !== 'stem');
  const compared = versions.find(t => t.id === comparison) || versions[0];
  useEffect(() => { writeLocal(draftKey(track.id), drafts); }, [drafts, track.id]);
  useEffect(() => { if (pending) setOperation(pending.tool.operation); }, [pending]);
  useEffect(() => { if (pending && snapshot.jobs.some(j => j.submissionId === pending.submissionId)) { setPending(null); writeLocal(pendingKey(track.id), null); } }, [pending, snapshot.jobs, track.id]);
  function change(patch: Record<string, unknown>) { setDrafts(prev => ({ ...prev, [operation]: { ...input, ...patch } as ToolInput })); setError(''); }
  async function submit() {
    if (lock.current) return;
    const parsed = toolInputSchema.safeParse(pending?.tool || input);
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    const rangeError = toolRangeError(parsed.data, track.duration);
    if (rangeError && !pending) { setError(rangeError); return; }
    const envelope = pending || { submissionId: crypto.randomUUID(), tool: parsed.data };
    lock.current = true; setBusy(true); setError(''); setPending(envelope); writeLocal(pendingKey(track.id), envelope);
    try {
      await api<Job>('/api/tools', { method: 'POST', body: envelope });
      setPending(null); writeLocal(pendingKey(track.id), null);
      toast.success(`${toolNames[envelope.tool.operation]}已排好队，结果会留在这首歌的创作记录中`);
      await client.invalidateQueries({ queryKey: ['snapshot'] });
    } catch (failure) {
      setError((failure as Error).message);
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 409) { setPending(null); writeLocal(pendingKey(track.id), null); }
    } finally { lock.current = false; setBusy(false); }
  }
  const selectedStart = input.operation === 'region_edit' || input.operation === 'crop' || input.operation === 'track' ? input.start : input.operation === 'extend' ? input.at : 0;
  const selectedEnd = input.operation === 'region_edit' || input.operation === 'crop' || input.operation === 'track' ? input.end : undefined;
  const unavailable = input.operation === 'transcribe' && (track.duration < 10000 || track.duration > 600000) || input.operation === 'region_edit' && track.duration < 6000 || input.operation === 'extend' && track.duration <= 1 || input.operation === 'remix' && (track.duration < 10000 || track.duration > 350000 || track.mode === 'instrumental');
  function auditionSource() { player.audition(track, Math.max(0, selectedStart - (input.operation === 'extend' ? 5000 : 0)), selectedEnd ?? (input.operation === 'extend' ? Math.min(track.duration, selectedStart + 5000) : undefined)); }
  const currentChoice = choices.find(c => c.id === operation)!;
  return <div className="page tools-page">
    <Link to="/library" className="tool-back"><ArrowLeftIcon /> 我的作品</Link>
    <div className="page-heading"><div><div className="eyebrow">让喜欢的旋律，再往前一步</div><h1>继续创作<span>。</span></h1><p>从「{track.title}」出发，慢慢打磨你的音乐。</p></div><span className="subtle-pill"><CheckCircleIcon /> 每次创作，保留一个新版本</span></div>
    <div className="tool-source"><span className="section-icon blue"><WaveformIcon /></span><div><strong>{track.title}</strong><span>{formatTime(track.duration)} · {track.operation === 'crop' ? '裁剪片段 · 来源作品已保留' : track.origin === 'uploaded' ? '本地上传 · 原文件已保留' : track.stemName || '当前作品'}</span></div><button className="text-button" onClick={() => player.play(track)}>{player.track?.id === track.id && player.playing ? <PauseIcon /> : <PlayIcon />}{player.track?.id === track.id && player.playing ? '暂停' : '听听原曲'}</button><a className="icon-button" href={track.originalUrl || `/media/${track.id}?download=1`} download title="下载原曲音频" aria-label="下载原曲音频"><DownloadSimpleIcon /></a></div>
    <div className="tool-groups" role="group" aria-label="工具分类">{groups.map(group => <button key={group.name} aria-pressed={currentGroup === group} disabled={busy || !!pending} onClick={() => { setOperation(group.tools[0]); setError(''); }}>{group.name}<small>{group.tools.length}</small></button>)}</div>
    <div className="tool-choices" role="tablist" aria-label="后续创作工具">{groupChoices.map((choice, index) => <button key={choice.id} id={`tab-${choice.id}`} role="tab" tabIndex={operation === choice.id ? 0 : -1} aria-selected={operation === choice.id} aria-controls="creative-tool-panel" disabled={busy || !!pending} onKeyDown={event => { const next = event.key === 'ArrowRight' ? (index + 1) % groupChoices.length : event.key === 'ArrowLeft' ? (index - 1 + groupChoices.length) % groupChoices.length : event.key === 'Home' ? 0 : event.key === 'End' ? groupChoices.length - 1 : -1; if (next < 0) return; event.preventDefault(); const id = groupChoices[next].id; setOperation(id); setError(''); requestAnimationFrame(() => document.getElementById(`tab-${id}`)?.focus()); }} onClick={() => { setOperation(choice.id); setError(''); }}><choice.icon size={24} /><strong>{choice.title}</strong><span>{choice.description}</span></button>)}</div>
    <div className="tool-layout"><section className="tool-editor" id="creative-tool-panel" role="tabpanel" aria-labelledby={`tab-${operation}`}>
      <div className="tool-section-heading"><span className="section-icon orange"><currentChoice.icon /></span><div><h2>{toolNames[operation]}</h2><p>{operation === 'crop' ? '拖动选区或填写秒数，把喜欢的片段另存为新作品。' : operation === 'extend' ? '选择接续的位置，再写下新段落的歌词。' : operation === 'region_edit' ? '圈出想改变的片段，让这一段重新唱。' : operation === 'remix' ? '参考整首原曲，填写完整新歌词和演唱风格，生成一个重制版本。' : operation === 'track' ? '选一段参考原曲，描述想加入的声音，另存为一条新音轨。' : operation === 'transcribe' ? '把旋律保存成可以阅读、打印和继续编辑的乐谱。' : operation === 'stem' ? '把声音分开保存，让音乐有更多用法。' : operation === 'recognize' ? '从音乐里找回歌词，再按时间定位片段。' : operation === 'describe' ? '听懂曲风、乐器和情绪，留下新的创作灵感。' : '写几句作为开头，看看下一句会去哪里。'}</p></div></div>
      <fieldset className="tool-fields" disabled={busy || !!pending}>
      {input.operation === 'track' && <><label className="tool-label">想生成哪种声音<select aria-label="单轨类型" value={input.generateType} onChange={event => change({ generateType: event.target.value })}>{Object.entries(trackTypes).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><p className="tool-help">伴奏适合参考清晰人声；人声适合参考伴奏。每次生成一条新音轨。</p></>}
      {(input.operation === 'extend' || input.operation === 'region_edit' || input.operation === 'crop' || input.operation === 'track') && <>
        <WaveSelection track={track} start={selectedStart} end={selectedEnd} minLength={input.operation === 'crop' || input.operation === 'track' ? 0.1 : 3} onChange={(start, end) => change(input.operation === 'extend' ? { at: start } : { start, end: end ?? input.end })} />
        <div className="selection-controls">{input.operation === 'extend' ? <TimeField label="从这里接续（秒）" value={input.at} max={track.duration - 1} onChange={at => change({ at })} /> : <><TimeField label="片段开始（秒）" value={input.start} max={track.duration} onChange={start => change({ start })} /><TimeField label="片段结束（秒）" value={input.end} max={track.duration} onChange={end => change({ end })} /></>}
          <Button className="secondary-button" onClick={auditionSource}><PlayIcon />{input.operation === 'extend' ? '试听接续处' : '试听选中片段'}</Button>
        </div>
        {input.operation === 'crop' && <div className="selection-controls crop-duration"><TimeField label="保留时长（秒）" value={Math.max(0, input.end - input.start)} max={track.duration - input.start} onChange={duration => change({ end: input.start + duration })} /><button className="text-button" onClick={() => change({ start: 0, end: track.duration })}>恢复整首选区</button></div>}
        <p className="tool-help">{input.operation === 'crop' ? `保留 ${Math.max(0, (input.end - input.start) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} 秒 · 最短 0.1 秒，原曲完整保留。同步歌词会跟随片段调整，已有 WAV/FLAC 文件也会一起裁剪。` : input.operation === 'region_edit' ? `已选 ${((input.end - input.start) / 1000).toFixed(1)} 秒 · 选段至少 3 秒，另保留至少 3 秒原曲；建议前后都留出衔接段落。` : '拖动橙色标记定位，也可以直接填写秒数。'}</p>
        {input.operation === 'region_edit' && <button className="text-button" onClick={() => { setDrafts(prev => ({ ...prev, remix: { sourceTrackId: track.id, operation: 'remix', title: input.title, lyrics: input.lyrics, prompt: '' } })); setOperation('remix'); setError(''); }}>要替换整首歌词？改用整首重制 <ArrowRightIcon /></button>}
        {input.operation === 'extend' && <div className="tool-direction" role="group" aria-label="续写方向"><button className={input.direction === 'tail' ? 'selected' : ''} onClick={() => change({ direction: 'tail' })}>向后续写<span>保留选点之前，接着唱下去</span></button><button className={input.direction === 'head' ? 'selected' : ''} onClick={() => change({ direction: 'head' })}>补写开头<span>保留选点之后，补一个开篇</span></button></div>}
        <TimedLyrics track={track} onSelect={(start, end, text) => { if (input.operation === 'extend') change({ at: Math.min(track.duration - 1, Math.max(1, start)) }); else if (input.operation === 'crop') change({ start: Math.max(0, Math.min(start, track.duration - 100)), end: Math.min(track.duration, Math.max(start + 100, end)) }); else change({ start: Math.max(0, Math.min(start, track.duration - 3000)), end: Math.min(track.duration, Math.max(start + 3000, end)), lyrics: text }); }} />
      </>}
      {'lyrics' in input && (input.operation !== 'track' || input.generateType === 'Vocals') && <label className="tool-label">{operation === 'lyrics_extend' ? '已经写好的歌词' : operation === 'remix' ? '整首新歌词' : '这一段想唱的歌词'}<textarea aria-label={operation === 'lyrics_extend' ? '已经写好的歌词' : operation === 'remix' ? '整首新歌词' : '这一段想唱的歌词'} value={input.lyrics} maxLength={operation === 'lyrics_extend' ? 8000 : operation === 'remix' || operation === 'track' ? 5000 : 3000} rows={operation === 'lyrics_extend' || operation === 'remix' ? 12 : 7} placeholder={operation === 'lyrics_extend' ? '粘贴已有歌词，让 AI 顺着你的思路接下一句…' : '[Verse]\n把这一刻的心情，写进新的旋律里…'} onChange={event => change({ lyrics: event.target.value })} /><span className="tool-help">{input.lyrics.length} / {operation === 'lyrics_extend' ? 8000 : operation === 'remix' || operation === 'track' ? 5000 : 3000} 字{operation === 'lyrics_extend' ? ' · 每次接写下一句，采用后可以继续接写。' : operation === 'remix' ? ' · 填写完整歌词，重制结果的时长和旋律由 AI 决定。' : ' · 填写这个新段落的歌词即可。'}</span></label>}
      {input.operation === 'track' && <><label className="tool-label">声音风格<textarea aria-label="声音风格" value={input.prompt} maxLength={1024} rows={3} placeholder="例如：温暖的木吉他指弹，节奏轻柔，与原曲旋律呼应。" onChange={event => change({ prompt: event.target.value })} /><span className="tool-help">{input.prompt.length} / 1024 字</span></label>{input.generateType === 'Vocals' && <label className="tool-label">人声偏好<select aria-label="人声偏好" value={input.vocalGender} onChange={event => change({ vocalGender: event.target.value })}><option value="auto">交给 AI</option><option value="female">女声</option><option value="male">男声</option></select></label>}</>}
      {input.operation === 'remix' && <label className="tool-label">重制风格与演唱方式<textarea aria-label="重制风格与演唱方式" value={input.prompt} maxLength={1024} rows={3} placeholder="例如：保留原曲的古风氛围，男声有力量，副歌层次更鲜明。" onChange={event => change({ prompt: event.target.value })} /><span className="tool-help">{input.prompt.length} / 1024 字 · 参考歌曲支持 10–350 秒，每次生成 1 首。</span></label>}
      {input.operation === 'lyrics_extend' && undoLyrics !== null && <button className="text-button" onClick={() => { change({ lyrics: undoLyrics }); setUndoLyrics(null); setAdopted(null); }}>撤销上次采用</button>}
      {input.operation === 'stem' && <div className="stem-options" role="radiogroup" aria-label="分轨方式">{[{ value: 'vocals', title: '人声 + 伴奏', hint: '适合练唱、做伴奏，或单独听人声。', badge: '日常首选' }, { value: 'band', title: '人声 + 乐器分轨', hint: '最多 5 条：人声、伴奏、鼓组、贝斯、其他乐器。', badge: '细听编曲' }, { value: 'detailed', title: '精细乐器 + MIDI', hint: '最多 12 条乐器音轨，并保存接口返回的 MIDI。', badge: '继续编曲' }].map(option => <button key={option.value} role="radio" aria-checked={input.preset === option.value} className={input.preset === option.value ? 'selected' : ''} onClick={() => change({ preset: option.value })}><span className="stem-radio" /><div><strong>{option.title}<small>{option.badge}</small></strong><p>{option.hint}</p></div></button>)}<p className="tool-help">WAV 音轨可逐条试听和下载；人声 + 伴奏与精细分轨会同步保存接口返回的 MIDI。实际音轨和 MIDI 以返回结果为准。</p></div>}
      {input.operation === 'transcribe' && <p className="analysis-description">适合人声清晰、节奏稳定的旋律。支持 10 秒至 10 分钟；完成后分别下载 PDF、MusicXML 和接口返回的歌词 JSON。需要 MIDI？在「声音与配器」中选择精细分轨。</p>}
      {input.operation === 'recognize' && <p className="analysis-description">听一遍整首音乐，整理出歌词和对应时间。完成后可以先预览，再采用到作品中；纯音乐可能没有可识别的歌词。</p>}
      {input.operation === 'describe' && <p className="analysis-description">分析整首音乐的曲风、乐器与氛围。结果可以复制，也可以带回工作台，作为下一首歌的创作灵感。</p>}
      {!['lyrics_extend', 'recognize', 'describe'].includes(input.operation) && <label className="tool-label">给这次创作起个名字 <span className="tool-optional">选填</span><input aria-label="新版本名称" value={input.title} maxLength={operation === 'transcribe' ? 50 : 80} placeholder={`${track.title} · ${toolNames[operation]}`} onChange={event => change({ title: event.target.value })} /></label>}
      </fieldset>
      {error && <div role="alert" className="notice warning">{error}</div>}
      {pending && !busy && <div className="notice warning">这次提交尚未确认。点击下方按钮核对同一次请求，原有内容已保留。<Link to="/tasks">查看记录</Link></div>}
      {unavailable && <p className="notice warning">{input.operation === 'transcribe' ? '音乐转谱支持 10 秒至 10 分钟，请选择合适作品或先裁剪。' : input.operation === 'remix' ? '整首重制支持 10–350 秒的含人声歌曲，请选择合适作品或先裁剪。' : '这段音频太短，请选择更长的作品。'}</p>}
      <CostHint quote={quoteCredits(operation, {mode: track.mode, count: 1}, input)} balance={snapshot.credits} />
      <div className="tool-submit"><p>{operation === 'crop' ? '裁剪免费。片段自动保存到我的作品，原曲随时可以回听。' : '按 Mureka 实际使用计费，完成后自动保存到你的工作区。'}</p><Button className="primary-button" disabled={busy || unavailable || !pending && !canUseCredits(snapshot.credits, quoteCredits(operation, {mode: track.mode, count: 1}, input))} onClick={() => void submit()}>{operation === 'crop' ? <ScissorsIcon /> : <SparkleIcon />}{busy ? '正在提交…' : pending ? '核对这次提交' : operation === 'crop' ? '保存裁剪片段' : operation === 'lyrics_extend' ? '接写下一句' : operation === 'transcribe' ? '开始音乐转谱' : operation === 'track' ? '生成新音轨' : operation === 'stem' ? '开始分离音轨' : operation === 'recognize' ? '开始识别歌词' : operation === 'describe' ? '开始分析音乐' : '生成新版本'}</Button></div>
    </section>
    <aside className="tool-results"><section className="tool-result-card"><div className="section-heading"><h2>这首歌的创作记录</h2><Link to="/tasks">全部 <ArrowRightIcon /></Link></div>
      {failedRegion?.tool?.operation === 'region_edit' && <button className="text-button" disabled={busy || !!pending} onClick={() => {
        const tool = failedRegion.tool;
        if (tool?.operation !== 'region_edit') return;
        setDrafts(prev => ({ ...prev, remix: { operation: 'remix', sourceTrackId: track.id, title: tool.title, lyrics: tool.lyrics, prompt: '' } })); setOperation('remix'); setError('');
      }}>用已保存的歌词整首重制 <ArrowRightIcon /></button>}
      {!jobs.length && <div className="tool-result-empty"><StackIcon size={35} /><strong>下一版，就从这里开始</strong><p>新版本、分轨和歌词灵感，都会留在这首歌旁边。</p></div>}
      <div className="tool-job-list">{jobs.map(job => <div className="tool-job" key={job.id}><div><strong>{toolNames[job.tool!.operation]}</strong><span className={`status-badge ${job.status === 'succeeded' ? 'success' : ''}`}>{statusNames[job.status]}</span></div><small>{formatDate(job.createdAt)} · {job.input.title}</small>{job.error && <p className="tool-job-error">{job.error}</p>}{!terminalStatuses.includes(job.status) && <p>可以离开此页，任务会继续处理。</p>}{job.status === 'submission_unknown' && <Link to="/tasks">去核实提交 <ArrowRightIcon /></Link>}{job.status === 'save_failed' && <button className="text-button" onClick={async () => { try { await api(`/api/jobs/${job.id}/save`, { method: 'POST' }); await client.invalidateQueries({ queryKey: ['snapshot'] }); } catch (failure) { toast.error((failure as Error).message); } }}>{job.kind === 'crop' ? '重新裁剪' : job.kind === 'transcribe' ? '重新保存乐谱' : '重新保存分轨'}</button>}{job.kind === 'stem' && job.status === 'succeeded' && <a className="text-button" href={`/api/jobs/${job.id}/download`}><DownloadSimpleIcon />打包下载音轨</a>}</div>)}</div>
    </section>
    {jobs.filter(job => job.status === 'succeeded' && ['stem', 'transcribe'].includes(job.kind)).map(job => <section key={job.id} className="tool-result-card"><h2>{job.kind === 'transcribe' ? '你的乐谱' : '可继续编辑的 MIDI'}</h2><p className="tool-help">{job.input.title} · {formatDate(job.createdAt)}</p>{job.result?.scoreFiles?.length ? <div className="score-file-list">{job.result.scoreFiles.map(file => <a key={file.id} href={`/api/jobs/${job.id}/files/${file.id}`} download><MusicNotesIcon /><span><strong>{file.name}</strong><small>{file.format.toUpperCase()} · {(file.bytes / 1024).toFixed(1)} KB</small></span><DownloadSimpleIcon /></a>)}</div> : <p className="tool-help">这次分轨没有返回 MIDI，已保存的音轨可以直接试听和下载。</p>}</section>)}
    {recognized?.result && <section className="tool-result-card"><h2>听出来的歌词</h2><p className="tool-help">采用后会保存 TXT 和同步 LRC 歌词，并可按歌词定位片段。</p><div className="recognition-text">{recognized.result.lyrics || '没有识别到歌词。这可能是一段纯音乐。'}</div><div className="tool-result-actions"><Button className="secondary-button" disabled={savingLyrics || !recognized.result.lyrics || adopted === recognized.id} onClick={async () => {
      setSavingLyrics(true);
      try { await api(`/api/tracks/${track.id}/lyrics/adopt`, { method: 'POST', body: { jobId: recognized.id } }); await client.invalidateQueries({ queryKey: ['snapshot'] }); setAdopted(recognized.id); toast.success('歌词已保存到这首作品'); }
      catch (failure) { toast.error((failure as Error).message); }
      finally { setSavingLyrics(false); }
    }}>{savingLyrics ? '正在保存…' : adopted === recognized.id ? '已采用' : track.lyrics ? '替换为识别歌词' : '采用并保存歌词'}</Button>{recognized.result.lyrics && <button className="text-button" onClick={() => downloadBlob(new Blob([recognized.result!.lyrics], { type: 'text/plain;charset=utf-8' }), `${track.title}.txt`)}><DownloadSimpleIcon />TXT</button>}{recognized.result.timedLyrics && <button className="text-button" onClick={() => downloadBlob(new Blob([recognized.result!.timedLyrics!], { type: 'text/plain;charset=utf-8' }), `${track.title}.lrc`)}>LRC</button>}</div></section>}
    {described?.result?.description && <section className="tool-result-card"><h2>这首音乐的模样</h2><div className="analysis-tags">{[...(described.result.genres || []), ...(described.result.instruments || []), ...(described.result.tags || [])].map((tag, index) => <span key={index}>{tag}</span>)}</div><p className="analysis-description">{described.result.description}</p><div className="tool-result-actions"><button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(described.result!.description!); toast.success('音乐描述已复制'); } catch { toast.error('暂时无法复制，请保存分析文件。'); } }}>复制描述</button><button className="text-button" onClick={() => downloadBlob(new Blob([JSON.stringify(described.result, null, 2)], { type: 'application/json;charset=utf-8' }), `${track.title}-音乐分析.json`)}><DownloadSimpleIcon />保存分析</button><Link className="text-button" to="/" state={{ input: { ...track.input, title: '', lyrics: '', source: null, prompt: described.result.description.slice(0, 1800), mode: 'easy', styles: [], mood: '', count: 1 } }}>用它开始一首新歌 <ArrowRightIcon /></Link></div></section>}
    {lyricJob?.result && <section className="tool-result-card"><h2>下一句灵感</h2><blockquote>{lyricJob.result.lyrics}</blockquote><div className="tool-result-actions"><Button className="secondary-button" disabled={!!pending || busy || adopted === lyricJob.id} onClick={() => {
      const current = drafts.lyrics_extend || defaultInput(track, 'lyrics_extend');
      if (current.operation !== 'lyrics_extend') return;
      const next = `${current.lyrics.trimEnd()}\n${lyricJob.result!.lyrics}`;
      if (next.length > 8000) { toast.error('采用后会超过 8000 字，请先精简已有歌词。'); return; }
      setUndoLyrics(current.lyrics); setDrafts(prev => ({ ...prev, lyrics_extend: { ...current, lyrics: next } })); setOperation('lyrics_extend'); setAdopted(lyricJob.id);
    }}>{adopted === lyricJob.id ? '已采用' : '采用这句'}</Button><button className="text-button" onClick={() => downloadBlob(new Blob([lyricJob.result!.lyrics], { type: 'text/plain;charset=utf-8' }), `${track.title}-下一句.txt`)}><DownloadSimpleIcon />下载</button></div></section>}
    {versions.length > 0 && <section className="tool-result-card"><h2>新旧版本，切换着听</h2><label className="tool-label">对比版本<select aria-label="选择对比版本" value={compared?.id || ''} onChange={event => setComparison(event.target.value)}>{versions.map(version => <option key={version.id} value={version.id}>{version.title}</option>)}</select></label><div className="compare-buttons"><button onClick={() => player.audition(track, player.position)}><b>A</b>原作品</button><button disabled={!compared?.playbackUrl} onClick={() => compared && player.audition(compared, player.position)}><b>B</b>新版本</button></div><p className="tool-help">从当前秒数切换，超出时长则从头播放；续写后段落位置可能变化。</p></section>}
    {related.length > 0 && <section className="tool-result-card"><h2>这次听到了什么</h2><div className="version-list">{related.map(version => <div className="version-row" key={version.id}><button className="version-play" disabled={!version.playbackUrl} onClick={() => player.play(version)} aria-label={`试听${version.title}`}>{player.track?.id === version.id && player.playing ? <PauseIcon /> : <PlayIcon />}</button><div><strong>{version.stemName || version.title}</strong><small>{version.saveStatus === 'saved' ? formatTime(version.duration) : version.saveStatus === 'save_failed' ? '保存未完成' : '正在保存'} · {version.operation && toolNames[version.operation]}</small>{version.saveStatus === 'save_failed' && <button className="text-button" onClick={async () => { await api(`/api/tracks/${version.id}/save`, { method: 'POST' }).catch(failure => toast.error(failure.message)); }}>重新保存</button>}</div>{version.playbackUrl && <a className="icon-button" href={`/media/${version.id}?download=1`} download aria-label={`下载音频：${version.title}`}><DownloadSimpleIcon /></a>}<Link className="icon-button" to={`/tools/${version.id}`} aria-label={`继续创作${version.title}`}><ArrowRightIcon /></Link></div>)}</div></section>}
    {track.parentTrackId && <Link className="tool-back" to={`/tools/${track.parentTrackId}`}><ArrowLeftIcon /> 回到来源作品</Link>}
    </aside></div>
  </div>;
}

function TimeField({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" min={0} max={max / 1000} step={0.001} value={value / 1000} onChange={event => onChange(Math.round(Number(event.target.value) * 1000))} /></label>;
}
export function WaveSelection({ track, start, end, onChange, fixedLength, minLength = 3, maxLength }: { track: Track; start: number; end?: number; onChange: (start: number, end?: number) => void; fixedLength?: number; minLength?: number; maxLength?: number }) {
  const container = useRef<HTMLDivElement>(null); const region = useRef<Region | null>(null);
  const latest = useRef({ start, end, onChange }); latest.current = { start, end, onChange };
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const isRange = end !== undefined;
  useEffect(() => {
    let alive = true; let wave: WaveSurfer | undefined; setState('loading');
    void Promise.all([import('wavesurfer.js'), import('wavesurfer.js/dist/plugins/regions.js')]).then(([{ default: Wave }, { default: Regions }]) => {
      if (!alive || !container.current) return;
      const regions = Regions.create();
      wave = Wave.create({ container: container.current, url: track.playbackUrl!, height: 108, waveColor: '#adc1e4', progressColor: '#adc1e4', cursorWidth: 0, barWidth: 2, barGap: 2, barRadius: 2, normalize: true, interact: false, plugins: [regions] });
      wave.on('ready', () => {
        if (!alive) return; setState('ready');
        const current = latest.current;
        region.current = regions.addRegion({ start: current.start / 1000, end: (current.end ?? current.start) / 1000, color: isRange ? '#ee966533' : '#e58a48', minLength: isRange ? fixedLength ?? minLength : 0, maxLength: fixedLength ?? maxLength, drag: true, resize: isRange && !fixedLength, content: isRange ? '选中的片段' : '接续位置' });
      });
      regions.on('region-updated', updated => { const start = Math.min(track.duration, Math.round(updated.start * 1000)); const end = Math.min(track.duration, Math.round(updated.end * 1000)); latest.current.onChange(start, isRange ? end : undefined); });
      wave.on('error', () => { if (alive) setState('error'); });
    }).catch(() => { if (alive) setState('error'); });
    return () => { alive = false; wave?.destroy(); region.current = null; };
  }, [track.id, track.playbackUrl, isRange, fixedLength, minLength, maxLength]);
  useEffect(() => { region.current?.setOptions({ start: Math.max(0, Math.min(start, track.duration)) / 1000, end: Math.max(0, Math.min(end ?? start, track.duration)) / 1000 }); }, [start, end, track.duration]);
  return <div className="selection-wave"><div className="wave-instruction"><WaveformIcon /> {isRange ? '选一段，仔细听听' : '找到故事的下一个起点'}<span>{formatTime(track.duration)}</span></div><div ref={container} className="tool-waveform" aria-label="可拖动选区的音频波形" />{state !== 'ready' && <p className="tool-help">{state === 'loading' ? '正在展开波形…' : '波形暂时无法显示，仍可填写时间并试听。'}</p>}<div className="wave-ruler"><span>0:00</span><span>{formatTime(track.duration / 2)}</span><span>{formatTime(track.duration)}</span></div></div>;
}
function TimedLyrics({ track, onSelect }: { track: Track; onSelect: (start: number, end: number, text: string) => void }) {
  const sections = track.lyricsSections as { lines?: { start?: number; end?: number; text?: string }[] }[] | null;
  const lines = Array.isArray(sections) ? sections.flatMap(s => Array.isArray(s?.lines) ? s.lines : []).filter(line => typeof line?.start === 'number' && line.start < track.duration && typeof line.text === 'string') : [];
  if (!lines.length) return null;
  return <details className="timed-lyrics"><summary>按歌词定位片段 <span>{lines.length} 句</span></summary><div>{lines.map((line, index) => <button key={index} onClick={() => onSelect(line.start!, line.end ?? line.start! + 3000, line.text!)}><time>{formatTime(line.start!)}</time><span>{line.text}</span><ArrowRightIcon /></button>)}</div></details>;
}
