import { useState, useCallback, useRef, useEffect } from 'react';

export function useErrorToast() {
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const showError = useCallback((message: string) => {
    setError(message);
    if (timerRef.current) clearTimeout(timerRef.current);
    // Auto-dismiss after 4 seconds
    timerRef.current = setTimeout(() => setError(null), 4000);
  }, []);

  const dismissError = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setError(null);
  }, []);

  return { error, showError, dismissError };
}
