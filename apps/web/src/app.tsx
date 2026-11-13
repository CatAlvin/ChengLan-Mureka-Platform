import { CreditBadge, CreditPanel } from './components/credits';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightIcon, ArrowUpRightIcon, ArrowCounterClockwiseIcon, ArrowClockwiseIcon, BellSimpleIcon,
  CheckIcon, CheckCircleIcon, CircleNotchIcon, ClockIcon, DownloadSimpleIcon, FolderSimpleIcon,
  HeadphonesIcon, HeartIcon, HouseLineIcon, ListBulletsIcon, MagnifyingGlassIcon, MusicNoteIcon,
  MusicNotesIcon, PauseIcon, PencilSimpleIcon, PlayIcon, PlusIcon, SlidersHorizontalIcon,
  SparkleIcon, TrashIcon, WaveformIcon, XIcon, HardDrivesIcon, ShieldCheckIcon, VinylRecordIcon,
  SunHorizonIcon, AirplaneTiltIcon, GiftIcon, InfoIcon, WarningCircleIcon,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { UploadMusic } from './components/upload-music';
import { CreativeTools } from './components/creative-tools';
import { CollectionSelect, CollectionManager, ExportControls } from './components/library-tools';
import { Admin } from './components/admin';
import { AccountControls, useAuth } from './components/auth';
import { CreateForm } from './components/create-form';
import { Button } from './components/ui/button';
import { Modal } from './components/modal';
import { usePlayer } from './components/player';
import { jobProgress, jobInProgress } from './lib/job-progress';
import { api, connect, downloadBlob, formatDate, formatTime, snapshotQuery } from './lib/api';
import { emptyDraft, modeNames, statusNames, toolNames, templates, terminalStatuses, type Collection, type CreativeInput, type Job, type Mode, type Snapshot, type Track } from '../../../packages/shared/src/index';

const templateIcons = [AirplaneTiltIcon, GiftIcon, HeadphonesIcon, SunHorizonIcon];
const navigation = [
  { to: '/', title: '创作工作台', icon: HouseLineIcon },
  { to: '/library', title: '我的作品', icon: FolderSimpleIcon },
  { to: '/tasks', title: '创作记录', icon: ClockIcon },
];
function Logo() { return <Link to="/" className="brand" aria-label="橙蓝音乐首页"><span className="brand-mark"><span /><span /><span /><span /></span><span className="brand-name">橙蓝<span>AI 音乐工作台</span></span></Link>; }
function Status({ job, tracks = [] }: { job: Job; tracks?: Track[] }) {
  const status = jobProgress(job, tracks);
  const active = !terminalStatuses.includes(status) && !['submission_unknown', 'audio_save_failed'].includes(status);
  const label = status === 'saving_audio' ? '正在保存音频' : status === 'audio_save_failed' ? '音频保存未完成' : statusNames[status];
  return <span className={`status-badge ${status === 'succeeded' ? 'success' : ['failed', 'timeouted', 'submission_unknown', 'save_failed', 'audio_save_failed'].includes(status) ? 'error' : active ? 'active' : ''}`}>
    {active ? <CircleNotchIcon className="spin" /> : status === 'succeeded' ? <CheckCircleIcon /> : null}{label}
  </span>;
}

export function App() {
  const { session: auth } = useAuth();
  const location = useLocation();
  const { data, error, refetch } = useQuery(snapshotQuery);
  const client = useQueryClient();
  const { track: currentTrack } = usePlayer();
  const [details, setDetails] = useState<Track | null>(null);
  const known = useRef<Map<string, string> | null>(null);
  useEffect(() => { void connect().then(() => api('/api/account/refresh', { method: 'POST' })).then(() => client.invalidateQueries({ queryKey: ['snapshot'] })).catch(() => {}); }, [client]);
  useEffect(() => {
    if (!data) return;
    if (known.current) for (const job of data.jobs) {
      if (jobProgress(job, data.tracks) === 'succeeded' && known.current.has(job.id) && known.current.get(job.id) !== 'succeeded') toast.success(['lyrics', 'lyrics_extend', 'recognize'].includes(job.kind) ? '你的歌词灵感已完成' : job.kind === 'transcribe' ? '乐谱已保存，可以分别下载了' : job.kind === 'describe' ? '音乐分析已完成' : job.kind === 'stem' ? '分轨已保存，可以分别试听了' : '你的新作品已经完成，去听听吧');
    }
    known.current = new Map(data.jobs.map(job => [job.id, jobProgress(job, data.tracks)]));
  }, [data]);
  const count = data?.jobs.filter(job => jobInProgress(job, data.tracks)).length || 0;
  const currentTitle = location.pathname.startsWith('/admin') ? '管理后台' : location.pathname === '/' ? '创作工作台' : location.pathname === '/library' ? '我的作品' : location.pathname === '/tasks' ? '创作记录' : location.pathname.startsWith('/tools') ? '继续创作' : '设置';
  return <div className={`app-shell ${currentTrack ? 'has-player' : ''}`}>
    <aside className="sidebar"><Logo /><div className="workspace-label">我的音乐空间</div><nav aria-label="主要导航">{navigation.map(item => <NavLink aria-label={item.title} key={item.to} to={item.to} end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><item.icon size={21} weight={location.pathname === item.to ? 'fill' : 'regular'} /><span>{item.title}</span>{item.to === '/tasks' && count > 0 && <b className="nav-count">{count}</b>}</NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="local-workspace"><span className="local-workspace-icon"><VinylRecordIcon size={25} /></span><strong>灵感在这里，慢慢生长</strong><p>你的音乐，你的创作空间。</p><span className="local-label"><span /> 个人工作区</span></div><NavLink aria-label="偏好与设置" to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><SlidersHorizontalIcon size={21} /><span>偏好与设置</span></NavLink><div className="profile"><span className="avatar">橙</span><div><strong>{auth.user!.displayName}</strong><small>{auth.user!.role === 'admin' ? '管理员' : '个人创作空间'}</small></div><span className="profile-dot" /></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>我的音乐空间</span><span>/</span><strong>{currentTitle}</strong></div><div className="topbar-actions"><CreditBadge balance={data?.credits} /><span className={`connection-pill ${data?.account.connected ? 'connected' : ''}`}><span />{data?.account.connected ? 'Mureka 已连接' : data?.account.checkedAt ? '连接待检查' : '正在连接'}</span><Link to="/tasks" className="icon-button notification-button" aria-label={`查看创作记录，${count} 项处理中`}><BellSimpleIcon size={21} />{count > 0 && <i />}</Link><span className="small-avatar">橙</span></div></header>
      <main id="main-content">{error && <div className="connection-error" role="alert"><WarningCircleIcon size={20} /><span>暂时连接不到工作台。草稿仍保留在此浏览器中。</span><button onClick={() => void refetch()}>重新连接</button></div>}
        <Routes><Route path="/admin/*" element={<Admin />} /><Route path="/tools/:trackId" element={<CreativeTools snapshot={data} />} /><Route path="/tools" element={<CreativeTools snapshot={data} />} /><Route path="/" element={<Studio snapshot={data} onDetails={setDetails} />} /><Route path="/library" element={<Library snapshot={data} onDetails={setDetails} />} /><Route path="/tasks" element={<Tasks snapshot={data} />} /><Route path="/settings" element={<Settings snapshot={data} />} /><Route path="*" element={<div className="empty-page"><MusicNotesIcon size={44} /><h1>这一页还没有旋律</h1><Link to="/">回到创作工作台</Link></div>} /></Routes>
      </main><footer className="app-footer"><span>橙蓝 AI 音乐</span><span>把想法，变成听得见的作品</span><span>由 Mureka 提供创作能力</span></footer>
    </div>
    <nav className="mobile-nav" aria-label="移动导航">{[...navigation, { to: '/settings', title: '设置', icon: SlidersHorizontalIcon }].map(item => <NavLink to={item.to} end key={item.to}><item.icon size={22} /><span>{item.title}</span></NavLink>)}</nav>
    <TrackDetails collections={data?.collections} track={details ? data?.tracks.find(track => track.id === details.id) || details : null} onClose={() => setDetails(null)} />
  </div>;
}

function Studio({ snapshot, onDetails }: { snapshot?: Snapshot; onDetails: (track: Track) => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { session } = useAuth();
  const [mode, setMode] = useState<Mode>(session.user?.role === 'admin' ? 'easy' : 'lyrics');
  const [preset, setPreset] = useState<CreativeInput | null>(null);
  const [revision, setRevision] = useState(0);
  const draftQuery = useQuery({ queryKey: ['drafts'], queryFn: () => api<{ mode: string; input: CreativeInput; updatedAt: number }[]>('/api/drafts'), staleTime: Infinity });
  useEffect(() => {
    const state = location.state as { input?: CreativeInput } | null;
    if (state?.input) { setMode(state.input.mode); setPreset(state.input); setRevision(value => value + 1); navigate('/', { replace: true, state: null }); }
  }, [location.state, navigate]);
  function useTemplate(index: number) {
    const template = templates[index]; setMode(template.mode);
    setPreset({ ...emptyDraft(template.mode), prompt: template.prompt, styles: [template.style], mood: template.mood });
    setRevision(value => value + 1); toast.success(`已填入「${template.title}」，可以自由修改`);
    document.querySelector('.composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const activeJobs = snapshot?.jobs.filter(job => jobInProgress(job, snapshot.tracks)) || [];
  const recent = snapshot?.tracks.filter(track => !track.deletedAt).slice(0, 3) || [];
  return <div className="page studio-page"><div className="page-heading"><div><div className="eyebrow"><span /> 从灵感到旋律</div><h1>让灵感，有自己的<span>旋律。</span></h1><p>写下脑海中的画面，创作一首属于你的音乐。</p></div><div className="heading-note"><WaveformIcon size={23} /><span>一点想法<br /><strong>无限可能</strong></span></div></div>
    <div className="studio-grid"><section className="composer" aria-label="音乐创作表单"><div className="composer-heading"><div><span className="section-icon orange"><SparkleIcon weight="fill" /></span><h2>开始新创作</h2></div><span className="quiet-label">CREATE</span></div>
      <div className="mode-switch" role="tablist" aria-label="创作模式">{(['easy', 'lyrics', 'instrumental'] as Mode[]).map(value => <button role="tab" aria-selected={mode === value} key={value} className={mode === value ? 'selected' : ''} onClick={() => { setMode(value); setPreset(null); }} type="button">{value === 'easy' ? <SparkleIcon /> : value === 'lyrics' ? <PencilSimpleIcon /> : <WaveformIcon />}{modeNames[value]}</button>)}</div>
      {draftQuery.isPending ? <div className="form-loading"><CircleNotchIcon className="spin" /> 正在找回你的草稿…</div> : <CreateForm key={`${mode}-${revision}`} mode={mode} drafts={draftQuery.data || []} preset={preset?.mode === mode ? preset : null} snapshot={snapshot} onCreated={() => { void client.invalidateQueries({ queryKey: ['drafts'] }); }} />}
    </section>
    <div className="studio-right">{activeJobs.length > 0 ? <section className="active-creation"><div className="section-heading"><h2><span className="live-dot" /> 音乐正在路上</h2><Link to="/tasks">查看全部 <ArrowRightIcon /></Link></div>{activeJobs.slice(0, 2).map(job => <div className="live-job" key={job.id}><div className="live-job-icon"><WaveformIcon size={27} /></div><div><strong>{job.input.title || job.input.prompt.slice(0, 24) || '我的新作品'}</strong><span>{job.status === 'local_queued' ? '已为你保留位置，可以继续创作' : job.status === 'submission_unknown' ? '需要核实提交结果，请查看创作记录' : '完成后会自动保存到你的作品库'}</span></div><Status job={job} tracks={snapshot?.tracks} /></div>)}</section> : <section className="welcome-art"><div className="art-copy"><span className="art-kicker"><HeadphonesIcon /> 为每一个想法，配上音乐</span><h2>下一首喜欢的歌，<br />也许就是你写的。</h2><p>无需乐理基础，<br />跟着你的感觉开始。</p><span className="art-caption"><span /> MADE WITH YOUR IMAGINATION</span></div><div className="record-scene" aria-hidden="true"><span className="scene-orbit" /><span className="scene-spark spark-one">＋</span><span className="scene-spark spark-two">＋</span><div className="record-sleeve"><span>CHENGLAN<br />ORIGINAL</span></div><div className="vinyl"><div className="vinyl-label"><span /><MusicNoteIcon weight="fill" /></div></div><div className="sound-pill"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div></section>}
      <section className="inspiration"><div className="section-heading"><h2>没想好？从这里开始</h2><span>选择一个灵感，随心修改</span></div><div className="template-grid">{templates.map((template, index) => { const Icon = templateIcons[index]; return <button key={template.id} className={`template template-${template.color}`} onClick={() => useTemplate(index)}><div className="template-art" aria-hidden="true"><span className="template-orb" /><Icon weight="duotone" /></div><div className="template-text"><strong>{template.title}</strong><span>{template.tag}</span></div><ArrowUpRightIcon className="template-arrow" /></button>; })}</div></section>
      <section className="recent-section"><div className="section-heading"><h2>最近的创作</h2><Link to="/library">我的作品 <ArrowRightIcon /></Link></div>{recent.length ? <div className="recent-list">{recent.map(track => <TrackRow key={track.id} track={track} onDetails={onDetails} />)}</div> : <div className="recent-empty"><div className="empty-note"><MusicNotesIcon size={26} /></div><div><strong>给灵感一个开始</strong><p>完成的音乐会出现在这里，随时回来听听。</p></div></div>}</section>
      <div className="studio-tip"><ShieldCheckIcon size={18} /><p>草稿自动保存，作品留在你的账户里。放心尝试每一个灵感。</p></div>
    </div></div>
  </div>;
}

function TrackRow({ track, onDetails, card = false }: { track: Track; onDetails: (track: Track) => void; card?: boolean }) {
  const player = usePlayer(); const client = useQueryClient(); const navigate = useNavigate();
  const isPlaying = player.track?.id === track.id && player.playing;
  async function update(patch: unknown) {
    try { await api(`/api/tracks/${track.id}`, { method: 'PATCH', body: patch }); await client.invalidateQueries({ queryKey: ['snapshot'] }); return true; }
    catch (error) { toast.error((error as Error).message); return false; }
  }
  return <article className={`track-row ${card ? 'track-card' : ''}`}>
    <button className={`track-cover cover-${track.mode}`} onClick={() => player.play(track)} aria-label={`播放 ${track.title}`} disabled={!track.playbackUrl}>
      <VinylRecordIcon className="cover-record" weight="duotone" /><span className="cover-play">{isPlaying ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}</span>
    </button>
    <div className="track-info"><button className="track-title" onClick={() => onDetails(track)}>{track.title}</button><span>{track.operation === 'crop' ? '音频裁剪' : track.origin === 'uploaded' ? '本地上传' : modeNames[track.mode]}<i>·</i>{track.duration ? formatTime(track.duration) : '等待音频'}<i>·</i>{formatDate(track.createdAt)}</span><small className={`save-status ${track.saveStatus === 'save_failed' ? 'text-danger' : ''}`}>{track.saveStatus === 'saved' ? <><CheckCircleIcon /> 已保存</> : track.saveStatus === 'saving' ? <><CircleNotchIcon className="spin" /> 正在保存音频</> : <button onClick={async () => { await api(`/api/tracks/${track.id}/save`, { method: 'POST' }).then(() => { toast.success('已开始重新保存'); void client.invalidateQueries({ queryKey: ['snapshot'] }); }).catch(error => toast.error(error.message)); }}>保存未完成，点击重试</button>}</small></div>
    <div className="track-actions">{track.deletedAt ? <button className="text-button" onClick={() => void update({ deleted: false })}><ArrowCounterClockwiseIcon />恢复作品</button> : <>
      <button className={`icon-button ${track.favorite ? 'favorited' : ''}`} aria-label={track.favorite ? '取消收藏' : '收藏作品'} onClick={() => void update({ favorite: !track.favorite })}><HeartIcon weight={track.favorite ? 'fill' : 'regular'} size={19} /></button>
      {track.playbackUrl && <a className="icon-button" href={`/media/${track.id}?download=1`} download title="下载音频" aria-label="下载音频"><DownloadSimpleIcon size={19} /></a>}
      {card && <><button className="icon-button" aria-label={track.origin === 'uploaded' ? '继续创作' : '照这个再做一版'} onClick={() => track.origin === 'uploaded' ? navigate(`/tools/${track.id}`) : navigate('/', { state: { input: track.input } })}><PlusIcon size={19} /></button><button className="icon-button" aria-label="移入回收站" onClick={async () => { if (await update({ deleted: true })) toast('已移入回收站', { action: { label: '撤销', onClick: () => void update({ deleted: false }) } }); }}><TrashIcon size={18} /></button></>}
    </>}</div>
  </article>;
}

function Library({ snapshot, onDetails }: { snapshot?: Snapshot; onDetails: (track: Track) => void }) {
  const [filter, setFilter] = useState('all'); const [search, setSearch] = useState(''); const [collection, setCollection] = useState('all');
  const { data: drafts } = useQuery({ queryKey: ['drafts'], queryFn: () => api<{ mode: Mode; input: CreativeInput; updatedAt: number }[]>('/api/drafts') });
  const navigate = useNavigate();
  const tracks = (snapshot?.tracks || []).filter(track => (filter === 'trash' ? !!track.deletedAt : !track.deletedAt) && (filter !== 'uploaded' || track.origin === 'uploaded') && (filter !== 'favorite' || track.favorite) && (filter !== 'instrumental' || track.mode === 'instrumental') && (collection === 'all' || (collection === 'ungrouped' ? !track.collectionId : track.collectionId === collection)) && track.title.toLowerCase().includes(search.toLowerCase()));
  const total = snapshot?.tracks.filter(track => !track.deletedAt).length || 0;
  return <div className="page"><div className="page-heading"><div><div className="eyebrow">YOUR MUSIC COLLECTION</div><h1>我的作品<span>。</span></h1><p>每一个想法都值得留下。这里收藏着你的 {total} 首音乐。</p></div><div className="library-heading-actions"><UploadMusic /><Button className="primary-button" onClick={() => navigate('/')}><PlusIcon /> 新的创作</Button></div></div>
    <div className="library-toolbar"><div className="filter-tabs" aria-label="作品筛选">{[['all', '全部作品'], ['favorite', '我的收藏'], ['uploaded', '我上传的'], ['instrumental', '纯音乐'], ['drafts', '草稿'], ['trash', '回收站']].map(([value, label]) => <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>)}</div><div className="search-input"><MagnifyingGlassIcon /><input aria-label="搜索作品" placeholder="搜索作品名称" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><XIcon /></button>}</div></div>
    <div className="collection-controls library-collections"><label className="collection-field">作品集<select aria-label="筛选作品集" value={collection} onChange={event => setCollection(event.target.value)}><option value="all">全部作品集</option><option value="ungrouped">暂未分组</option>{snapshot?.collections?.map(c => <option key={c.id} value={c.id}>{c.name}{c.archivedAt ? '（已归档）' : ''}</option>)}</select></label><CollectionManager collections={snapshot?.collections} onCreated={setCollection} /></div>
    {filter === 'drafts' ? <div className="draft-list">{drafts?.filter(d => d.input.prompt || d.input.lyrics || d.input.source).length ? drafts.filter(d => d.input.prompt || d.input.lyrics).map(draft => <button className="draft-card" key={draft.mode} onClick={() => navigate('/', { state: { input: draft.input } })}><PencilSimpleIcon size={24} /><div><strong>{draft.input.title || modeNames[draft.mode]}</strong><p>{draft.input.prompt || draft.input.lyrics}</p><small>上次编辑 {formatDate(draft.updatedAt)}</small></div><ArrowRightIcon /></button>) : <Empty title="还没有保存的草稿" text="在创作工作台写下想法，草稿会自动留在这里。" action={<Link to="/">去写下一个想法 <ArrowRightIcon /></Link>} />}</div> : tracks.length ? <div className="library-grid">{tracks.map(track => <TrackRow track={track} onDetails={onDetails} card key={track.id} />)}</div> : <Empty title={search ? '没有找到这首作品' : filter === 'favorite' ? '把喜欢的旋律，留在这里' : filter === 'trash' ? '回收站是空的' : '你的第一首作品，即将诞生'} text={search ? '试试更短的关键词，或者清除搜索。' : filter === 'favorite' ? '点击作品旁的爱心，下次就能快速找到。' : filter === 'trash' ? '移除的作品可以在这里恢复。' : '从一个故事、一段歌词，或一种心情开始。'} action={search ? <button onClick={() => setSearch('')}>清除搜索</button> : filter !== 'trash' && <Link to="/">开始创作 <ArrowRightIcon /></Link>} />}
  </div>;
}
function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty-page"><div className="empty-vinyl"><VinylRecordIcon size={54} weight="duotone" /></div><h2>{title}</h2><p>{text}</p>{action && <div className="empty-action">{action}</div>}</div>;
}

function Tasks({ snapshot }: { snapshot?: Snapshot }) {
  const client = useQueryClient(); const navigate = useNavigate();
  const [filter, setFilter] = useState('all'); const [reconcile, setReconcile] = useState<Job | null>(null);
  const [checked, setChecked] = useState(false); const [busy, setBusy] = useState(false);
  const [lyrics, setLyrics] = useState<Job | null>(null);
  const jobs = snapshot?.jobs.filter(job => { const progress = jobProgress(job, snapshot.tracks); return filter === 'all' || (filter === 'active' ? jobInProgress(job, snapshot.tracks) : filter === 'succeeded' ? progress === 'succeeded' : ['failed', 'timeouted', 'submission_unknown', 'save_failed', 'audio_save_failed'].includes(progress)); }) || [];
  async function retryAudio(job: Job) { try { for (const track of snapshot?.tracks.filter(t => t.jobId === job.id && t.saveStatus === 'save_failed') || []) await api(`/api/tracks/${track.id}/save`, { method: 'POST' }); await client.invalidateQueries({ queryKey: ['snapshot'] }); toast.success('已重新开始保存，不会再次生成'); } catch (error) { toast.error((error as Error).message); } }
  async function action(url: string, body?: unknown) { try { await api(url, { method: 'POST', body }); await client.invalidateQueries({ queryKey: ['snapshot'] }); } catch (error) { toast.error((error as Error).message); } }
  return <div className="page"><div className="page-heading"><div><div className="eyebrow">YOUR CREATIVE JOURNEY</div><h1>创作记录<span>。</span></h1><p>灵感已经在路上。等待时，你可以继续做下一首。</p></div><span className="subtle-pill"><ListBulletsIcon /> 自动排队 · 最多 {snapshot?.account.concurrency || 1} 项同时创作</span></div>
    {!snapshot?.account.connected && snapshot?.account.checkedAt && <div className="notice warning">{snapshot.account.error || '当前连接未就绪'}，待提交的任务会保留。<Link to="/settings">检查连接</Link></div>}
    {snapshot?.account.connected && snapshot.account.balance !== null && snapshot.account.balance <= 0 && <div className="notice warning">账户额度不足，新的任务会保留在队列。<Link to="/settings">查看账户</Link></div>}
    <div className="filter-tabs page-tabs">{[['all', '全部记录'], ['active', '进行中'], ['succeeded', '已完成'], ['failed', '需要处理']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {jobs.length ? <div className="job-list">{jobs.map(job => <article className="job-card" key={job.id}><div className={`job-icon ${jobProgress(job, snapshot?.tracks) === 'succeeded' ? 'done' : ''}`}>{job.kind === 'lyrics' ? <PencilSimpleIcon /> : <WaveformIcon />}</div><div className="job-body"><div className="job-title"><h3>{job.input.title || job.input.prompt.slice(0, 40) || '我的新作品'}</h3><Status job={job} tracks={snapshot?.tracks} /></div><p>{job.tool ? toolNames[job.tool.operation] : job.kind === 'import' ? '音乐上传' : job.kind === 'lyrics' ? '歌词创作' : modeNames[job.input.mode]}<span>·</span>{['lyrics', 'lyrics_extend', 'recognize'].includes(job.kind) ? '1 份歌词' : job.kind === 'transcribe' ? '一组乐谱' : job.kind === 'track' ? '1 条音轨' : job.kind === 'describe' ? '1 份分析' : job.kind === 'stem' ? '一组音轨' : `${job.input.count} 首作品`}<span>·</span>{formatDate(job.createdAt)}</p>{job.error && <div className="job-error"><InfoIcon />{job.error}</div>}{jobProgress(job, snapshot?.tracks) === 'audio_save_failed' && <div className="job-error"><InfoIcon />音乐已生成，音频保存未完成。重新保存会继续处理已有结果。</div>}{job.status === 'local_queued' && <span className="queue-message">{job.kind === 'crop' ? '裁剪已排队，完成后自动保存为新作品' : (snapshot?.jobs.filter(j => j.status === 'local_queued' && j.createdAt < job.createdAt).length || 0) > 0 ? `前面还有 ${snapshot!.jobs.filter(j => j.status === 'local_queued' && j.createdAt < job.createdAt).length} 项待提交任务` : '已在工作台排好队，额度和连接就绪后自动提交'}</span>}<details className="job-diagnostics"><summary>查看任务信息</summary><span>任务编号：{job.id}</span>{job.providerId && <span>云端编号：{job.providerId}</span>}{job.traceId && <span>诊断编号：{job.traceId}</span>}</details></div><div className="job-actions">{jobProgress(job, snapshot?.tracks) === 'audio_save_failed' && <button onClick={() => void retryAudio(job)}>重新保存音频</button>}{job.status === 'local_queued' && <button onClick={() => void action(`/api/jobs/${job.id}/cancel`)}>取消排队</button>}{job.status === 'submission_unknown' && <Button className="secondary-button" onClick={() => { setReconcile(job); setChecked(false); }}>核实任务</Button>}{job.result && ['lyrics', 'lyrics_extend', 'recognize'].includes(job.kind) && <button onClick={() => setLyrics(job)}>查看歌词 <ArrowRightIcon /></button>}{job.tool && <Link to={`/tools/${job.tool.sourceTrackId}`}>回到创作工具 <ArrowRightIcon /></Link>}{job.status === 'save_failed' && <button onClick={() => void action(`/api/jobs/${job.id}/save`)}>{job.kind === 'crop' ? '重新裁剪' : job.kind === 'transcribe' ? '重新保存乐谱' : '重新保存分轨'}</button>}{jobProgress(job, snapshot?.tracks) === 'succeeded' && !job.tool && job.kind !== 'lyrics' && <Link to="/library">去听听 <ArrowRightIcon /></Link>}{!job.tool && ['failed', 'timeouted', 'cancelled'].includes(job.status) && <button onClick={() => navigate('/', { state: { input: job.input } })}>带回创作区 <ArrowRightIcon /></button>}</div></article>)}</div> : <Empty title="创作旅程，从第一首开始" text="提交的每次创作都会记录在这里，刷新页面也不会丢失。" action={<Link to="/">去创作 <ArrowRightIcon /></Link>} />}
    <Modal open={!!reconcile} onOpenChange={open => !open && setReconcile(null)} title="核实这次提交" description="请求可能已到达 Mureka。请先查看官方账户记录，避免再次生成产生费用。"><a href="https://platform.mureka.cn/" target="_blank" rel="noreferrer" className="external-link">打开 Mureka 账户 <ArrowUpRightIcon /></a><p className="field-help">请联系管理员核对云端任务。共享账户不直接关联未经验证的任务编号。</p><label className="checkbox-label"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />我已核对官方记录，知道关闭工作台记录不会取消云端生成</label><Button className="primary-button" disabled={!checked || busy} onClick={async () => { setBusy(true); try { await api(`/api/jobs/${reconcile!.id}/reconcile`, { method: 'POST', body: { checked: true } }); setReconcile(null); await client.invalidateQueries({ queryKey: ['snapshot'] }); } catch (error) { toast.error((error as Error).message); } finally { setBusy(false); } }}>{busy ? '正在保存…' : '已核实，关闭待核实记录'}</Button></Modal>
    <Modal open={!!lyrics} onOpenChange={open => !open && setLyrics(null)} title={lyrics?.result?.title || '歌词初稿'}><pre className="lyrics-preview">{lyrics?.result?.lyrics}</pre><Button className="primary-button" onClick={() => { if (lyrics?.kind === 'lyrics_extend' && lyrics.tool) { navigate(`/tools/${lyrics.tool.sourceTrackId}`); setLyrics(null); return; } navigate('/', { state: { input: { ...lyrics!.input, mode: 'lyrics', lyrics: lyrics!.result!.lyrics, title: lyrics!.result!.title.slice(0, 80) } } }); setLyrics(null); }}>{lyrics?.kind === 'lyrics_extend' ? '回到歌词接写' : '用这份歌词作曲'} <ArrowRightIcon /></Button></Modal>
  </div>;
}

function Settings({ snapshot }: { snapshot?: Snapshot }) {
  const { session } = useAuth();
  const client = useQueryClient(); const [refreshing, setRefreshing] = useState(false); const [backingUp, setBackingUp] = useState(false);
  const { data: info } = useQuery({ queryKey: ['info'], queryFn: () => api<{ storageDir: string; dataDir: string; version: string }>('/api/info') });
  const account = snapshot?.account;
  const [showBalance, setShowBalance] = useState(false);
  return <div className="page settings-page"><div className="page-heading"><div><div className="eyebrow">MAKE YOURSELF AT HOME</div><h1>让创作更顺手<span>。</span></h1><p>连接、存储和账户信息，都在这里。</p></div></div>
    <AccountControls /><CreditPanel />
    <div className="settings-grid"><section className="settings-card"><div className="settings-title"><span className="section-icon blue"><WaveformIcon /></span><div><h2>Mureka 连接</h2><p>你的音乐创作引擎</p></div><span className={`connection-pill ${account?.connected ? 'connected' : ''}`}><span />{account?.connected ? '已连接' : '待连接'}</span></div><div className="setting-row"><span>服务区域</span><strong>Mureka 中国区</strong></div><div className="setting-row"><span>密钥状态</span><strong>{account?.configured ? '已配置' : '尚未配置'}</strong></div><div className="setting-row"><span>同时创作数量</span><strong>{account?.concurrency || 1} 项，超出会自动排队</strong></div>{account?.error && <div className="notice warning">{account.error}</div>}<div className="settings-card-footer"><span>{account?.checkedAt ? `上次检测 ${formatDate(account.checkedAt)}` : '尚未检测'}</span><Button className="secondary-button" disabled={refreshing} onClick={async () => { setRefreshing(true); try { const result = await api<Snapshot['account']>('/api/account/refresh', { method: 'POST' }); await client.invalidateQueries({ queryKey: ['snapshot'] }); if (result.connected) toast.success('Mureka 连接正常'); else toast.error(result.error); } catch (error) { toast.error((error as Error).message); } finally { setRefreshing(false); } }}><ArrowClockwiseIcon className={refreshing ? 'spin' : ''} />{refreshing ? '检测中…' : '重新检测'}</Button></div></section>
    {session.user!.role === 'admin' && <section className="settings-card"><div className="settings-title"><span className="section-icon orange"><SparkleIcon /></span><div><h2>创作额度</h2><p>按实际生成数量计费</p></div><button className="text-button" onClick={() => setShowBalance(!showBalance)}>{showBalance ? '隐藏金额' : '显示金额'}</button></div><div className="balance-label">账户可用余额</div><div className="balance">{showBalance ? account?.balance === null || account?.balance === undefined ? '暂不可用' : `¥ ${(account.balance / 100).toFixed(2)}` : '¥ ••••'}<span>CNY</span></div><p className="setting-note">每次默认生成 1 首。歌曲、歌词等操作分别计费，具体价格以官方账户账单为准。</p><div className="settings-card-footer"><span>与官方账户同步</span><a href="https://platform.mureka.cn/" target="_blank" rel="noreferrer">查看官方账户 <ArrowUpRightIcon /></a></div></section>}
    <section className="settings-card storage-settings"><div className="settings-title"><span className="section-icon green"><HardDrivesIcon /></span><div><h2>我的作品与备份</h2><p>音乐自动保存，灵感安心留下</p></div></div><div className="storage-summary"><div><strong>{((snapshot?.storageBytes || 0) / 1024 / 1024).toFixed(1)}<small>MB</small></strong><span>已保存音频占用</span></div><div><strong>{snapshot?.tracks.filter(track => track.saveStatus === 'saved').length || 0}<small>首</small></strong><span>已保存</span></div></div><label className="path-label">作品保存位置<code>{info?.storageDir || '正在读取…'}</code></label><p className="setting-note">备份仅包含你的草稿、创作记录、素材、音频与歌词，不包含登录凭据。请保管好下载文件；需要恢复时联系管理员。</p><div className="settings-card-footer"><span>建议定期保存一份副本</span><Button className="secondary-button" disabled={backingUp} onClick={async () => { setBackingUp(true); try { const blob = await api<Blob>('/api/backup', { method: 'POST', binary: true }); downloadBlob(blob, `橙蓝音乐备份-${new Date().toISOString().slice(0, 10)}.zip`); toast.success('备份已准备好，请保存下载的文件'); } catch (error) { toast.error((error as Error).message); } finally { setBackingUp(false); } }}><DownloadSimpleIcon />{backingUp ? '正在准备备份…' : '导出我的备份'}</Button></div></section>
    <section className="settings-card privacy-card"><ShieldCheckIcon size={34} weight="duotone" /><h2>只属于你的创作空间</h2><p>创作内容按你的操作提交至 Mureka。作品、素材和草稿按账户隔离；密钥保存在服务端。</p><div><CheckIcon /> 自动保存草稿</div><div><CheckIcon /> 登录后可随时回听已保存作品</div><div><CheckIcon /> 只有你可以查看自己的创作内容</div><span className="app-version">橙蓝 AI 音乐 · v{info?.version || '0.7.3'}</span></section></div>
  </div>;
}

function TrackDetails({ track, collections, onClose }: { track: Track | null; collections?: Collection[]; onClose: () => void }) {
  const [title, setTitle] = useState(''); const [editing, setEditing] = useState(false);
  const client = useQueryClient(); const navigate = useNavigate(); const player = usePlayer();
  useEffect(() => { setTitle(track?.title || ''); setEditing(false); }, [track?.id]);
  return <Modal open={!!track} onOpenChange={open => !open && onClose()} title="作品详情" description="回听你的作品，查看歌词和当时的创作灵感。" wide>{track && <>
    <div className="detail-title"><div className={`track-cover cover-${track.mode}`}><VinylRecordIcon size={60} weight="duotone" /></div><div>{editing ? <div className="rename-control"><input value={title} onChange={event => setTitle(event.target.value)} maxLength={80} aria-label="作品名称" /><button className="text-button" onClick={async () => { try { await api(`/api/tracks/${track.id}`, { method: 'PATCH', body: { title } }); await client.invalidateQueries({ queryKey: ['snapshot'] }); setEditing(false); } catch (error) { toast.error((error as Error).message); } }}>保存</button></div> : <h2>{track.title}<button className="icon-button" aria-label="修改作品名称" onClick={() => setEditing(true)}><PencilSimpleIcon /></button></h2>}<span>{track.operation === 'crop' ? '音频裁剪' : track.origin === 'uploaded' ? '本地上传' : modeNames[track.mode]} · {formatTime(track.duration)} · {track.model}</span></div></div>
    <div className="detail-actions">{track.playbackUrl && !track.deletedAt && <a className="secondary-link" href={`/media/${track.id}?download=1`} download><DownloadSimpleIcon />下载音频</a>}{track.playbackUrl && !track.deletedAt && <Button className="primary-button" onClick={() => { navigate(`/tools/${track.id}`); onClose(); }}><SparkleIcon />继续创作</Button>}<Button className="primary-button" disabled={!track.playbackUrl || !!track.deletedAt} onClick={() => player.play(track)}><PlayIcon weight="fill" />试听作品</Button>{track.origin !== 'uploaded' && <Button className="secondary-button" onClick={() => { navigate('/', { state: { input: track.input } }); onClose(); }}><PlusIcon />照这个再做一版</Button>}</div>
    <CollectionSelect collections={collections} value={track.collectionId} disabled={!!track.deletedAt} onChange={async id => { try { await api(`/api/tracks/${track.id}`, { method: 'PATCH', body: { collectionId: id } }); await client.invalidateQueries({ queryKey: ['snapshot'] }); } catch (error) { toast.error((error as Error).message); } }} />
    <ExportControls track={track} />{track.originalUrl && !track.deletedAt && <a className="text-button" href={track.originalUrl} download><DownloadSimpleIcon />下载上传的原文件</a>}
    <div className="detail-section"><h3>当时的灵感</h3><p>{track.origin === 'uploaded' ? '从你的本地音频开始，原文件完整保存在个人作品库。' : track.input.source ? `使用${track.input.source.kind === 'melody' ? '哼唱旋律' : '参考曲'}创作 · ${formatTime(track.input.source.start)}–${formatTime(track.input.source.end)}` : track.input.prompt || '从歌词开始的创作'}</p><div className="chips">{track.input.styles.map(style => <span className="chip" key={style}>{style}</span>)}{track.input.mood && <span className="chip">{track.input.mood}</span>}</div></div>
    {track.lyrics && <div className="detail-section"><h3>歌词</h3><div className="lyrics-downloads">{track.lyricsUrl && track.saveStatus === 'saved' && !track.deletedAt ? <a className="text-button" href={track.lyricsUrl} download><DownloadSimpleIcon />下载歌词 TXT</a> : <button className="text-button" onClick={() => downloadBlob(new Blob([track.lyrics], { type: 'text/plain;charset=utf-8' }), `${track.title}.txt`)}><DownloadSimpleIcon />下载歌词 TXT</button>}{track.timedLyricsUrl && track.saveStatus === 'saved' && !track.deletedAt && <a className="text-button" href={track.timedLyricsUrl} download><DownloadSimpleIcon />下载歌词 LRC</a>}{track.playbackUrl && track.lyricsUrl && !track.deletedAt && <a className="text-button" href={`/media/${track.id}?download=1&bundle=1`} download><DownloadSimpleIcon />音频与歌词打包下载</a>}</div><pre className="lyrics-preview">{track.lyrics}</pre></div>}
  </>}</Modal>;
}
