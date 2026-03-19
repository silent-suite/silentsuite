import { useState, useCallback } from 'react';

export function useErrorToast() {
  const [error, setError] = useState<string | null>(null);

  const showError = useCallback((message: string) => {
    setError(message);
    // Auto-dismiss after 4 seconds
    setTimeout(() => setError(null), 4000);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return { error, showError, dismissError };
}
