interface Props {
  size?: number;
  className?: string;
}

/**
 * Tday logo — "Tday" wordmark on a border-beam animated gradient pill.
 * The animation is driven by the `.logo-beam` keyframes in styles.css.
 */
export function Logo({ size = 28, className = '' }: Props) {
  return (
    <span
      className={`logo-beam relative inline-flex items-center justify-center rounded-md px-2 font-bold tracking-tight text-zinc-100 ${className}`}
      style={{
        height: size,
        fontSize: size * 0.55,
        letterSpacing: '-0.04em',
      }}
    >
      Tday
    </span>
  );
}
