// An original synthesized example, generated entirely in the browser. No API calls.
export function demoAudio(seconds = 18): Blob {
  const rate = 16000; const samples = Math.round(rate * seconds); const bytes = new ArrayBuffer(44 + samples * 2); const view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);
  const notes = [261.63, 329.63, 392, 523.25, 440, 392, 329.63, 293.66, 349.23, 440, 523.25, 659.25, 587.33, 440, 392, 329.63];
  for (let i = 0; i < samples; i++) {
    const time = i / rate; const step = Math.floor(time / 0.375); const envelope = Math.min(1, (time % 0.375) * 80) * Math.exp(-6 * (time % 0.375));
    const hz = notes[step % notes.length];
    const tone = Math.sin(time * Math.PI * 2 * hz) * 0.15 + Math.sin(time * Math.PI * 4 * hz) * 0.04;
    const bass = Math.sin(time * Math.PI * 2 * [130.81, 110, 87.31, 98][Math.floor(time / 1.5) % 4]) * 0.06;
    const fade = Math.min(1, time * 3, (seconds - time) * 3);
    view.setInt16(44 + i * 2, Math.round((tone * envelope + bass) * fade * 32767), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
