import type { Attempt, Exam, TerminalSession, Topic, User } from './types'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string; error?: string }
      | null
    throw new ApiError(
      body?.message ?? body?.error ?? `Request failed (${response.status})`,
      response.status,
    )
  }
  if (response.status === 204) return undefined as T
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    throw new ApiError(
      'The exam API returned an unexpected response. Check the API URL and proxy configuration.',
      response.status,
    )
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError('The exam API returned malformed JSON.', response.status)
  }
}

export const api = {
  me: () => request<User>('/api/me'),
  signIn: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (name: string, email: string, password: string) =>
    request<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    }),
  signOut: () => request<void>('/api/auth/logout', { method: 'POST' }),
  topics: () => request<Topic[]>('/api/topics'),
  exam: (id: string) => request<Exam>(`/api/exams/${id}/briefing`),
  startAttempt: (examId: string) =>
    request<Attempt>(`/api/exams/${examId}/attempts`, { method: 'POST' }),
  getAttempt: (id: string) => request<Attempt>(`/api/attempts/${id}`),
  checkQuestion: (attemptId: string, questionId: string) =>
    request<{ score: number; maximum: number; feedback?: string[] }>(
      `/api/attempts/${attemptId}/questions/${questionId}/check`,
      { method: 'POST' },
    ),
  activateQuestion: (attemptId: string, questionId: string) =>
    request<Attempt>(
      `/api/attempts/${attemptId}/questions/${questionId}/activate`,
      { method: 'POST' },
    ),
  submitQuestion: (attemptId: string, questionId: string) =>
    request<Attempt>(
      `/api/attempts/${attemptId}/questions/${questionId}/submit`,
      { method: 'POST' },
    ),
  submitAttempt: (attemptId: string) =>
    request<Attempt>(`/api/attempts/${attemptId}/submit`, { method: 'POST' }),
  result: (attemptId: string) =>
    request<Attempt>(`/api/attempts/${attemptId}/result`),
  createTerminalSession: (attemptId: string) =>
    request<TerminalSession>(`/api/attempts/${attemptId}/terminal-session`, {
      method: 'POST',
    }),
}
