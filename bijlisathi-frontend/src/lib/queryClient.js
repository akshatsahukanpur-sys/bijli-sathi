import { QueryClient } from "@tanstack/react-query"

// Best-practice defaults for BijliSathi:
// - staleTime 30s keeps KESCO dashboard snappy without thrashing
// - retry 1 for resilience on Railway cold starts
// - refetchOnWindowFocus true so tracking pages auto-refresh when user returns
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      gcTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
})
