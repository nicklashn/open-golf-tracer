/**
 * Birdie – our mascot: a friendly golf ball whose red tracer tail doubles as a scarf.
 * Original vector drawing; same 2.5 px line weight and colours as the design system.
 * Used sparingly: onboarding, empty states, loading, errors, 404.
 */
import type { CSSProperties } from 'react';

export type BirdieMood = 'neutral' | 'wave' | 'think' | 'cheer' | 'confused' | 'sleep' | 'point';

const INK = '#18181B';
const RED = '#F04438';
const DIMPLE = '#E4E4E7';
const LINE = 2.5;

const dimples: [number, number, number][] = [
  [44, 40, 1.7],
  [56, 36, 1.7],
  [68, 37, 1.7],
  [79, 43, 1.7],
  [38, 50, 1.5],
  [86, 54, 1.5],
  [50, 46, 1.4],
  [62, 44, 1.4],
  [74, 48, 1.4],
  [36, 64, 1.4],
  [88, 66, 1.4],
];

export function Birdie({
  mood = 'neutral',
  size = 120,
  className,
  label,
  animated = true,
}: {
  mood?: BirdieMood;
  size?: number;
  className?: string;
  label?: string;
  animated?: boolean;
}) {
  const anim = (a: string): CSSProperties => (animated ? { animation: a } : {});
  const closed = mood === 'sleep';
  const lookUp = mood === 'think';
  const ex = lookUp ? 2 : 0;
  const ey = lookUp ? -2.5 : 0;
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <g style={{ transformOrigin: '60px 64px', ...anim('birdie-bob 3.2s ease-in-out infinite') }}>
        {/* tracer tail behind the ball */}
        <path
          d="M36 82 C 22 88, 14 80, 6 90"
          fill="none"
          stroke={RED}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray="120"
          style={anim('birdie-tail 1.2s cubic-bezier(.2,.8,.2,1) both')}
        />
        <path d="M30 86 C 22 94, 14 92, 8 100" fill="none" stroke={RED} strokeWidth={3.5} strokeLinecap="round" opacity={0.55} />

        {/* arms behind the body */}
        {mood === 'cheer' ? (
          <>
            <path d="M30 58 L 16 40" stroke={INK} strokeWidth={LINE + 0.5} strokeLinecap="round" />
            <circle cx="15" cy="38" r="3.6" fill="#fff" stroke={INK} strokeWidth={LINE} />
          </>
        ) : null}

        {/* the ball */}
        <circle cx="60" cy="62" r="34" fill="#fff" stroke={INK} strokeWidth={LINE} />
        {dimples.map(([x, y, r]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill={DIMPLE} />
        ))}

        {/* scarf: the tracer wraps around the lower half */}
        <path d="M30 76 C 44 90, 76 90, 90 76" fill="none" stroke={RED} strokeWidth={7} strokeLinecap="round" />
        <path d="M36 80 C 32 86, 36 92, 31 97" fill="none" stroke={RED} strokeWidth={5} strokeLinecap="round" />

        {/* face */}
        {closed ? (
          <>
            <path d="M45 60 Q 49 63 53 60" fill="none" stroke={INK} strokeWidth={LINE} strokeLinecap="round" />
            <path d="M67 60 Q 71 63 75 60" fill="none" stroke={INK} strokeWidth={LINE} strokeLinecap="round" />
          </>
        ) : (
          <g style={{ transformOrigin: '60px 59px', ...anim('birdie-blink 5s infinite') }}>
            <ellipse cx={49 + ex} cy={59 + ey} rx="3.7" ry="4.7" fill={INK} />
            <ellipse cx={71 + ex} cy={59 + ey} rx="3.7" ry="4.7" fill={INK} />
            <circle cx={50.2 + ex} cy={57.4 + ey} r="1.2" fill="#fff" />
            <circle cx={72.2 + ex} cy={57.4 + ey} r="1.2" fill="#fff" />
          </g>
        )}
        {mood === 'confused' ? (
          <>
            <path d="M44 50 L 53 52" stroke={INK} strokeWidth={LINE} strokeLinecap="round" />
            <path d="M67 51 Q 72 47 77 50" fill="none" stroke={INK} strokeWidth={LINE} strokeLinecap="round" />
            <path d="M53 72 Q 57 69 60 72 T 67 72" fill="none" stroke={INK} strokeWidth={LINE} strokeLinecap="round" />
          </>
        ) : mood === 'cheer' ? (
          <path d="M51 69 Q 60 80 69 69 Z" fill={INK} stroke={INK} strokeWidth={LINE} strokeLinejoin="round" />
        ) : mood === 'think' ? (
          <circle cx="63" cy="71" r="2.4" fill="none" stroke={INK} strokeWidth={LINE} />
        ) : mood === 'sleep' ? (
          <path d="M56 71 Q 60 73 64 71" fill="none" stroke={INK} strokeWidth={LINE} strokeLinecap="round" />
        ) : (
          <path d="M53 69 Q 60 75 67 69" fill="none" stroke={INK} strokeWidth={LINE} strokeLinecap="round" />
        )}
        <ellipse cx="42" cy="67" rx="3.2" ry="1.8" fill={RED} opacity={0.18} />
        <ellipse cx="78" cy="67" rx="3.2" ry="1.8" fill={RED} opacity={0.18} />

        {/* arms in front */}
        {mood === 'wave' ? (
          <g style={{ transformOrigin: '92px 62px', ...anim('birdie-wave 1.1s ease-in-out infinite') }}>
            <path d="M92 62 L 104 44" stroke={INK} strokeWidth={LINE + 0.5} strokeLinecap="round" />
            <circle cx="105" cy="42" r="3.6" fill="#fff" stroke={INK} strokeWidth={LINE} />
          </g>
        ) : mood === 'point' ? (
          <>
            <path d="M93 66 L 110 60" stroke={INK} strokeWidth={LINE + 0.5} strokeLinecap="round" />
            <path d="M107 56 L 114 59 L 108 64" fill="none" stroke={INK} strokeWidth={LINE} strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : mood === 'cheer' ? (
          <>
            <path d="M90 58 L 104 40" stroke={INK} strokeWidth={LINE + 0.5} strokeLinecap="round" />
            <circle cx="105" cy="38" r="3.6" fill="#fff" stroke={INK} strokeWidth={LINE} />
          </>
        ) : mood === 'think' ? (
          <>
            <path d="M88 76 Q 84 84 74 80" fill="none" stroke={INK} strokeWidth={LINE + 0.5} strokeLinecap="round" />
            <circle cx="72" cy="80" r="3.2" fill="#fff" stroke={INK} strokeWidth={LINE} />
          </>
        ) : null}
      </g>

      {/* extras outside the bobbing group */}
      {mood === 'think' ? (
        <g fill="#fff" stroke={INK} strokeWidth={2}>
          <circle cx="96" cy="26" r="2.5" />
          <circle cx="104" cy="18" r="3.5" />
          <circle cx="113" cy="9" r="4.5" />
        </g>
      ) : null}
      {mood === 'confused' ? (
        <text x="96" y="28" fontSize="22" fontWeight="700" fill={INK} fontFamily="Inter Variable, Inter, sans-serif">
          ?
        </text>
      ) : null}
      {mood === 'sleep' ? (
        <g fill={INK} fontFamily="Inter Variable, Inter, sans-serif" fontWeight="700">
          <text x="92" y="30" fontSize="12" style={anim('birdie-z 2.4s ease-out infinite')}>
            z
          </text>
          <text x="100" y="20" fontSize="9" style={anim('birdie-z 2.4s ease-out 0.8s infinite')}>
            z
          </text>
        </g>
      ) : null}
      {mood === 'cheer' ? (
        <g stroke={RED} strokeWidth={2.5} strokeLinecap="round">
          <path d="M60 6 L 60 14" />
          <path d="M36 12 L 40 19" />
          <path d="M84 12 L 80 19" />
        </g>
      ) : null}
    </svg>
  );
}
