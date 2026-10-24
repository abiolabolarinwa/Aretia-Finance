/**
 * The picture of a Shield result, drawn in the browser (a canvas, no outside service): the colour, the answer, the top
 * findings, and where to check it yourself. It is what people post in a chat, so it carries the same warning as the page:
 * a result is a reading, not advice, and Shield never says something is safe.
 */
import { bandWord } from '../swings/shield/verdict.js';
import type { Band, Verdict } from '../swings/shield/types.js';

const COLOURS: Record<Band, { fill: string; ink: string }> = {
  green: { fill: '#1b8a4b', ink: '#ffffff' },
  yellow: { fill: '#f0be00', ink: '#2b2200' },
  orange: { fill: '#ee700e', ink: '#ffffff' },
  red: { fill: '#c62a1f', ink: '#ffffff' },
  grey: { fill: '#99999b', ink: '#ffffff' },
};

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1]!.replace(/\s*\S*$/, '…');
  }
  return lines;
}

const short = (v: string): string => (v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v);

/** Draws the card and returns it as a PNG. */
export function renderShareCard(v: Verdict, origin: string): Promise<Blob> {
  const W = 1200;
  const H = 630;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('This browser cannot draw the card.'));
  const font = '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif';
  const { fill, ink } = COLOURS[v.band];

  ctx.fillStyle = '#19191c';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(40, 40, W - 80, H - 80, 28);
  ctx.fill();

  // The colour band.
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(40, 40, W - 80, 150, [28, 28, 0, 0]);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.font = `700 22px ${font}`;
  ctx.fillText('ARETIA SHIELD', 80, 92);
  ctx.font = `800 60px ${font}`;
  ctx.fillText(bandWord(v.band), 80, 158);
  ctx.textAlign = 'right';
  ctx.font = `500 24px ${font}`;
  ctx.fillText(v.subject.label ? `${v.subject.label}  ·  ${short(v.subject.value)}` : short(v.subject.value), W - 80, 158);
  ctx.textAlign = 'left';

  // The answer, then the top findings.
  ctx.fillStyle = '#151518';
  ctx.font = `700 34px ${font}`;
  let y = 250;
  for (const line of wrap(ctx, v.headline, W - 160, 3)) {
    ctx.fillText(line, 80, y);
    y += 44;
  }
  y += 10;
  ctx.font = `500 25px ${font}`;
  ctx.fillStyle = '#626264';
  for (const f of v.findings.filter((x) => x.severity !== 'ok' && x.severity !== 'info').slice(0, 3)) {
    const lines = wrap(ctx, f.title, W - 200, 2);
    ctx.fillStyle = f.severity === 'bad' ? '#c62a1f' : f.severity === 'warn' ? '#ee700e' : '#b58900';
    ctx.beginPath();
    ctx.arc(92, y - 8, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#626264';
    for (const line of lines) {
      ctx.fillText(line, 116, y);
      y += 34;
    }
    y += 6;
  }

  ctx.fillStyle = '#838385';
  ctx.font = `500 21px ${font}`;
  ctx.fillText(`Check it yourself: ${origin.replace(/^https?:\/\//, '')}/wallet`, 80, H - 96);
  ctx.fillText('A reading of public data. Not advice, and Shield never says something is safe.', 80, H - 64);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The card could not be saved.'))), 'image/png'));
}
