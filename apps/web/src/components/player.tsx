import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { PlayIcon, PauseIcon, SpeakerHighIcon, SpeakerSlashIcon, XIcon, DownloadSimpleIcon, MusicNoteIcon, WaveformIcon } from '@phosphor-icons/react';
import type WaveSurfer from 'wavesurfer.js';
import type { Track } from '../../../../packages/shared/src/index';
import { formatTime } from '../lib/api';
import { toast } from 'sonner';

type PlayerState = { track: Track | null; playing: boolean; position: number; play: (track: Track) => void; audition: (track: Track, start?: number, end?: number) => void; pause: () => void };
const PlayerContext = createContext<PlayerState>({ track: null, playing: false, position: 0, play: () => {}, audition: () => {}, pause: () => {} });
export const usePlayer = () => useContext(PlayerContext);
export function PlayerProvider({ children }: { children: ReactNode }) {
  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.7);
  const audio = useRef<HTMLAudioElement>(null);
  const waveContainer = useRef<HTMLDivElement>(null);
  const [waveError, setWaveError] = useState(false);
  const segment = useRef<{ start: number; end?: number }>({ start: 0 });
  const pendingSeek = useRef<number | null>(null);
  function toggle() {
    const element = audio.current; if (!element || !track) return;
    if (element.paused) void element.play().catch(() => toast.error('暂时无法播放，请重新保存这首作品。'));
    else element.pause();
  }
  function play(next: Track) {
    segment.current = { start: 0 }; pendingSeek.current = null;
    if (!next.playbackUrl) { toast.info('音频还未保存好，请稍等或点击重新保存。'); return; }
    if (next.id === track?.id) toggle(); else { setPosition(0); setDuration(next.duration); setWaveError(false); setTrack(next); }
  }
  function audition(next: Track, start = 0, end?: number) {
    if (!next.playbackUrl) return;
    const from = start >= next.duration ? 0 : Math.max(0, start);
    segment.current = { start: from, end };
    if (track?.id === next.id && audio.current) {
      audio.current.currentTime = from / 1000; setPosition(from);
      void audio.current.play().catch(() => toast.error('暂时无法播放这首作品。'));
    } else {
      pendingSeek.current = from; setPosition(from); setDuration(next.duration); setWaveError(false); setTrack(next);
    }
  }
  useEffect(() => {
    if (track && audio.current) { audio.current.load(); void audio.current.play().catch(() => toast.info('点击播放按钮开始试听。')); }
  }, [track?.id]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume]);
  useEffect(() => {
    if (!track || !audio.current || !waveContainer.current) return;
    let alive = true;
    let wave: WaveSurfer | undefined;
    void import('wavesurfer.js').then(({ default: Wave }) => {
      if (!alive || !audio.current || !waveContainer.current) return;
      wave = Wave.create({ container: waveContainer.current, media: audio.current, height: 34, waveColor: '#c2cce1', progressColor: '#2b5ce2', cursorWidth: 0, barWidth: 2, barGap: 3, barRadius: 2, normalize: true });
      wave.on('error', () => { if (alive) setWaveError(true); });
    }).catch(() => { if (alive) setWaveError(true); });
    return () => { alive = false; wave?.destroy(); };
  }, [track?.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.code === 'Space' && track && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(target.tagName) && !target.isContentEditable && !document.querySelector('[role="dialog"]')) { event.preventDefault(); toggle(); }
    };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [track]);
  return <PlayerContext.Provider value={{ track, playing, position, play, audition, pause: () => audio.current?.pause() }}>
    {children}
    <audio ref={audio} src={track?.playbackUrl || undefined} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={() => {
      const element = audio.current; if (!element) return;
      const end = segment.current.end;
      if (end !== undefined && element.currentTime * 1000 >= end) { element.pause(); element.currentTime = end / 1000; segment.current.end = undefined; }
      setPosition(element.currentTime * 1000);
    }} onLoadedMetadata={() => {
      setDuration((audio.current?.duration || 0) * 1000);
      if (audio.current && pendingSeek.current !== null) { audio.current.currentTime = pendingSeek.current / 1000; pendingSeek.current = null; }
    }} onError={() => track && toast.error('音频无法读取，请重新保存作品。')} />
    {track && <div className="player-bar" aria-label="音乐播放器">
      <div className="player-info"><div className="mini-cover"><MusicNoteIcon weight="fill" /></div><div><strong>{track.title}</strong><span>{track.downloadUrl ? '我的声音素材' : `橙蓝原创 · ${track.mode === 'instrumental' ? '纯音乐' : '歌曲'}`}</span></div></div>
      <button className="player-play" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>{playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}</button>
      <div className="player-progress"><div ref={waveContainer} className={waveError ? 'wave-failed' : ''} />{waveError && <WaveformIcon className="wave-fallback" />}
        <input aria-label="播放进度" type="range" min={0} step={1000} max={duration || 1} value={position} onChange={event => { if (audio.current) audio.current.currentTime = Number(event.target.value) / 1000; setPosition(Number(event.target.value)); }} />
      </div>
      <span className="player-time">{formatTime(position)} <i>/</i> {formatTime(duration)}</span>
      <div className="player-volume"><button className="icon-button" onClick={() => setVolume(volume ? 0 : 0.7)} aria-label={volume ? '静音' : '取消静音'}>{volume ? <SpeakerHighIcon size={20} /> : <SpeakerSlashIcon size={20} />}</button><input aria-label="音量" type="range" min={0} max={1} step={0.01} value={volume} onChange={event => setVolume(Number(event.target.value))} /></div>
      <a className="icon-button" href={track.downloadUrl || `/media/${track.id}?download=1`} download title="下载音频" aria-label="下载音频"><DownloadSimpleIcon size={20} /></a>
      <button className="icon-button" aria-label="收起播放器" onClick={() => { audio.current?.pause(); setTrack(null); }}><XIcon size={18} /></button>
    </div>}
  </PlayerContext.Provider>;
}
