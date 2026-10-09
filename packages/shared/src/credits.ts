import type { CreativeInput, JobKind, ToolInput } from './index.js';

// API China pricing, verified 2026-10-09: https://platform.mureka.cn/pricing
// One point is one Chinese cent. Wallets still store hundredths of a point for existing ledgers.
export const pointsForCents = (cents: number) => cents;
export const WEEKLY_POINTS = 1000;
export const LAST_USE_MAX_CENTS = 300;
export type CreditQuote = { points: number; cents: number | null; label: string; uncertain: boolean };
export type CreditBalance = { unlimited: boolean; balance: number; held: number; nextReset: number; weekly: number };
export function canUseCredits(balance: CreditBalance | undefined, quote: CreditQuote) {
  if (!balance) return false;
  return balance.unlimited || balance.balance >= quote.points || !!(balance.balance > 0 && quote.cents !== null && quote.cents > 0 && quote.cents <= LAST_USE_MAX_CENTS);
}
export function isLastUse(balance: CreditBalance | undefined, quote: CreditQuote) {
  return !!balance && !balance.unlimited && balance.balance > 0 && balance.balance < quote.points && quote.cents !== null && quote.cents > 0 && quote.cents <= LAST_USE_MAX_CENTS;
}
export function quoteCredits(kind: JobKind, input?: Pick<CreativeInput, 'mode' | 'count'>, tool?: ToolInput, model = 'mureka-8', outputs?: number): CreditQuote {
  let cents: number | null = null;
  let label = '费用待核实';
  const count = outputs ?? input?.count ?? 1;
  if (kind === 'import' || kind === 'crop') { cents = 0; label = '本地处理'; }
  else if (kind === 'song' || kind === 'instrumental') {
    const supported = /^(mureka-)?(v)?(8|9|9\.5|7\.6|o2)$/i.test(model);
    if (supported) cents = (input?.mode === 'easy' ? (model.includes('9.5') ? 300 : 200) : model.includes('9.5') ? 100 : model.includes('7.6') ? 25 : 33) * count;
    label = input?.mode === 'easy' ? '一句话写歌' : kind === 'instrumental' ? '纯音乐' : '自定义歌曲';
  } else if (kind === 'stem') { cents = tool?.operation === 'stem' ? ({ band: 50, vocals: 150, detailed: 300 })[tool.preset] : null; label = '音频分轨'; }
  else {
    const prices: Partial<Record<JobKind, [number, string]>> = { lyrics: [8, '生成歌词'], lyrics_extend: [2, '接写一句'], recognize: [8, '识别歌词'], describe: [60, '分析音乐'], track: [60, '单轨生成'], extend: [95, '续写歌曲'], region_edit: [95, '局部重唱'], remix: [150, '整首重制'], transcribe: [150, '音乐转谱'] };
    const price = prices[kind]; if (price) { cents = price[0] * (outputs !== undefined && ['track', 'extend', 'region_edit', 'remix'].includes(kind) ? outputs : 1); label = price[1]; }
  }
  return { cents, points: cents === null ? 20 : pointsForCents(cents), label, uncertain: cents === null };
}
export const CREDIT_PRICE_ROWS = [
  ['自定义歌曲 / 纯音乐（V8）', 33], ['一句话直接写歌（V8）', 200], ['生成完整歌词 / 识别歌词', 8], ['接写一句歌词', 2],
  ['续写歌曲 / 局部重唱', 95], ['单轨生成 / 分析音乐', 60], ['整首重制 / 音乐转谱 / 人声伴奏分离', 150], ['乐队分轨', 50], ['精细分轨 + MIDI', 300], ['上传 / 裁剪 / 下载', 0],
] as const;
