import { useCallback, useState } from 'react';

export interface KeepAwakeHook {
  keepAwakeId: number | null;
  toggleKeepAwake: () => Promise<void>;
  initKeepAwake: (enabled: boolean) => void;
}

export function useKeepAwake(): KeepAwakeHook {
  const [keepAwakeId, setKeepAwakeId] = useState<number | null>(null);

  const toggleKeepAwake = useCallback(async (): Promise<void> => {
    if (keepAwakeId !== null) {
      await window.tday.powerBlockerStop(keepAwakeId);
      setKeepAwakeId(null);
      void window.tday.setSetting('tday:keep-awake', false);
    } else {
      const { id } = await window.tday.powerBlockerStart();
      setKeepAwakeId(id);
      void window.tday.setSetting('tday:keep-awake', true);
    }
  }, [keepAwakeId]);

  const initKeepAwake = useCallback((enabled: boolean): void => {
    if (enabled) {
      void window.tday.powerBlockerStart()
        .then(({ id }) => setKeepAwakeId(id))
        .catch(() => {});
    }
  }, []);

  return { keepAwakeId, toggleKeepAwake, initKeepAwake };
}
