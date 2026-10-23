export type TopicSlug = 'git-github' | 'docker' | 'data-migration'

export interface Subquestion {
  id: string
  prompt: string
  marks: number
}

export interface Question {
  id: string
  title: string
  prompt: string
  timeLimitSeconds: number
  marks: number
  subquestions: Subquestion[]
}

export interface Exam {
  id: string
  title: string
  topicId: string
  overallDurationSeconds: number
  totalMarks: number
  navigationPolicy: 'free' | 'forward-only'
  reviewPolicy: 'score' | 'feedback'
  questions: Question[]
}

export interface Topic {
  id: string
  slug: TopicSlug
  name: string
  description: string
  exam?: Pick<Exam, 'id' | 'title' | 'overallDurationSeconds' | 'totalMarks' | 'questions'>
}

export interface QuestionProgress extends Question {
  status: 'locked' | 'active' | 'submitted' | 'expired' | 'skipped'
  startedAt: string | null
  deadlineAt: string | null
  score: number
  feedback?: string[]
}

export interface Attempt {
  id: string
  examId: string
  status: 'in_progress' | 'submitted' | 'expired'
  startedAt: string
  examDeadlineAt: string
  currentQuestionId: string | null
  totalScore: number
  questions: QuestionProgress[]
}

export interface User {
  id: string
  name: string
  email: string
  role: 'candidate' | 'admin'
}

export interface TerminalSession {
  id: string
  websocketUrl: string
}
