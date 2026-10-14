/**
 * Builds the ffmpeg command for an export: clips (trim, speed, freeze), reframing crop,
 * scaling, HDR keep/tone-map, audio (clip audio, music, fades) and the RGBA overlay input
 * from stdin. Pure function of the project, so it is unit-tested without running ffmpeg.
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

export interface PlanInput {
  project: Project;
  settings: ExportSettings;
  media: Record<string, MediaFile>;
  maxShortSide?: number;
  encoders: Encoders;
  output: string;
  /** Overlay box (output px); null = nothing drawn. */
  overlay: { x: number; y: number; w: number; h: number } | null;
}

export interface Plan {
  args: string[];
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Timeline seconds of output frame 0 (range start). */
  t0: number;
  frames: number;
  hdr: boolean;
  aspect: Aspect;
}

const f6 = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

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

export function buildPlan(inp: PlanInput): Plan {
  const { project, settings, media, encoders } = inp;
  const first = project.clips[0];
  if (!first) throw new Error('Projektet har ingen klip.');
  const primary = media[first.mediaId];
  if (!primary) throw new Error('Videoen mangler.');
  // Shorts are vertical by definition.
  const aspect: Aspect = settings.preset === 'shorts' ? '9:16' : project.format.aspect;
  const proj: Project = aspect === project.format.aspect ? project : { ...project, format: { ...project.format, aspect } };
  const { width: W, height: H } = outputSize(aspect, settings.preset, primary, inp.maxShortSide);
  const fps = settings.fps === 'source' ? Math.min(60, Math.round(primary.fps * 1000) / 1000 || 30) : settings.fps;
  const total = timelineDuration(project);
  const t0 = settings.range ? Math.max(0, Math.min(settings.range.start, total)) : 0;
  const t1 = settings.range ? Math.max(t0 + 0.1, Math.min(settings.range.end, total)) : total;
  const duration = t1 - t0;
  const keepHdr = settings.hdr === 'keep' && primary.hdr;
  const starts = clipStarts(project.clips);
  const ratio = aspectRatio(aspect, primary);
  const keys = proj.format.reframe.mode === 'center' || aspect === 'original' ? [] : proj.format.reframe.keyframes;

  const args: string[] = ['-y', '-hide_banner', '-nostdin', '-v', 'error'];
  const graph: string[] = [];
  let input = 0;
  const pairs: string[] = [];
  const pixfmt = keepHdr ? 'yuv420p10le' : 'yuv420p';

  project.clips.forEach((c, i) => {
    const m = media[c.mediaId];
    if (!m) throw new Error(`Klip ${i + 1} mangler sin video.`);
    const d = clipDuration(c);
    const vi = input++;
    if (c.kind === 'video') args.push('-ss', f6(c.in), '-t', f6(c.out - c.in), '-i', m.path);
    else args.push('-ss', f6(Math.max(0, Math.min(c.at, m.duration - 0.05))), '-i', m.path);
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
    else v.push('trim=end_frame=1', 'setpts=PTS-STARTPTS', `tpad=stop_mode=clone:stop_duration=${f6(d)}`);
    if (m.hdr && !keepHdr) v.push(encoders.tonemap);
    v.push(`fps=${f6(fps)}`);
    const blurFill = proj.format.fill === 'blur' && aspect !== 'original' && Math.abs(m.width / m.height - ratio) > 0.01;
    if (blurFill) {
      // The whole video centred on a blurred, darkened copy of itself – placed exactly like
      // cropAt() places it, so tracers and graphics line up. The blur runs at 1/8 size (fast).
      const crop = cropAt(proj, m, 0);
      const fw = Math.min(W, Math.max(2, Math.round((m.width * W) / crop.w / 2) * 2));
      const fh = Math.min(H, Math.max(2, Math.round((m.height * W) / crop.w / 2) * 2));
      const bw = Math.max(16, Math.round(W / 16) * 2);
      const bh = Math.max(16, Math.round(H / 16) * 2);
      graph.push(`[${vi}:v]${v.join(',')},split=2[bg${i}][fg${i}]`);
      graph.push(
        `[bg${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=${Math.max(2, Math.round(bw / 40))},` +
          `eq=brightness=-0.06:saturation=0.85,scale=${W}:${H}:flags=bilinear[bb${i}]`,
      );
      graph.push(`[fg${i}]scale=${fw}:${fh}:flags=lanczos[ff${i}]`);
      graph.push(`[bb${i}][ff${i}]overlay=x=${Math.round((W - fw) / 2)}:y=${Math.round((H - fh) / 2)},setsar=1,format=${pixfmt},trim=duration=${f6(d)}[v${i}]`);
    } else {
      if (cw < m.width || ch < m.height) {
        v.push(`crop=w=${cw}:h=${ch}:x='${cropExpr(keys, 'cx', starts[i], m.width, cw)}':y='${cropExpr(keys, 'cy', starts[i], m.height, ch)}':exact=1`);
      }
      v.push(`scale=${W}:${H}:flags=lanczos`, 'setsar=1', `format=${pixfmt}`, `trim=duration=${f6(d)}`);
      graph.push(`[${vi}:v]${v.join(',')}[v${i}]`);
    }
    // Audio of the clip (silence for freezes, muted clips and videos without sound).
    const vol = c.kind === 'video' && !c.muted && !project.audio.muted ? c.volume * project.audio.originalVolume : 0;
    if (c.kind === 'video' && m.hasAudio && vol > 0) {
      const a = ['asetpts=PTS-STARTPTS', ...atempoChain(c.speed), `volume=${f6(vol)}`, 'aresample=48000', 'aformat=channel_layouts=stereo'];
      graph.push(`[${vi}:a]${a.join(',')},apad,atrim=duration=${f6(d)}[a${i}]`);
    } else {
      graph.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${f6(d)}[a${i}]`);
    }
    pairs.push(`[v${i}][a${i}]`);
  });
  graph.push(`${pairs.join('')}concat=n=${project.clips.length}:v=1:a=1[vcat][acat]`);

  // Music.
  const music: string[] = [];
  for (const [k, a] of project.audioTracks.entries()) {
    const m = media[a.mediaId];
    if (!m || a.start >= total) continue;
    const len = Math.min(a.out - a.in, total - a.start);
    if (len <= 0) continue;
    const ii = input++;
    args.push('-ss', f6(a.in), '-t', f6(len), '-i', m.path);
    const f = [`asetpts=PTS-STARTPTS`, 'aresample=48000', 'aformat=channel_layouts=stereo', `volume=${f6(a.volume)}`];
    if (a.fadeIn > 0) f.push(`afade=t=in:st=0:d=${f6(Math.min(a.fadeIn, len / 2))}`);
    if (a.fadeOut > 0) f.push(`afade=t=out:st=${f6(Math.max(0, len - a.fadeOut))}:d=${f6(Math.min(a.fadeOut, len / 2))}`);
    if (a.start > 0) f.push(`adelay=${Math.round(a.start * 1000)}:all=1`);
    graph.push(`[${ii}:a]${f.join(',')}[m${k}]`);
    music.push(`[m${k}]`);
  }
  let aout = '[acat]';
  if (music.length) {
    graph.push(`[acat]${music.join('')}amix=inputs=${music.length + 1}:duration=first:normalize=0:dropout_transition=0[amix]`);
    aout = '[amix]';
  }

  // Overlay from stdin (rawvideo RGBA of the overlay box).
  let vout = '[vcat]';
  if (inp.overlay) {
    const oi = input++;
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${inp.overlay.w}x${inp.overlay.h}`, '-r', f6(fps), '-i', 'pipe:0');
    graph.push(`[${oi}:v]setpts=PTS-STARTPTS+${f6(t0)}/TB[ov]`);
    graph.push(`[vcat][ov]overlay=x=${inp.overlay.x}:y=${inp.overlay.y}:eof_action=pass:format=auto[vov]`);
    vout = '[vov]';
  }
  if (settings.range) {
    graph.push(`${vout}trim=start=${f6(t0)}:end=${f6(t1)},setpts=PTS-STARTPTS[vr]`);
    graph.push(`${aout}atrim=start=${f6(t0)}:end=${f6(t1)},asetpts=PTS-STARTPTS[ar]`);
    vout = '[vr]';
    aout = '[ar]';
  }
  graph.push(`${vout}format=${pixfmt}[vfinal]`);
  args.push('-filter_complex', graph.join(';'), '-map', '[vfinal]', '-map', aout);

  if (keepHdr) {
    args.push(
      ...(encoders.hevc === 'hevc_nvenc'
        ? ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-profile:v', 'main10']
        : ['-c:v', 'libx265', '-preset', 'medium', '-crf', '20', '-x265-params', 'log-level=error']),
    );
    args.push('-pix_fmt', encoders.hevc === 'hevc_nvenc' ? 'p010le' : 'yuv420p10le', '-tag:v', 'hvc1');
    for (const [k, v] of Object.entries(primary.color ?? {})) args.push(`-${k}`, v);
  } else {
    args.push(
      ...(encoders.h264 === 'h264_nvenc'
        ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-profile:v', 'high']
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high']),
    );
    args.push('-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  }
  args.push('-r', f6(fps), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', f6(duration), inp.output);
  return { args, width: W, height: H, fps, duration, t0, frames: Math.ceil(duration * fps - 1e-6), hdr: keepHdr, aspect };
}

/** Timeline time of overlay frame k (frame-centred sampling is not used: ffmpeg overlays by pts). */
export function frameTime(plan: Pick<Plan, 't0' | 'fps'>, k: number): number {
  return plan.t0 + k / plan.fps;
}
