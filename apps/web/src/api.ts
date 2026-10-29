export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export async function api<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options?.body ? { 'Content-Type': 'application/json' } : {}) } })
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.error?.message || '無法完成操作', response.status)
  return data as T
}
