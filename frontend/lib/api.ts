import type {
  Permit,
  PermitSearchParams,
  PaginatedPermits,
  DashboardStats,
  TransportRequest,
  MatchResult,
  TransportAnfrage,
  AnfragenStats,
} from "./types";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  (process.env.NODE_ENV === "production" ? "" : "http://localhost:8000");

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ─── Upload ──────────────────────────────────────────────────────────────
  async uploadPDF(file: File): Promise<Permit> {
    const body = new FormData();
    body.append("file", file);
    return apiFetch<Permit>("/api/upload/pdf", { method: "POST", body });
  },

  async uploadBatch(files: File[]): Promise<Permit[]> {
    const body = new FormData();
    files.forEach((f) => body.append("files", f));
    return apiFetch<Permit[]>("/api/upload/batch", { method: "POST", body });
  },

  // ─── Permits ─────────────────────────────────────────────────────────────
  async getPermits(params?: PermitSearchParams): Promise<PaginatedPermits> {
    const qs = params
      ? new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : "";
    return apiFetch<PaginatedPermits>(`/api/permits${qs ? `?${qs}` : ""}`);
  },

  async getPermit(id: number): Promise<Permit> {
    return apiFetch<Permit>(`/api/permits/${id}`);
  },

  async updatePermit(id: number, data: Partial<Permit>): Promise<Permit> {
    return apiFetch<Permit>(`/api/permits/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  },

  async updatePermitStatus(
    id: number,
    status: string,
    geprueft_von?: string
  ): Promise<Permit> {
    return apiFetch<Permit>(`/api/permits/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, geprueft_von }),
    });
  },

  async deletePermit(id: number): Promise<void> {
    await apiFetch<unknown>(`/api/permits/${id}`, { method: "DELETE" });
  },

  async getExpiringPermits(days = 30): Promise<Permit[]> {
    return apiFetch<Permit[]>(`/api/permits/expiring?days=${days}`);
  },

  async getStats(): Promise<DashboardStats> {
    return apiFetch<DashboardStats>("/api/permits/stats");
  },

  // ─── Matching ────────────────────────────────────────────────────────────
  async findMatches(request: TransportRequest): Promise<MatchResult[]> {
    return apiFetch<MatchResult[]>("/api/matching/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  },

  async createAnfrage(data: FormData | object): Promise<TransportAnfrage> {
    const isFormData = data instanceof FormData;
    return apiFetch<TransportAnfrage>("/api/anfragen", {
      method: "POST",
      ...(isFormData
        ? { body: data }
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          }),
    });
  },

  async getAnfragen(params?: Record<string, string>): Promise<TransportAnfrage[]> {
    const qs = params
      ? new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== "")
        ).toString()
      : "";
    return apiFetch<TransportAnfrage[]>(`/api/anfragen${qs ? `?${qs}` : ""}`);
  },

  async getAnfrage(id: number): Promise<TransportAnfrage> {
    return apiFetch<TransportAnfrage>(`/api/anfragen/${id}`);
  },

  async updateAnfrageStatus(id: number, status: string): Promise<TransportAnfrage> {
    return apiFetch<TransportAnfrage>(`/api/anfragen/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  },

  async regenerateBriefing(id: number): Promise<TransportAnfrage> {
    return apiFetch<TransportAnfrage>(`/api/anfragen/${id}/briefing`, { method: "POST" });
  },

  async regenerateReply(id: number): Promise<{ kundenantwort_entwurf: string }> {
    return apiFetch<{ kundenantwort_entwurf: string }>(`/api/anfragen/${id}/reply`, { method: "POST" });
  },

  async getAnfragenStats(): Promise<AnfragenStats> {
    return apiFetch<AnfragenStats>("/api/anfragen/stats");
  },
};
