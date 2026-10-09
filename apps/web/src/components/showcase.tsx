import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightIcon, DownloadSimpleIcon, MusicNotesIcon } from '@phosphor-icons/react';
import { styles } from '../../../../packages/shared/src/index';
import showcase from '../content/showcase.json';
import './showcase.css';

type FeaturedSong = (typeof showcase)[number];
const stories: Record<string, { eyebrow: string; description: string; motif: string }> = {
  'neon-after-rain': {
    eyebrow: '雨夜电影感 · 纯音乐',
    description: '从雨窗外的霓虹出发：一段简洁的钢琴主旋律，在温暖的合成器与回声之间缓缓延展。',
    motif: 'NEON / AFTER RAIN',
  },
  'anthem-of-life': {
    eyebrow: '交响与合唱 · 英文歌曲',
    description: '从轻柔的钢琴和弦乐出发，让领唱、铜管与合唱逐步汇聚，写给生命与希望。',
    motif: 'ANTHEM / OF LIFE',
  },
};

const duration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;
const modelName = (model: string) => model.replace(/^mureka-/i, 'Mureka V');
const styleName = (value: string) => styles.find(style => style.value === value)?.label || value;

function ShowcaseCard({ song, index }: { song: FeaturedSong; index: number }) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const story = stories[song.slug];
  const base = `/showcase/${song.slug}`;
  return <article className={`showcase-card showcase-${song.slug}`}>
    <div className="showcase-cover" aria-hidden="true">
      <div className="showcase-cover-glow" /><MusicNotesIcon size={42} weight="duotone" />
      <span className="showcase-cover-index">0{index + 1} / 02</span><span className="showcase-cover-motif">{story.motif}</span>
    </div>
    <div className="showcase-card-content">
      <div className="showcase-card-top"><span className="showcase-real-badge">真实精选作品</span><span>{duration(song.durationMs)} · {modelName(song.model)}</span></div>
      <p className="showcase-eyebrow">{story.eyebrow}</p>
      <h3>{song.title}</h3><p className="showcase-description">{story.description}</p>
      <div className="showcase-player">
        <audio controls preload="none" src={`${base}.mp3`} aria-label={`试听${song.title}`} onPlay={() => { setLoading(true); setFailed(false); }} onWaiting={() => setLoading(true)} onCanPlay={() => setLoading(false)} onPlaying={() => setLoading(false)} onError={() => { setLoading(false); setFailed(true); }} />
        <p role="status" aria-live="polite">点击播放后，音频可能需要一点时间加载，请耐心等待。{failed ? ' 音频暂时无法加载，请稍后重试。' : loading ? ' 正在加载音频…' : ''}</p>
      </div>
      <details className="showcase-details"><summary>查看完整提示词与创作配置 <span>+</span></summary>
        <div className="showcase-details-inner"><p className="showcase-original-label">当时提交的原始提示词 · 原文</p><pre>{song.prompt}</pre>
          <dl>
            <div><dt>创作模型</dt><dd>{modelName(song.model)}</dd></div>
            <div><dt>创作方式</dt><dd>{song.mode === 'instrumental' ? '纯音乐生成' : '一句话写歌'}</dd></div>
            <div><dt>风格标签</dt><dd>{song.styles.length ? song.styles.map(styleName).join(' · ') : '未单独选择，详见原始提示词'}</dd></div>
            <div><dt>情绪氛围</dt><dd>{song.mood || '未单独指定'}</dd></div>
            <div><dt>语言与人声</dt><dd>{song.mode === 'instrumental' ? '无人声' : `${song.language} · ${song.gender === 'auto' ? '声线由模型决定' : song.gender}`}</dd></div>
            <div><dt>生成数量</dt><dd>{song.count} 首</dd></div>
          </dl>
          <p className="showcase-config-note">这些是作品当时保存的真实输入与配置；生成结果会因模型与时间而变化。</p>
        </div>
      </details>
      <div className="showcase-downloads"><a href={`${base}.mp3`} download={`${song.title}.mp3`}><DownloadSimpleIcon size={17} />下载 MP3</a>{song.lyricsAvailable && <><a href={`${base}.txt`} download={`${song.title}.txt`}>歌词 TXT</a><a href={`${base}.lrc`} download={`${song.title}.lrc`}>同步歌词 LRC</a></>}</div>
    </div>
  </article>;
}

export function Showcase() {
  return <section className="showcase" aria-labelledby="showcase-title"><div className="showcase-intro"><div><span className="showcase-heading-label">CURATED MUSIC · 橙蓝精选</span><h2 id="showcase-title">从一句灵感，听见整首作品<span>。</span></h2><p>两首由管理员真实创作的音乐。边听边看原始提示词与配置，感受创作方向如何变成完整作品。</p></div><Link to="/register">开始自己的创作 <ArrowRightIcon size={17} /></Link></div><div className="showcase-grid">{showcase.map((song, index) => <ShowcaseCard key={song.slug} song={song} index={index} />)}</div></section>;
}
