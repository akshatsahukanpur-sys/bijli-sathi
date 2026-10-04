import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import toast from "react-hot-toast"

// Example of how to use @tanstack/react-query + react-hot-toast + axios-style api
// This replaces manual fetch + useEffect boilerplate throughout CitizenHome / KescoDashboard

export function useMyComplaints() {
  return useQuery({
    queryKey: ["complaints", "my"],
    queryFn: () => api("/complaints/my"),
    staleTime: 15 * 1000,
  })
}

export function useKescoOverview() {
  return useQuery({
    queryKey: ["kesco", "overview"],
    queryFn: () => api("/kesco/overview"),
    refetchInterval: 20 * 1000, // live dashboard
  })
}

export function useCreateComplaint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload) => api("/complaints", { method: "POST", body: payload }),
    onSuccess: () => {
      toast.success("Complaint submitted — AI triaging now ✓")
      qc.invalidateQueries({ queryKey: ["complaints"] })
    },
    onError: (e) => toast.error(e.message || "Failed to submit — try again"),
  })
}
