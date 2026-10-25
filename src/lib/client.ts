export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || data.error?.message || data.error || `Erreur ${response.status}`), { diagnostic: typeof data.diagnostic === 'string' ? data.diagnostic : undefined });
  return data;
}
export const bytes = (value: number = 0) => { if (!Number.isFinite(value)) return '—'; const unit = Math.min(4, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024))); return `${(value / 1024 ** unit).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${['o', 'Kio', 'Mio', 'Gio', 'Tio'][unit]}`; };
export const duration = (seconds: number) => !Number.isFinite(seconds) || seconds < 0 || seconds > 8640000 ? '—' : seconds < 60 ? `${Math.ceil(seconds)} s` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`;
