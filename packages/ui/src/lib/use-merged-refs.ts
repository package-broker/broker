import { useCallback, type Ref } from 'react';

export function useMergedRefs<T>(first: Ref<T> | undefined, second: Ref<T> | undefined) {
  return useCallback(
    (element: T | null) => {
      const cleanups = [first, second].map((ref) => {
        if (typeof ref === 'function') {
          const cleanup = ref(element);
          return typeof cleanup === 'function' ? cleanup : () => ref(null);
        }
        if (ref) ref.current = element;
        return () => {
          if (ref) ref.current = null;
        };
      });
      return () => {
        for (const cleanup of cleanups) cleanup();
      };
    },
    [first, second],
  );
}
