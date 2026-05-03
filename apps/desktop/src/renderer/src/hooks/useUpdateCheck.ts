import { useEffect, useState } from 'react';

/** Compare two semver strings. Returns true when `a` is strictly newer than `b`. */
function semverGt(a: string, b: string): boolean {
  const parse = (s: string) => s.split('.').map((n) => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

export function useUpdateCheck(): { hasUpdate: boolean } {
  const [hasUpdate, setHasUpdate] = useState(false);

  useEffect(() => {
    const check = () => {
      fetch('https://api.github.com/repos/unbug/tday/releases/latest', { cache: 'no-store' })
        .then((r) => r.json() as Promise<{ tag_name?: string }>)
        .then(({ tag_name }) => {
          if (typeof tag_name === 'string') {
            const remote = tag_name.replace(/^v/, '');
            // Only flag an update when the released version is strictly newer than current.
            setHasUpdate(semverGt(remote, __APP_VERSION__));
          }
        })
        .catch(() => { /* network unavailable — silently ignore */ });
    };
    const initial = setTimeout(check, 10_000);
    const interval = setInterval(check, 30 * 60_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, []);

  return { hasUpdate };
}
