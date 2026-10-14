import { spawnSync } from 'node:child_process';
import type { Encoders } from './plan';

let cached: Encoders | null = null;

function works(codec: string): boolean {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-c:v', codec, '-f', 'null', '-'], { encoding: 'utf8' });
  return r.status === 0;
}

function hasFilter(name: string): boolean {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(r.stdout ?? '');
}

/** GPU encoders when the machine has them (RTX), CPU otherwise. */
export function encoders(): Encoders {
  if (cached) return cached;
  const tonemap =
    hasFilter('zscale') && hasFilter('tonemap')
      ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'
      : 'colorspace=all=bt709:iall=bt2020:fast=1';
  cached = {
    h264: process.env.EXPORT_CPU ? 'libx264' : works('h264_nvenc') ? 'h264_nvenc' : 'libx264',
    hevc: process.env.EXPORT_CPU ? 'libx265' : works('hevc_nvenc') ? 'hevc_nvenc' : 'libx265',
    tonemap,
  };
  return cached;
}
