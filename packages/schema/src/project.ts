import { z } from 'zod';

/** Bump when the document shape changes; add a migration in `migrate.ts`. */
export const SCHEMA_VERSION = 1;

const id = z.string().min(1).max(64);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const unit = z.number().min(0).max(1);
const seconds = z
  .number()
  .min(0)
  .max(24 * 3600);
const finite = z.number().refine(Number.isFinite, 'must be finite');

export const Point = z.object({ x: finite, y: finite });
export type Point = z.infer<typeof Point>;

/** WGS84 position (degrees); `acc` = horizontal accuracy in metres when known. */
export const GeoPoint = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), acc: z.number().min(0).optional() });
export type GeoPoint = z.infer<typeof GeoPoint>;

export const Place = z.object({
  course: z.string().max(80).default(''),
  /** Hole number as mapped ('' when the spot is on no hole). */
  hole: z.string().max(8).default(''),
  par: z.number().int().min(2).max(7).nullable().default(null),
  /** Metres from the tee along the hole's centre line, and from there to the green. */
  fromTee: z.number().min(0).nullable().default(null),
  toGreen: z.number().min(0).nullable().default(null),
  /** The hole's centre line, tee to green, as [lat, lon] pairs. */
  line: z
    .array(z.tuple([z.number(), z.number()]))
    .max(50)
    .default([]),
});
export type Place = z.infer<typeof Place>;

// ---------------------------------------------------------------------------------------------
// Media

export const MediaRef = z.object({
  id,
  kind: z.enum(['video', 'audio', 'image']),
  name: z.string().max(255),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  fps: z.number().min(0).max(1000),
  duration: z.number().min(0),
  hdr: z.boolean().default(false),
  hasAudio: z.boolean().default(false),
  /** Where the phone was when recording (from the file's metadata), roughly the tee. */
  geo: GeoPoint.nullable().default(null),
  /** Course and hole at that spot (OpenStreetMap), found during analysis. */
  place: Place.nullable().default(null),
  /** When it was filmed (ISO 8601, from the file); orders the clips of a round. */
  recordedAt: z.string().max(40).nullable().default(null),
  /** Where `recordedAt` came from: the file's metadata, its name, or its modified time ('file', weak). */
  recordedAtSource: z.enum(['metadata', 'filename', 'file']).nullable().optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

// ---------------------------------------------------------------------------------------------
// Tracer

export const AfterLanding = z.enum(['hold', 'fade', 'hide']);

export const TracerStyle = z.object({
  preset: z.string().max(40).default('classic'),
  color: hex.default('#ff3b30'),
  /** Optional end colour; the line blends from `color` to `color2` along the flight. */
  color2: hex.nullable().default(null),
  /** Line width multiplier (1 = broadcast default, about 0.22 % of the frame diagonal). */
  width: z.number().min(0.2).max(8).default(1),
  glow: unit.default(0.55),
  /** How strongly the line thins and fades with distance. */
  perspective: unit.default(1),
  ballHead: z.boolean().default(true),
  landingMarker: z.boolean().default(false),
  impactFlash: z.boolean().default(false),
  /** Seconds of tail behind the ball; 0 draws the whole flight. */
  comet: z.number().min(0).max(5).default(0),
  /** The line rises out of the ball: fraction of the drawn path over which it fades in. */
  fadeIn: unit.default(0.3),
  /** How white-hot the centre of the line is (0 = pure colour, 1 = white core). */
  core: unit.default(0.3),
  afterLanding: AfterLanding.default('hold'),
  /** Seconds the tracer stays/fades after landing (`fade`). */
  fadeSeconds: z.number().min(0).max(30).default(1.5),
});
export type TracerStyle = z.infer<typeof TracerStyle>;

export const WarningCode = z.enum([
  'low_confidence',
  'no_track',
  'few_points',
  'start_extrapolated',
  'implausible',
  'carry_mismatch',
  'short_shot',
  'default_path',
  'manual',
  'hole_limit',
]);
export type WarningCode = z.infer<typeof WarningCode>;

export const ShotWarning = z.object({ code: WarningCode, detail: z.string().max(300).optional() });
export type ShotWarning = z.infer<typeof ShotWarning>;

export const Club = z.enum(['auto', 'driver', 'wood', 'longIron', 'midIron', 'shortIron', 'wedge']);
export type Club = z.infer<typeof Club>;

/** V, theta, phi, kl, ks, pitch, log_h, log_f, dt0 – see packages/physics. */
export const FlightParams = z.array(finite).length(9);
export type FlightParams = z.infer<typeof FlightParams>;

export const ShotConstraints = z.object({
  start: Point.nullable().default(null),
  apex: Point.nullable().default(null),
  landing: Point.nullable().default(null),
  points: z
    .array(z.object({ t: z.number(), x: finite, y: finite }))
    .max(32)
    .default([]),
  carry: z.number().min(1).max(450).nullable().default(null), // metres
  /** -1 = strong draw … +1 = strong fade (right-handed, seen from behind). */
  curve: z.number().min(-1).max(1).nullable().default(null),
  flightTime: z.number().min(0.5).max(12).nullable().default(null),
});
export type ShotConstraints = z.infer<typeof ShotConstraints>;

export const Shot = z.object({
  id,
  mediaId: id,
  source: z.enum(['auto', 'manual']).default('auto'),
  kind: z.enum(['full', 'short']).default('full'),
  /** Source-video seconds of the strike. */
  impactTime: seconds,
  confidence: unit.default(1),
  warnings: z.array(ShotWarning).default([]),
  camera: z.object({ cx: finite, cy: finite }),
  anchor: Point,
  track: z.object({ t: z.array(finite), u: z.array(finite), v: z.array(finite) }).default({ t: [], u: [], v: [] }),
  params: FlightParams,
  rmsPx: z.number().nullable().default(null),
  auto: z.object({ params: FlightParams, anchor: Point, impactTime: seconds }),
  constraints: ShotConstraints.default(ShotConstraints.parse({})),
  timing: z
    .object({
      /** Extra seconds added to the launch moment (frame-accurate nudging). */
      launchOffset: z.number().min(-2).max(2).default(0),
      /** Animation speed of the tracer relative to the real flight. */
      speed: z.number().min(0.25).max(4).default(1),
    })
    .default({ launchOffset: 0, speed: 1 }),
  /** The clip was recorded this many times slower than real time. */
  slowmo: z.number().min(1).max(16).default(1),
  /** Club used; narrows the speed/launch the flight fit may choose ('auto' = unknown). */
  club: Club.default('auto'),
  /** Tee and landing spot picked on the map; their distance is used as carry. */
  geo: z.object({ tee: GeoPoint, landing: GeoPoint }).nullable().default(null),
  // Same as TRACER_PRESETS.classic (presets.ts imports this file, so it can't be referenced here).
  style: TracerStyle.default(TracerStyle.parse({ color: '#ff4520', color2: '#ffd23f', glow: 0.3, width: 4.5 })),
  visible: z.boolean().default(true),
  label: z.string().max(80).default(''),
  /** What the microphone heard around the strike (shottracer/audio.py `signature`): log band
   *  energies at `rate` frames/s, the first at `start` s from the impact. Compares two clips. */
  sound: z
    .object({
      rate: z.number().positive().max(1000),
      start: z.number().min(-10).max(0),
      bands: z.array(z.array(finite).max(400)).min(1).max(8),
    })
    .optional(),
});
export type Shot = z.infer<typeof Shot>;

// ---------------------------------------------------------------------------------------------
// Timeline

export const VideoClip = z.object({
  id,
  kind: z.literal('video'),
  mediaId: id,
  in: seconds,
  out: seconds,
  speed: z.number().min(0.1).max(8).default(1),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
});
export const FreezeClip = z.object({
  id,
  kind: z.literal('freeze'),
  mediaId: id,
  /** Source time of the frozen frame. */
  at: seconds,
  duration: z.number().min(0.1).max(60),
});
export const Clip = z.discriminatedUnion('kind', [VideoClip, FreezeClip]);
export type VideoClip = z.infer<typeof VideoClip>;
export type FreezeClip = z.infer<typeof FreezeClip>;
export type Clip = z.infer<typeof Clip>;

export const AudioClip = z.object({
  id,
  mediaId: id,
  start: seconds,
  in: seconds,
  out: seconds,
  volume: z.number().min(0).max(2).default(0.8),
  fadeIn: z.number().min(0).max(30).default(1),
  fadeOut: z.number().min(0).max(30).default(2),
});
export type AudioClip = z.infer<typeof AudioClip>;

export const Aspect = z.enum(['original', '16:9', '9:16', '1:1', '4:5']);
export type Aspect = z.infer<typeof Aspect>;

export const ReframeKey = z.object({
  /** Timeline seconds. */
  t: z.number().min(0),
  /** Crop centre as a fraction of the source frame. */
  cx: unit,
  cy: unit,
  /** 1 = largest crop of the target aspect that fits; > 1 zooms in. */
  zoom: z.number().min(1).max(4).default(1),
});
export type ReframeKey = z.infer<typeof ReframeKey>;

// ---------------------------------------------------------------------------------------------
// Graphics layers (positions are fractions of the output frame)

export const Easing = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']);
export type Easing = z.infer<typeof Easing>;

export const Keyframe = z.object({
  /** Seconds relative to the layer start. */
  t: z.number().min(0),
  x: finite,
  y: finite,
  scale: z.number().min(0.01).max(20).default(1),
  rotation: z.number().min(-3600).max(3600).default(0),
  opacity: unit.default(1),
  easing: Easing.default('easeInOut'),
});
export type Keyframe = z.infer<typeof Keyframe>;

export const AnimPreset = z.enum(['none', 'fade', 'slideUp', 'slideLeft', 'slideRight', 'pop', 'typewriter', 'wipe']);
export type AnimPreset = z.infer<typeof AnimPreset>;
export const Anim = z.object({ preset: AnimPreset.default('fade'), duration: z.number().min(0).max(5).default(0.4) });
export type Anim = z.infer<typeof Anim>;

export const FontId = z.enum(['inter', 'oswald', 'bebas', 'barlow', 'playfair']);
export type FontId = z.infer<typeof FontId>;

const layerBase = {
  id,
  name: z.string().max(80).default(''),
  start: seconds,
  end: seconds,
  keyframes: z.array(Keyframe).min(1).max(200),
  animIn: Anim.default({ preset: 'fade', duration: 0.4 }),
  animOut: Anim.default({ preset: 'fade', duration: 0.3 }),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
};

export const TextProps = z.object({
  text: z.string().max(500),
  font: FontId.default('inter'),
  weight: z.number().int().min(100).max(900).default(700),
  /** Font size as a fraction of the output height. */
  size: z.number().min(0.005).max(0.5).default(0.05),
  color: hex.default('#ffffff'),
  align: z.enum(['left', 'center', 'right']).default('center'),
  background: hex.nullable().default(null),
  backgroundOpacity: unit.default(0.8),
  uppercase: z.boolean().default(false),
  letterSpacing: z.number().min(-0.2).max(1).default(0),
  shadow: z.boolean().default(true),
});

export const StatField = z.enum(['carry', 'apex', 'ballSpeed', 'launch', 'flightTime', 'curve']);
export type StatField = z.infer<typeof StatField>;

export const StatCardProps = z.object({
  shotId: id.nullable().default(null),
  fields: z.array(StatField).min(1).max(6).default(['carry', 'apex', 'ballSpeed', 'launch']),
  theme: z.enum(['dark', 'light', 'accent']).default('dark'),
  title: z.string().max(60).default(''),
  accent: hex.default('#ff3b30'),
  /** Width as a fraction of the output width. */
  width: z.number().min(0.1).max(1).default(0.34),
});

export const ShapeProps = z.object({
  shape: z.enum(['rect', 'ellipse', 'line']).default('rect'),
  w: z.number().min(0).max(2).default(0.2),
  h: z.number().min(0).max(2).default(0.1),
  fill: hex.nullable().default('#ffffff'),
  fillOpacity: unit.default(1),
  stroke: hex.nullable().default(null),
  strokeWidth: z.number().min(0).max(0.05).default(0.004),
  radius: z.number().min(0).max(0.5).default(0.01),
});

export const ArrowProps = z.object({
  /** End point relative to the layer position, in output fractions. */
  dx: z.number().min(-2).max(2).default(0.2),
  dy: z.number().min(-2).max(2).default(0),
  bend: z.number().min(-1).max(1).default(0.25),
  color: hex.default('#ffffff'),
  width: z.number().min(0.001).max(0.05).default(0.006),
  head: z.boolean().default(true),
  dashed: z.boolean().default(false),
});

export const ImageProps = z.object({
  mediaId: id,
  /** Width as a fraction of the output width; height follows the image aspect. */
  w: z.number().min(0.01).max(2).default(0.2),
  radius: z.number().min(0).max(0.5).default(0),
});

export const LowerThirdProps = z.object({
  title: z.string().max(80),
  subtitle: z.string().max(120).default(''),
  accent: hex.default('#ff3b30'),
  style: z.enum(['bar', 'minimal', 'tv']).default('bar'),
  font: FontId.default('barlow'),
});

export const HoleInfoProps = z.object({
  hole: z.number().int().min(1).max(99).default(1),
  par: z.number().int().min(2).max(7).default(4),
  length: z.number().min(0).max(1000).default(350),
  unit: z.enum(['m', 'yd']).default('m'),
  club: z.string().max(40).default(''),
  accent: hex.default('#ff3b30'),
  font: FontId.default('barlow'),
});

export const DistanceProps = z.object({
  /** When set, the value follows the shot's carry. */
  shotId: id.nullable().default(null),
  value: z.number().min(0).max(1000).nullable().default(null),
  unit: z.enum(['m', 'yd']).default('m'),
  label: z.string().max(40).default(''),
  color: hex.default('#ffffff'),
  accent: hex.default('#ff3b30'),
});

export const CourseFeatureKind = z.enum(['rough', 'fairway', 'green', 'tee', 'bunker', 'water', 'woods']);
export type CourseFeatureKind = z.infer<typeof CourseFeatureKind>;

/**
 * Top-down course map with the shot drawn from tee to landing (from OpenStreetMap). Geometry
 * is stored in metres with the tee at (0, 0) and the landing straight "up" (+y), so the
 * exporter needs no network and the map always reads bottom-to-top like on TV.
 */
export const CourseMapProps = z.object({
  shotId: id.nullable().default(null),
  /** Polygons as flat [x0, y0, x1, y1, …] in metres. */
  features: z
    .array(z.object({ k: CourseFeatureKind, p: z.array(finite).min(6).max(4000) }))
    .max(400)
    .default([]),
  /** Landing point in metres (x is the sideways miss; y the distance along the shot). */
  landing: Point,
  title: z.string().max(60).default(''),
  /** Height as a fraction of the output height. */
  size: z.number().min(0.1).max(1).default(0.4),
  theme: z.enum(['dark', 'light']).default('dark'),
  accent: hex.default('#ff3b30'),
  showDistance: z.boolean().default(true),
  unit: z.enum(['m', 'yd']).default('m'),
  /** Attribution required by the OpenStreetMap licence (ODbL). */
  attribution: z.string().max(80).default('© OpenStreetMap'),
});
export type CourseMapProps = z.infer<typeof CourseMapProps>;

export const Layer = z.discriminatedUnion('type', [
  z.object({ ...layerBase, type: z.literal('text'), props: TextProps }),
  z.object({ ...layerBase, type: z.literal('statCard'), props: StatCardProps }),
  z.object({ ...layerBase, type: z.literal('shape'), props: ShapeProps }),
  z.object({ ...layerBase, type: z.literal('arrow'), props: ArrowProps }),
  z.object({ ...layerBase, type: z.literal('image'), props: ImageProps }),
  z.object({ ...layerBase, type: z.literal('lowerThird'), props: LowerThirdProps }),
  z.object({ ...layerBase, type: z.literal('holeInfo'), props: HoleInfoProps }),
  z.object({ ...layerBase, type: z.literal('distance'), props: DistanceProps }),
  z.object({ ...layerBase, type: z.literal('courseMap'), props: CourseMapProps }),
]);
export type Layer = z.infer<typeof Layer>;
export type LayerType = Layer['type'];
export type LayerOf<T extends LayerType> = Extract<Layer, { type: T }>;
export type TextProps = z.infer<typeof TextProps>;
export type StatCardProps = z.infer<typeof StatCardProps>;
export type ShapeProps = z.infer<typeof ShapeProps>;
export type ArrowProps = z.infer<typeof ArrowProps>;
export type ImageProps = z.infer<typeof ImageProps>;
export type LowerThirdProps = z.infer<typeof LowerThirdProps>;
export type HoleInfoProps = z.infer<typeof HoleInfoProps>;
export type DistanceProps = z.infer<typeof DistanceProps>;

// ---------------------------------------------------------------------------------------------
// Project

export const Project = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string().max(120).default('Untitled'),
  units: z.enum(['m', 'yd']).default('m'),
  format: z
    .object({
      aspect: Aspect.default('original'),
      reframe: z
        .object({
          mode: z.enum(['auto', 'manual', 'center']).default('center'),
          keyframes: z.array(ReframeKey).max(500).default([]),
        })
        .default({ mode: 'center', keyframes: [] }),
      /** When the frame is wider/taller than the video: crop it to fill, or show all of it on a
       *  blurred copy of itself (the usual look for vertical clips in a 16:9 YouTube video). */
      fill: z.enum(['crop', 'blur']).default('crop'),
    })
    .default({ aspect: 'original', reframe: { mode: 'center', keyframes: [] }, fill: 'crop' }),
  media: z.record(z.string(), MediaRef).default({}),
  clips: z.array(Clip).max(500).default([]),
  shots: z.array(Shot).max(200).default([]),
  /** Auto-detected shots the user deleted; analysis results never bring them back. */
  dismissedShots: z.array(z.string().max(64)).max(1000).default([]),
  /** Last applied template (its layers are tagged ⧉ and re-laid out when the format changes). */
  template: z.string().max(40).nullable().default(null),
  layers: z.array(Layer).max(300).default([]),
  audioTracks: z.array(AudioClip).max(20).default([]),
  audio: z.object({ originalVolume: z.number().min(0).max(2).default(1), muted: z.boolean().default(false) }).default({ originalVolume: 1, muted: false }),
});
export type Project = z.infer<typeof Project>;
export type ProjectInput = z.input<typeof Project>;

// ---------------------------------------------------------------------------------------------
// Export settings

export const ExportPreset = z.enum(['shorts', 'youtube1080', 'youtube4k', 'original']);
export type ExportPreset = z.infer<typeof ExportPreset>;

export const ExportSettings = z.object({
  preset: ExportPreset.default('shorts'),
  fps: z.union([z.literal(30), z.literal(60), z.literal('source')]).default('source'),
  hdr: z.enum(['keep', 'sdr']).default('keep'),
  range: z.object({ start: seconds, end: seconds }).nullable().default(null),
});
export type ExportSettings = z.infer<typeof ExportSettings>;

export function parseProject(doc: unknown): Project {
  return Project.parse(doc);
}

export function emptyProject(name = 'Untitled'): Project {
  return Project.parse({ schemaVersion: SCHEMA_VERSION, name });
}
