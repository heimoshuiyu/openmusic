import { coverUrl } from "@/api/client"

/** id → 确定性散列（程序化封面种子） */
function hashOf(id: string): number {
  let h = 5381
  for (let i = 0; i < id.length; i++) {
    h = ((h * 33) ^ id.charCodeAt(i)) >>> 0
  }
  return h
}

/**
 * 无封面时的程序化占位（Apple Music 风）：柔和双色渐变 + 微弱环形纹 + 首字。
 * 颜色由 id 确定性生成——同一专辑恒定、不同专辑可辨。
 */
function ProgrammaticCover({
  seed,
  name,
  monogram,
}: {
  seed: string
  name: string
  monogram: boolean
}) {
  const h = hashOf(seed)
  const hue = h % 360
  const hue2 = (hue + 40 + (h % 50)) % 360
  const tilt = 100 + (h % 80)
  const initial = name.trim().charAt(0) || "♪"
  const cx = 50 + ((h >> 3) % 9) - 4
  const cy = 50 + ((h >> 5) % 9) - 4

  return (
    <div
      aria-hidden
      className="relative h-full w-full overflow-hidden"
      style={{
        background: `linear-gradient(${tilt}deg, hsl(${hue} 26% 30%), hsl(${hue2} 30% 16%))`,
      }}
    >
      <svg
        className="absolute inset-0 h-full w-full opacity-60"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid slice"
      >
        {[44, 34, 24].map((r, i) => (
          <circle
            key={r}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={`hsl(${hue2} 22% 70% / ${(0.1 - i * 0.025).toFixed(3)})`}
            strokeWidth={0.7}
          />
        ))}
        {monogram && (
          <text
            x={50}
            y={51}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={30}
            fontWeight={650}
            fill={`hsl(${hue} 25% 82% / 0.85)`}
          >
            {initial}
          </text>
        )}
      </svg>
    </div>
  )
}

/**
 * 封面统一出口：真封面优先（ar-/al- 前缀由服务端解析），
 * 否则程序化占位——网格永远有色彩层次。
 */
export function CoverArt({
  albumId,
  name,
  hasCover,
  className = "",
  rounded = "",
  monogram = true,
}: {
  albumId: string
  name: string
  hasCover: boolean
  className?: string
  rounded?: string
  monogram?: boolean
}) {
  return (
    <div className={`shrink-0 overflow-hidden bg-raised ${rounded} ${className}`}>
      {hasCover ? (
        <img
          src={coverUrl(albumId)}
          alt={name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <ProgrammaticCover seed={albumId} name={name} monogram={monogram} />
      )}
    </div>
  )
}

/** 艺人封面（ar- 前缀） */
export function ArtistCover({
  artistId,
  name,
  hasCover,
  className = "",
  rounded = "",
}: {
  artistId: string
  name: string
  hasCover: boolean
  className?: string
  rounded?: string
}) {
  return (
    <div className={`shrink-0 overflow-hidden bg-raised ${rounded} ${className}`}>
      {hasCover ? (
        <img
          src={`/api/v1/covers/ar-${artistId}`}
          alt={name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <ProgrammaticCover seed={`ar-${artistId}`} name={name} monogram />
      )}
    </div>
  )
}
