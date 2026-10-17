/**
 * Builds the ffmpeg commands for an export. Every clip is rendered on its own (trim, speed,
 * freeze, reframing crop, scaling, HDR keep/tone-map and its overlay from stdin) into a
 * segment, the sound of the whole export is mixed once (clip audio, music, fades), and the
 * segments are joined without re-encoding. One clip at a time keeps memory flat however many
 * cuts a round has. Pure functions of the project, so they are unit-tested without ffmpeg.
 *
 * Timing: every clip boundary is snapped to the output frame grid, so a clip gets exactly
 * round(end·fps) − round(start·fps) frames and the export has round(duration·fps) frames.
 * `times` says which timeline second each export frame shows; the overlay is rendered at
 * those times and the sound is cut at the same frame boundaries, so nothing drifts.
 */
import {
  aspectRatio,
  clipDuration,
  clipStarts,
  cropAt,
  outputSize,
  timelineDuration,
  type Aspect,
  type ExportSettings,
  type Project,
  type ReframeKey,
} from '@golf/schema';

export interface MediaFile {
  id: string;
  path: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  hdr: boolean;
  hasAudio: boolean;
  color?: Record<string, string>;
}

export interface Encoders {
  h264: 'h264_nvenc' | 'libx264';
  hevc: 'hevc_nvenc' | 'libx265';
  tonemap: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlanInput {
  project: Project;
  settings: ExportSettings;
  media: Record<string, MediaFile>;
  maxShortSide?: number;
  encoders: Encoders;
}

/** Output frame rate as a fraction (59.94 is 60000/1001, so frame times are exact). */
export interface Rate {
  num: number;
  den: number;
}

/** The part of one clip that is in the export. */
export interface Segment {
  /** Index in project.clips. */
  clip: number;
  /** First export frame of the segment, and how many frames it has. */
  start: number;
  frames: number;
  /** Clip frames left out at the start (a range that begins inside the clip). */
  skip: number;
}

/** Overlay of one segment: one box, and the segment frames that are piped (others draw nothing). */
export interface SegmentOverlay {
  box: Box;
  /** Segment-local frame ranges [from, to), in order; frames outside them are not sent. */
  runs: [number, number][];
}

export interface Plan {
  width: number;
  height: number;
  fps: number;
  rate: Rate;
  duration: number;
  /** Timeline seconds of output frame 0 (range start). */
  t0: number;
  frames: number;
  /** Timeline frame (on the output grid) of export frame 0. */
  firstFrame: number;
  /** Timeline second shown by each export frame. */
  times: Float64Array;
  segments: Segment[];
  hdr: boolean;
  /** HDR was asked for, but the clips mix HDR and SDR (or HDR kinds), so the export is SDR. */
  mixedHdr: boolean;
  aspect: Aspect;
  /** What the command builders need. */
  project: Project;
  media: Record<string, MediaFile>;
  encoders: Encoders;
  color: Record<string, string>;
}

const f6 = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
const SR = 48000;

/** atempo only accepts 0.5..2 (100 in newer builds); chain it for larger factors. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${f6(s)}`);
  return out;
}

/** ffmpeg expression for one crop coordinate over a clip (t = seconds since clip start). */
export function cropExpr(keys: readonly ReframeKey[], axis: 'cx' | 'cy', clipStart: number, srcLen: number, cropLen: number): string {
  const px = (k: ReframeKey) => Math.min(Math.max(k[axis] * srcLen - cropLen / 2, 0), srcLen - cropLen);
  if (keys.length === 0) return f6((srcLen - cropLen) / 2);
  if (keys.length === 1) return f6(px(keys[0]));
  const T = `(t+${f6(clipStart)})`;
  // Nested if: before the first key, between keys (smoothstep), after the last.
  let expr = f6(px(keys[keys.length - 1]));
  for (let i = keys.length - 1; i >= 1; i--) {
    const a = keys[i - 1];
    const b = keys[i];
    const span = Math.max(1e-6, b.t - a.t);
    const u = `clip((${T}-${f6(a.t)})/${f6(span)},0,1)`;
    const seg = `(${f6(px(a))}+(${f6(px(b) - px(a))})*${u}*${u}*(3-2*${u}))`;
    expr = `if(lt(${T},${f6(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${T},${f6(keys[0].t)}),${f6(px(keys[0]))},${expr})`;
}

/** 29.97/59.94/23.976 as their exact NTSC fractions, whole rates as themselves. */
export function frameRate(fps: number): Rate {
  if (Math.abs(fps - Math.round(fps)) < 1e-3) return { num: Math.round(fps), den: 1 };
  const ntsc = Math.round(fps * 1.001);
  if (Math.abs(fps - ntsc / 1.001) < 5e-3) return { num: ntsc * 1000, den: 1001 };
  return { num: Math.round(fps * 1000), den: 1000 };
}

const rateArg = (r: Rate) => (r.den === 1 ? `${r.num}` : `${r.num}/${r.den}`);

/** Same transfer and primaries (the output can carry only one set of HDR tags). */
function sameHdrKind(a: MediaFile, b: MediaFile): boolean {
  return (a.color?.color_trc ?? '') === (b.color?.color_trc ?? '') && (a.color?.color_primaries ?? '') === (b.color?.color_primaries ?? '');
}

export function buildPlan(inp: PlanInput): Plan {
  const { project, settings, media, encoders } = inp;
  const first = project.clips[0];
  if (!first) throw new Error('The project has no clips');
  const primary = media[first.mediaId];
  if (!primary) throw new Error('The video is missing');
  project.clips.forEach((c, i) => {
    if (!media[c.mediaId]) throw new Error(`Clip ${i + 1} is missing its video`);
  });
  // Shorts are vertical by definition.
  const aspect: Aspect = settings.preset === 'shorts' ? '9:16' : project.format.aspect;
  const proj: Project = aspect === project.format.aspect ? project : { ...project, format: { ...project.format, aspect } };
  const { width: W, height: H } = outputSize(aspect, settings.preset, primary, inp.maxShortSide);
  const fps = settings.fps === 'source' ? Math.min(60, Math.round(primary.fps * 1000) / 1000 || 30) : settings.fps;
  const rate = frameRate(fps);
  const F = rate.num / rate.den;
  // HDR is kept only when every clip is HDR of the same kind: SDR clips tagged as HLG/PQ
  // would look wrong, so a mix is exported as SDR (the HDR clips tone-mapped).
  const clipMedia = project.clips.map((c) => media[c.mediaId]);
  const allHdr = clipMedia.every((m) => m.hdr && sameHdrKind(m, primary));
  const keepHdr = settings.hdr === 'keep' && allHdr;
  const mixedHdr = settings.hdr === 'keep' && !allHdr && clipMedia.some((m) => m.hdr);

  // The frame grid: clip i covers frames [B[i], B[i+1]) of the timeline.
  const total = timelineDuration(project);
  const starts = clipStarts(project.clips);
  const grid = (t: number) => Math.round(t * F);
  const B = [...starts.map(grid), grid(total)];
  const t0 = settings.range ? Math.max(0, Math.min(settings.range.start, total)) : 0;
  const t1 = settings.range ? Math.max(t0 + 0.1, Math.min(settings.range.end, total)) : total;
  const g0 = Math.min(grid(t0), B[B.length - 1] - 1);
  const g1 = Math.min(B[B.length - 1], Math.max(g0 + 1, grid(t1)));
  if (g1 <= g0) throw new Error('The video is too short to export');

  const segments: Segment[] = [];
  const times = new Float64Array(g1 - g0);
  project.clips.forEach((c, i) => {
    const a = Math.max(B[i], g0);
    const b = Math.min(B[i + 1], g1);
    if (b <= a) return;
    segments.push({ clip: i, start: a - g0, frames: b - a, skip: a - B[i] });
    // The clip shows clip-local second j/fps at its frame j (see segmentArgs); a frame that
    // rounding puts at the clip's very end still belongs to the clip.
    const d = clipDuration(c);
    for (let g = a; g < b; g++) times[g - g0] = starts[i] + Math.min(((g - B[i]) * rate.den) / rate.num, Math.max(0, d - 1e-6));
  });

  return {
    width: W,
    height: H,
    fps: F,
    rate,
    duration: ((g1 - g0) * rate.den) / rate.num,
    t0: times[0],
    frames: g1 - g0,
    firstFrame: g0,
    times,
    segments,
    hdr: keepHdr,
    mixedHdr,
    aspect,
    project: proj,
    media,
    encoders,
    color: primary.color ?? {},
  };
}

/** Timeline time of export frame k: what the overlay draws over that frame. */
export function frameTime(plan: Pick<Plan, 'times'>, k: number): number {
  return plan.times[k];
}

/** Export sample (48 kHz) where export frame k begins, so sound is cut where the picture is. */
export function sampleAt(plan: Pick<Plan, 'rate'>, k: number): number {
  return Math.round((k * SR * plan.rate.den) / plan.rate.num);
}

function videoCodecArgs(plan: Plan): string[] {
  const { encoders } = plan;
  const args: string[] = [];
  if (plan.hdr) {
    args.push(
      ...(encoders.hevc === 'hevc_nvenc'
        ? ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-profile:v', 'main10']
        : ['-c:v', 'libx265', '-preset', 'medium', '-crf', '20', '-x265-params', 'log-level=error']),
    );
    args.push('-pix_fmt', encoders.hevc === 'hevc_nvenc' ? 'p010le' : 'yuv420p10le', '-tag:v', 'hvc1');
    for (const [k, v] of Object.entries(plan.color)) args.push(`-${k}`, v);
  } else {
    args.push(
      ...(encoders.h264 === 'h264_nvenc'
        ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-profile:v', 'high']
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high']),
    );
    args.push('-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  }
  return args;
}

/** setpts expression placing piped overlay frame N on its segment frame (runs skip blank frames). */
function overlayPts(runs: readonly [number, number][], rate: Rate): string {
  let n = 0;
  const offs = runs.map(([a, b]) => {
    const o = { from: n, shift: a - n };
    n += b - a;
    return o;
  });
  let idx = `N+${offs[offs.length - 1].shift}`;
  for (let r = offs.length - 2; r >= 0; r--) idx = `if(lt(N,${offs[r + 1].from}),N+${offs[r].shift},${idx})`;
  return `round((${idx})*${rate.den}/(${rate.num}*TB))`;
}

/** Overlay is on only in its runs (between runs the last piped frame would otherwise linger). */
function overlayEnable(runs: readonly [number, number][], rate: Rate): string {
  const sec = (f: number) => f6(((f - 0.5) * rate.den) / rate.num);
  return runs.map(([a, b]) => `between(t,${sec(a)},${sec(b)})`).join('+');
}

/** One clip's frames of the export, overlay included, as a video-only file. */
export function segmentArgs(plan: Plan, seg: Segment, overlay: SegmentOverlay | null, output: string): string[] {
  const { project: proj, media, encoders, rate } = plan;
  const c = proj.clips[seg.clip];
  const m = media[c.mediaId];
  const W = plan.width;
  const H = plan.height;
  const aspect = plan.aspect;
  const ratio = aspectRatio(aspect, media[proj.clips[0].mediaId]);
  const keys = proj.format.reframe.mode === 'center' || aspect === 'original' ? [] : proj.format.reframe.keyframes;
  const clipStart = clipStarts(proj.clips)[seg.clip];
  const pixfmt = plan.hdr ? 'yuv420p10le' : 'yuv420p';

  const args: string[] = ['-y', '-hide_banner', '-nostdin', '-v', 'error'];
  // A source frame past the out point too: a clip shorter than a source frame still has one.
  if (c.kind === 'video')
    args.push('-ss', f6(m.duration > 0.05 ? Math.min(c.in, m.duration - 0.05) : c.in), '-t', f6(c.out - c.in + 1 / Math.max(1, m.fps)), '-i', m.path);
  else args.push('-ss', f6(Math.max(0, Math.min(c.at, m.duration - 0.05))), '-i', m.path);
  const graph: string[] = [];
  // Crop in source pixels for the project's aspect (panning keyframes on the timeline).
  let cw: number;
  let ch: number;
  if (m.width / m.height > ratio) {
    ch = m.height;
    cw = ch * ratio;
  } else {
    cw = m.width;
    ch = cw / ratio;
  }
  cw = Math.max(2, Math.floor(cw / 2) * 2);
  ch = Math.max(2, Math.floor(ch / 2) * 2);
  const v: string[] = [];
  if (c.kind === 'video') v.push(`setpts=(PTS-STARTPTS)/${f6(c.speed)}`);
  else v.push('trim=end_frame=1', 'setpts=PTS-STARTPTS');
  if (m.hdr && !plan.hdr) v.push(encoders.tonemap);
  v.push(`fps=${rateArg(rate)}`);
  // Exactly the segment's frames: the last frame is held if the source runs short of the
  // grid (and a freeze is one frame held), the clip-local frame j is clip second j/fps.
  const cut = `tpad=stop_mode=clone:stop=-1,trim=start_frame=${seg.skip}:end_frame=${seg.skip + seg.frames},setpts=PTS-STARTPTS`;
  const blurFill = proj.format.fill === 'blur' && aspect !== 'original' && Math.abs(m.width / m.height - ratio) > 0.01;
  if (blurFill) {
    // The whole video centred on a blurred, darkened copy of itself – placed exactly like
    // cropAt() places it, so tracers and graphics line up. The blur runs at 1/8 size (fast).
    const crop = cropAt(proj, m, 0);
    const fw = Math.min(W, Math.max(2, Math.round((m.width * W) / crop.w / 2) * 2));
    const fh = Math.min(H, Math.max(2, Math.round((m.height * W) / crop.w / 2) * 2));
    const bw = Math.max(16, Math.round(W / 16) * 2);
    const bh = Math.max(16, Math.round(H / 16) * 2);
    graph.push(`[0:v]${v.join(',')},split=2[bg][fg]`);
    graph.push(
      `[bg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=${Math.max(2, Math.round(bw / 40))},` +
        `eq=brightness=-0.06:saturation=0.85,scale=${W}:${H}:flags=bilinear[bb]`,
    );
    graph.push(`[fg]scale=${fw}:${fh}:flags=lanczos[ff]`);
    graph.push(`[bb][ff]overlay=x=${Math.round((W - fw) / 2)}:y=${Math.round((H - fh) / 2)},setsar=1,format=${pixfmt},${cut}[base]`);
  } else {
    if (cw < m.width || ch < m.height) {
      v.push(`crop=w=${cw}:h=${ch}:x='${cropExpr(keys, 'cx', clipStart, m.width, cw)}':y='${cropExpr(keys, 'cy', clipStart, m.height, ch)}':exact=1`);
    }
    v.push(`scale=${W}:${H}:flags=lanczos`, 'setsar=1', `format=${pixfmt}`, cut);
    graph.push(`[0:v]${v.join(',')}[base]`);
  }

  // Overlay from stdin (rawvideo RGBA of the overlay box, only the frames in its runs).
  let vout = '[base]';
  if (overlay && overlay.runs.length) {
    const { box, runs } = overlay;
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${box.w}x${box.h}`, '-r', rateArg(rate), '-i', 'pipe:0');
    graph.push(`[1:v]setpts='${overlayPts(runs, rate)}'[ov]`);
    graph.push(`[base][ov]overlay=x=${box.x}:y=${box.y}:eof_action=pass:format=auto:enable='${overlayEnable(runs, rate)}'[vov]`);
    vout = '[vov]';
  }
  graph.push(`${vout}format=${pixfmt}[vfinal]`);
  args.push('-filter_complex', graph.join(';'), '-map', '[vfinal]', ...videoCodecArgs(plan));
  args.push('-r', rateArg(rate), '-an', '-f', 'mp4', output);
  return args;
}

/** The sound of the whole export (clip audio cut on the frame grid, then music) as AAC. */
export function audioArgs(plan: Plan, output: string): string[] {
  const { project, media } = plan;
  const args: string[] = ['-y', '-hide_banner', '-nostdin', '-v', 'error'];
  const graph: string[] = [];
  let input = 0;
  const parts: string[] = [];
  const toSamples = (frames: number) => sampleAt(plan, frames);
  for (const [n, seg] of plan.segments.entries()) {
    const c = project.clips[seg.clip];
    const m = media[c.mediaId];
    const count = toSamples(seg.start + seg.frames) - toSamples(seg.start);
    // Audio of the clip (silence for freezes, muted clips and videos without sound).
    const vol = c.kind === 'video' && !c.muted && !project.audio.muted ? c.volume * project.audio.originalVolume : 0;
    if (c.kind === 'video' && m.hasAudio && vol > 0) {
      const ii = input++;
      args.push('-ss', f6(c.in), '-t', f6(c.out - c.in), '-i', m.path);
      const skip = toSamples(seg.skip);
      const a = ['asetpts=PTS-STARTPTS', ...atempoChain(c.speed), `volume=${f6(vol)}`, `aresample=${SR}`, 'aformat=channel_layouts=stereo'];
      graph.push(`[${ii}:a]${a.join(',')},apad,atrim=start_sample=${skip}:end_sample=${skip + count},asetpts=PTS-STARTPTS[a${n}]`);
    } else {
      graph.push(`anullsrc=channel_layout=stereo:sample_rate=${SR},atrim=end_sample=${count}[a${n}]`);
    }
    parts.push(`[a${n}]`);
  }
  graph.push(`${parts.join('')}concat=n=${parts.length}:v=0:a=1[acat]`);

  // Music, placed on the timeline (export second 0 is the range start's frame).
  const total = timelineDuration(project);
  const start = (plan.firstFrame * plan.rate.den) / plan.rate.num;
  const music: string[] = [];
  for (const [k, a] of project.audioTracks.entries()) {
    const m = media[a.mediaId];
    if (!m || a.start >= total) continue;
    const len = Math.min(a.out - a.in, total - a.start);
    const at = a.start - start; // export second the music starts at (negative: started before)
    if (len <= 0 || at >= plan.duration || at + len <= 0) continue;
    const ii = input++;
    args.push('-ss', f6(a.in), '-t', f6(len), '-i', m.path);
    const f = [`asetpts=PTS-STARTPTS`, `aresample=${SR}`, 'aformat=channel_layouts=stereo', `volume=${f6(a.volume)}`];
    if (a.fadeIn > 0) f.push(`afade=t=in:st=0:d=${f6(Math.min(a.fadeIn, len / 2))}`);
    if (a.fadeOut > 0) f.push(`afade=t=out:st=${f6(Math.max(0, len - a.fadeOut))}:d=${f6(Math.min(a.fadeOut, len / 2))}`);
    if (at < 0) f.push(`atrim=start_sample=${Math.round(-at * SR)}`, 'asetpts=PTS-STARTPTS');
    else if (at > 0) f.push(`adelay=${Math.round(at * SR)}S:all=1`);
    graph.push(`[${ii}:a]${f.join(',')}[m${k}]`);
    music.push(`[m${k}]`);
  }
  let aout = '[acat]';
  if (music.length) {
    graph.push(`[acat]${music.join('')}amix=inputs=${music.length + 1}:duration=first:normalize=0:dropout_transition=0[amix]`);
    aout = '[amix]';
  }
  graph.push(`${aout}atrim=end_sample=${toSamples(plan.frames)}[afinal]`);
  args.push('-filter_complex', graph.join(';'), '-map', '[afinal]', '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', output);
  return args;
}

/** Joins the segments (no re-encode) and the sound into the finished file. */
export function muxArgs(plan: Plan, segmentList: string, audio: string, output: string): string[] {
  return [
    ...['-y', '-hide_banner', '-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', segmentList, '-i', audio],
    ...['-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...(plan.hdr ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', '-f', 'mp4', output],
  ];
}

/** concat demuxer list for the segment files. */
export function concatList(files: readonly string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, `'\\''`)}'\n`).join('');
}
