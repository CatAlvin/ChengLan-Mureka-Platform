import { CostHint } from './credits';
import { canUseCredits, quoteCredits } from '../../../../packages/shared/src/credits';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { SparkleIcon, CaretDownIcon, ArrowRightIcon, CheckCircleIcon, CircleNotchIcon, LightbulbIcon, FloppyDiskIcon, ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Modal } from './modal';
import { SourcePicker } from './source-picker';
import { CollectionSelect, CollectionManager } from './library-tools';
import { api, ApiError, saveDraft, storageKey } from '../lib/api';
import { buildPrompt, creationModel, draftSchema, emptyDraft, generationSchema, moods, styles, type CreativeInput, type Job, type Mode, type Snapshot } from '../../../../packages/shared/src/index';

type DraftRecord = { mode: string; input: CreativeInput; updatedAt: number };
type PendingSubmission = { submissionId: string; input: CreativeInput; endpoint: string };
function readLocal(mode: Mode): { input: CreativeInput; updatedAt: number } | null {
  try { const saved = JSON.parse(localStorage.getItem(storageKey(`chenglan.draft.${mode}`)) || 'null'); return saved ? { input: draftSchema.parse(saved.input), updatedAt: saved.updatedAt } : null; } catch { return null; }
}
function readPending(): PendingSubmission | null {
  try { const raw = JSON.parse(localStorage.getItem(storageKey('chenglan.pending')) || 'null'); return raw?.submissionId && ['/api/jobs', '/api/lyrics'].includes(raw.endpoint) ? { ...raw, input: draftSchema.parse(raw.input) } : null; } catch { return null; }
}
export function CreateForm({ mode, drafts, preset, snapshot, onCreated }: { mode: Mode; drafts: DraftRecord[]; preset: CreativeInput | null; snapshot?: Snapshot; onCreated: () => void }) {
  const server = drafts.find(d => d.mode === mode);
  const local = readLocal(mode);
  const initial = preset || (local && local.updatedAt > (server?.updatedAt || 0) ? local.input : server?.input) || emptyDraft(mode);
  const { register, control, getValues, setValue, watch, setError, clearErrors, reset, setFocus, formState: { errors } } = useForm<CreativeInput>({ defaultValues: initial });
  const values = useWatch({ control }) as CreativeInput;
  const model = creationModel(values);
  const client = useQueryClient();
  const [saved, setSaved] = useState<'saved' | 'saving' | 'local'>('saved');
  const [submitting, setSubmitting] = useState(false);
  const submissionLock = useRef(false);
  const [pending, setPending] = useState<PendingSubmission | null>(readPending);
  const [lyricsJobId, setLyricsJobId] = useState<string | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const previousLyrics = useRef<string | null>(null);
  const sequence = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveNow = useRef<(input: CreativeInput) => void>(() => {});
  const advanced = useRef<HTMLDetailsElement>(null);
  const [resetRevision, setResetRevision] = useState(0);
  const lyricsJob = snapshot?.jobs.find(job => job.id === lyricsJobId);
  const [showMoreStyles, setShowMoreStyles] = useState(false);
  const activeLyrics = lyricsJob && !['succeeded', 'failed', 'timeouted', 'cancelled', 'submission_unknown'].includes(lyricsJob.status);
  useEffect(() => { if (resetRevision) setFocus('prompt'); }, [resetRevision, setFocus]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: CreativeInput | undefined;
    let alive = true;
    const persist = async (input: CreativeInput, version: number) => {
      // Preserve ordering: an older in-flight draft must never overwrite a reset.
      const saving = saveQueue.current.catch(() => {}).then(() => saveDraft(input));
      saveQueue.current = saving.then(() => {}, () => {});
      try { await saving; if (alive && version === sequence.current) setSaved('saved'); }
      catch { if (alive && version === sequence.current) setSaved('local'); }
    };
    function schedule(input: CreativeInput, immediate = false) {
      latest = input; const version = ++sequence.current; setSaved('saving');
      try { localStorage.setItem(storageKey(`chenglan.draft.${mode}`), JSON.stringify({ input, updatedAt: Date.now() })); } catch { /* Server save remains available. */ }
      clearTimeout(timer);
      if (immediate) { latest = undefined; void persist(input, version); }
      else timer = setTimeout(() => { latest = undefined; void persist(input, version); }, 800);
    }
    saveNow.current = input => schedule(input, true);
    if (preset) schedule(getValues());
    const subscription = watch(value => { const input = draftSchema.safeParse(value); if (input.success) schedule(input.data); });
    return () => { alive = false; subscription.unsubscribe(); clearTimeout(timer); if (latest) void persist(latest, sequence.current); };
  }, [watch, mode, getValues, preset]);

  useEffect(() => {
    if (pending && snapshot?.jobs.some(job => job.submissionId === pending.submissionId)) {
      const job = snapshot.jobs.find(job => job.submissionId === pending.submissionId)!;
      if (job.kind === 'lyrics') setLyricsJobId(job.id);
      localStorage.removeItem(storageKey('chenglan.pending')); setPending(null);
    }
  }, [snapshot, pending]);

  async function send(entry: PendingSubmission) {
    if (submissionLock.current) return;
    submissionLock.current = true;
    setSubmitting(true); setPending(entry);
    try { localStorage.setItem(storageKey('chenglan.pending'), JSON.stringify(entry)); } catch { /* In-memory idempotency still applies. */ }
    try {
      const job = await api<Job>(entry.endpoint, { method: 'POST', body: { submissionId: entry.submissionId, input: entry.input } });
      localStorage.removeItem(storageKey('chenglan.pending')); setPending(null);
      if (job.kind === 'lyrics') setLyricsJobId(job.id);
      toast.success(job.kind === 'lyrics' ? '歌词创作已加入队列' : '灵感已收到，正在为你安排创作');
      await client.invalidateQueries({ queryKey: ['snapshot'] }); onCreated();
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) { localStorage.removeItem(storageKey('chenglan.pending')); setPending(null); }
      toast.error(error instanceof Error ? error.message : '连接暂时中断，可点击“确认上次提交”恢复。');
    }
    finally { submissionLock.current = false; setSubmitting(false); }
  }
  function submit(lyrics = false) {
    if (pending) { void send(pending); return; }
    clearErrors();
    const input = getValues();
    if (lyrics) {
      if (!input.prompt.trim()) { setError('prompt', { message: '先写下歌词主题或故事，再让 AI 帮你创作' }, { shouldFocus: true }); return; }
    } else {
      const checked = generationSchema.safeParse(input);
      if (!checked.success) {
        checked.error.issues.forEach(issue => setError(issue.path[0] as keyof CreativeInput, { message: issue.message }, { shouldFocus: true }));
        return;
      }
    }
    void send({ submissionId: crypto.randomUUID(), input, endpoint: lyrics ? '/api/lyrics' : '/api/jobs' });
  }
  function toggleStyle(style: CreativeInput['styles'][number]) {
    const current = getValues('styles');
    if (!current.includes(style) && current.length >= 5) { toast.info('最多选择 5 种风格，让方向更清楚一些。'); return; }
    setValue('styles', current.includes(style) ? current.filter(value => value !== style) : [...current, style], { shouldDirty: true });
  }
  function startFresh() {
    if (submissionLock.current) return;
    const blank = { ...emptyDraft(mode), source: null, collectionId: null };
    reset(blank);
    saveNow.current(blank);
    previousLyrics.current = null;
    setLyricsJobId(null); setLyricsOpen(false); setShowMoreStyles(false);
    setResetRevision(value => value + 1);
    if (advanced.current) advanced.current.open = false;
    toast.success('已清空输入并恢复默认选项，可以开始新的创作');
  }
  const sourceDriven = !!values.source && mode !== 'easy';
  const promptLimit = mode === 'easy' ? 2000 : 1024;
  const promptLength = buildPrompt({ ...emptyDraft(mode), ...values }).length;
  return <form className="creation-form" onSubmit={event => { event.preventDefault(); submit(); }}>
    <div className="fresh-creation"><span>准备写下一首？</span><button type="button" className="text-button" onClick={startFresh} disabled={submitting}><ArrowCounterClockwiseIcon />清空并开始新创作</button></div>
    {pending && <div className="notice warning"><span>上次提交的结果还在确认中。再次确认会沿用同一个请求，不重复创建创作任务。</span><button type="button" onClick={() => void send(pending)} disabled={submitting}>确认上次提交</button></div>}
    <div className="form-section">
      <div className="label-row"><label htmlFor="prompt">{mode === 'lyrics' ? '这首歌的故事与风格' : mode === 'instrumental' ? '你想要什么样的纯音乐？' : '想把什么唱成一首歌？'}</label><span>{mode === 'lyrics' ? '可选' : '从一句话开始'}</span></div>
      <div className={`prompt-box ${errors.prompt ? 'invalid' : ''}`}>
        <textarea id="prompt" disabled={sourceDriven && mode === 'instrumental'} {...register('prompt')} maxLength={3000} aria-invalid={!!errors.prompt} aria-describedby={errors.prompt ? 'prompt-error' : undefined} placeholder={mode === 'instrumental' ? '例如：午后咖啡馆里的轻爵士，柔和的钢琴和萨克斯，适合放松阅读…' : mode === 'lyrics' ? '描述你的故事，也可以只写曲风，例如：温暖的民谣，木吉他，轻快自然。' : '例如：写一首关于夏日旅行的歌，有海风、落日和朋友，轻快的民谣风格…'} rows={5} />
        <div className="prompt-meta"><span><LightbulbIcon size={14} /> 场景、心情、想说的话，都可以</span>{!sourceDriven && <span className={promptLength > promptLimit ? 'text-danger' : ''}>{promptLength}/{promptLimit}</span>}</div>
      </div>
      {errors.prompt && <p className="field-error" id="prompt-error">{errors.prompt.message}</p>}
    </div>
    {mode === 'lyrics' && <div className="form-section lyrics-editor">
      <div className="label-row"><label htmlFor="lyrics">你的歌词</label><button type="button" className="text-button" disabled={!!activeLyrics || submitting || !!pending || !canUseCredits(snapshot?.credits, quoteCredits('lyrics'))} onClick={() => submit(true)}><SparkleIcon />{activeLyrics ? '正在写歌词…' : '帮我写歌词 · 8 点'}</button></div>
      <div className="lyrics-toolbar">{[['主歌', '[Verse]'], ['副歌', '[Chorus]'], ['桥段', '[Bridge]']].map(([label, marker]) => <button key={label} type="button" onClick={() => setValue('lyrics', `${getValues('lyrics')}${getValues('lyrics') ? '\n\n' : ''}${marker}\n`)}>＋ {label}</button>)}{previousLyrics.current !== null && <button type="button" onClick={() => { const current = getValues('lyrics'); setValue('lyrics', previousLyrics.current!); previousLyrics.current = current; }}><ArrowCounterClockwiseIcon /> 撤销替换</button>}</div>
      <textarea id="lyrics" {...register('lyrics')} maxLength={8000} rows={8} placeholder={'[Verse]\n写下你的第一句…\n\n[Chorus]\n让最想说的话成为副歌'} aria-invalid={!!errors.lyrics} />
      <div className="field-help"><span>AI 写歌词单独计费，生成后可先预览再采用</span><span>{values.lyrics?.length || 0}/5000</span></div>
      {errors.lyrics && <p className="field-error">{errors.lyrics.message}</p>}
      {lyricsJob?.result && <button className="lyrics-ready" type="button" onClick={() => setLyricsOpen(true)}><CheckCircleIcon /> 歌词初稿已完成，点击预览 <ArrowRightIcon /></button>}
      {lyricsJob?.error && <p className="field-error">{lyricsJob.error}</p>}
    </div>}
    <SourcePicker key={resetRevision} mode={mode} value={values.source} materials={snapshot?.materials} disabled={submitting || !!pending} onChange={source => { setValue('source', source, { shouldDirty: true }); clearErrors('source'); }} />
    {errors.source && <p className="field-error">{errors.source.message}</p>}
    {sourceDriven && <p className="field-help source-note">音乐走向由所选素材决定。{mode === 'lyrics' ? '上方的故事仍可用于“帮我写歌词”。' : '移除参考曲后，可以重新使用文字描述和风格。'}</p>}
    <fieldset className="source-style-fields" disabled={sourceDriven}><div className="form-section"><div className="label-row"><label>挑一种音乐风格</label><span>可多选</span></div>
      <div className="chips">{(showMoreStyles ? styles : styles.slice(0, 8)).map(style => <button key={style.value} type="button" aria-pressed={values.styles?.includes(style.value)} className={`chip ${values.styles?.includes(style.value) ? 'selected' : ''}`} onClick={() => toggleStyle(style.value)}>{style.label}</button>)}<button className="chip more-chip" type="button" onClick={() => setShowMoreStyles(!showMoreStyles)}>{showMoreStyles ? '收起' : '更多'} <CaretDownIcon /></button></div>
    </div>
    <div className="form-section"><div className="label-row"><label>希望听起来…</label><span>选择心情</span></div><div className="mood-chips">{moods.map(mood => <button type="button" key={mood} aria-pressed={values.mood === mood} className={`mood-chip ${values.mood === mood ? 'selected' : ''}`} onClick={() => setValue('mood', values.mood === mood ? '' : mood)}><span className={`mood-dot mood-${moods.indexOf(mood)}`} />{mood}</button>)}</div></div>
    </fieldset>
    <details className="advanced-settings" ref={advanced}><summary>更多创作设置 <CaretDownIcon /></summary><div className="advanced-content">
      <label>作品名称 <span className="optional">选填</span><input {...register('title')} placeholder="留空也没关系，之后可以改名" maxLength={80} /></label>
      <div className="form-two-columns">{mode !== 'instrumental' && <label>歌词语言<select {...register('language')}><option>中文</option><option>英文</option><option>日语</option><option>韩语</option></select></label>}{mode === 'lyrics' && <label>人声倾向<select disabled={values.source?.kind === 'melody'} {...register('gender')}><option value="auto">交给 AI</option><option value="female">女声</option><option value="male">男声</option></select></label>}</div>
      <p className="field-help">{values.source?.kind === 'melody' ? '哼唱创作使用 Mureka V8，声音倾向随旋律素材决定。' : '默认使用 Mureka V9.5，也可以在下方选择 V9 或 V8。'}</p>
    </div></details>
    <div className="collection-controls"><CollectionSelect collections={snapshot?.collections} value={values.collectionId} disabled={submitting || !!pending} onChange={id => setValue('collectionId', id, { shouldDirty: true })} /><CollectionManager collections={snapshot?.collections} onCreated={id => setValue('collectionId', id, { shouldDirty: true })} /></div>
    {errors.collectionId && <p className="field-error">{errors.collectionId.message}</p>}
    <label className="model-select">创作模型<select {...register('model')} value={model} disabled={values.source?.kind === 'melody'}><option value="mureka-9.5">Mureka V9.5 · 默认</option><option value="mureka-9">Mureka V9</option><option value="mureka-8">Mureka V8</option></select></label>
    {values.source?.kind === 'melody' && <p className="field-help">哼唱旋律引导使用 V8，按 V8 价格计费。</p>}
    <CostHint quote={quoteCredits(mode === 'instrumental' ? 'instrumental' : 'song', {mode, count: values.count || 1}, undefined, model)} balance={snapshot?.credits} />
    <div className="form-footer"><div className="generation-options"><label htmlFor="count">本次生成</label><select id="count" {...register('count', { valueAsNumber: true })}><option value={1}>1 首作品</option><option value={2}>2 首作品</option><option value={3}>3 首作品</option></select><span className="save-indicator" role="status">{saved === 'saving' ? <CircleNotchIcon className="spin" /> : saved === 'saved' ? <CheckCircleIcon /> : <FloppyDiskIcon />}{saved === 'saving' ? '保存中' : saved === 'saved' ? '草稿已保存' : '已留在此浏览器'}</span></div>
      <Button className="generate-button" type="submit" disabled={submitting || !snapshot?.account.configured || !pending && !canUseCredits(snapshot?.credits, quoteCredits(mode === 'instrumental' ? 'instrumental' : 'song', { mode, count: values.count || 1 }, undefined, model))}>{submitting ? <CircleNotchIcon className="spin" /> : <SparkleIcon weight="fill" />} {pending ? '确认上次提交' : `开始创作 · ${values.count || 1} 首`} <ArrowRightIcon /></Button>
      <p className="cost-note">按生成数量计费，实际费用以 Mureka 账单为准</p>
      {snapshot?.account.configured && !snapshot.account.connected && <p className="field-help">当前连接未就绪，提交后会保留在创作队列。</p>}
      {!snapshot?.account.configured && <p className="field-help">正在检测创作服务，稍后即可开始创作。</p>}
    </div>
    <Modal open={lyricsOpen} onOpenChange={setLyricsOpen} title={lyricsJob?.result?.title || '歌词初稿'} description="预览后再决定是否替换当前歌词，原稿会保留为可撤销版本。"><pre className="lyrics-preview">{lyricsJob?.result?.lyrics}</pre><Button className="primary-button" type="button" onClick={() => { previousLyrics.current = getValues('lyrics'); setValue('lyrics', lyricsJob!.result!.lyrics); if (!getValues('title')) setValue('title', lyricsJob!.result!.title.slice(0, 80)); setLyricsOpen(false); toast.success('已采用这份歌词，可以继续修改'); }}>使用这份歌词</Button></Modal>
  </form>;
}
