import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { FitAddon as FitAddonInstance } from '@xterm/addon-fit'
import type { Terminal as TerminalInstance } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './App.css'
import { ApiError, api } from './api'
import type { Attempt, Exam, QuestionProgress, Topic, User } from './types'

type Screen = 'loading' | 'auth' | 'dashboard' | 'topics' | 'tests' | 'briefing' | 'exam' | 'results'
type AuthMode = 'sign-in' | 'register'

const attemptStorageKey = 'termforge.activeAttempt'
const INITIAL_CLIENT_TIME = Date.now()

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

function secondsRemaining(deadline: string | null | undefined, now: number): number {
  if (!deadline) return 0
  return Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000))
}

function displayError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Sign in again to continue.'
    if (error.status === 403) return 'You do not have permission to do that.'
    if (error.status === 502) return 'The exam API is not running at the configured address. Start it or update the API proxy, then try again.'
    if (error.status === 503) return error.message
    if (error.status >= 500) return 'The service is temporarily unavailable. Please try again shortly.'
    return error.message
  }
  if (error instanceof TypeError) return 'Unable to reach the exam service. Check your connection and try again.'
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

function currentQuestion(attempt: Attempt): QuestionProgress | undefined {
  return (
    attempt.questions.find((question) => question.id === attempt.currentQuestionId) ??
    attempt.questions.find((question) => question.status === 'active')
  )
}

function App() {
  const [screen, setScreen] = useState<Screen>('loading')
  const [authMode, setAuthMode] = useState<AuthMode>('sign-in')
  const [user, setUser] = useState<User | null>(null)
  const [topics, setTopics] = useState<Topic[]>([])
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null)
  const [exam, setExam] = useState<Exam | null>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const clearAttemptStorage = useCallback(() => {
    try {
      window.localStorage.removeItem(attemptStorageKey)
    } catch {
      setNotice('Your browser could not clear the saved attempt reference.')
    }
  }, [])

  const persistAttempt = useCallback((nextAttempt: Attempt) => {
    try {
      if (nextAttempt.status === 'in_progress') {
        window.localStorage.setItem(attemptStorageKey, nextAttempt.id)
      } else {
        window.localStorage.removeItem(attemptStorageKey)
      }
    } catch {
      setNotice('Progress is saved by the server, but this browser could not save the resume shortcut.')
    }
  }, [])

  const restoreAttempt = useCallback(async () => {
    let savedAttemptId: string | null = null
    try {
      savedAttemptId = window.localStorage.getItem(attemptStorageKey)
    } catch {
      setNotice('Your browser blocked local storage. An in-progress attempt may not reopen automatically after refresh.')
    }
    if (!savedAttemptId) return false

    try {
      const restored = await api.getAttempt(savedAttemptId)
      if (restored.status === 'in_progress') {
        setAttempt(restored)
        setScreen('exam')
        setNotice('Your active exam has been restored. Timers continue while you are away.')
        return true
      }
      const result = await api.result(savedAttemptId)
      setAttempt(result)
      setScreen('results')
      clearAttemptStorage()
      return true
    } catch (restoreError) {
      if (restoreError instanceof ApiError && restoreError.status === 404) {
        clearAttemptStorage()
        return false
      }
      setError(displayError(restoreError))
      return false
    }
  }, [clearAttemptStorage])

  useEffect(() => {
    let cancelled = false
    async function initialize() {
      try {
        const currentUser = await api.me()
        if (cancelled) return
        setUser(currentUser)
        const restored = await restoreAttempt()
        if (!cancelled && !restored) setScreen('dashboard')
      } catch (loadError) {
        if (cancelled) return
        if (loadError instanceof ApiError && loadError.status === 401) {
          setScreen('auth')
        } else {
          setError(displayError(loadError))
          setScreen('auth')
        }
      }
    }
    void initialize()
    return () => {
      cancelled = true
    }
  }, [restoreAttempt])

  const handleAuthentication = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    const formData = new FormData(event.currentTarget)
    const email = String(formData.get('email') ?? '').trim()
    const password = String(formData.get('password') ?? '')
    try {
      const response =
        authMode === 'register'
          ? await api.register(String(formData.get('name') ?? '').trim(), email, password)
          : await api.signIn(email, password)
      setUser(response.user)
      setScreen('dashboard')
      setNotice('')
    } catch (authError) {
      setError(displayError(authError))
    } finally {
      setBusy(false)
    }
  }

  const handleSignOut = async () => {
    setError('')
    try {
      await api.signOut()
      clearAttemptStorage()
      setUser(null)
      setAttempt(null)
      setScreen('auth')
    } catch (signOutError) {
      setError(displayError(signOutError))
    }
  }

  const handleLoadTopics = async () => {
    setBusy(true)
    setError('')
    try {
      setTopics(await api.topics())
      setScreen('topics')
    } catch (topicsError) {
      setError(displayError(topicsError))
    } finally {
      setBusy(false)
    }
  }

  const handleChooseTopic = async (topic: Topic) => {
    if (topic.tests.length === 0) {
      setError('There are no published tests for this topic yet.')
      return
    }
    setSelectedTopic(topic)
    setScreen('tests')
  }

  const handleChooseTest = async (testId: string) => {
    setBusy(true)
    setError('')
    try {
      const briefing = await api.exam(testId)
      setExam(briefing)
      setScreen('briefing')
    } catch (briefingError) {
      setError(displayError(briefingError))
    } finally {
      setBusy(false)
    }
  }

  const handleBeginExam = async () => {
    if (!exam) return
    setBusy(true)
    setError('')
    try {
      const started = await api.startAttempt(exam.id)
      setAttempt(started)
      persistAttempt(started)
      setScreen('exam')
    } catch (startError) {
      setError(displayError(startError))
    } finally {
      setBusy(false)
    }
  }

  const updateAttempt = useCallback(
    (nextAttempt: Attempt) => {
      setAttempt(nextAttempt)
      persistAttempt(nextAttempt)
      if (nextAttempt.status !== 'in_progress') setScreen('results')
    },
    [persistAttempt],
  )

  const handleFinalSubmit = async () => {
    if (!attempt || busy) return
    setBusy(true)
    setError('')
    try {
      updateAttempt(await api.submitAttempt(attempt.id))
    } catch (submitError) {
      setError(displayError(submitError))
    } finally {
      setBusy(false)
    }
  }

  const handleQuestionCheck = async (question: QuestionProgress) => {
    if (!attempt || busy) return
    setBusy(true)
    setError('')
    try {
      await api.checkQuestion(attempt.id, question.id)
      updateAttempt(await api.getAttempt(attempt.id))
      setNotice('Answer checked. Your score is recorded by the exam service.')
    } catch (checkError) {
      setError(displayError(checkError))
    } finally {
      setBusy(false)
    }
  }

  const handleQuestionSubmit = async (question: QuestionProgress) => {
    if (!attempt || busy) return
    setBusy(true)
    setError('')
    try {
      updateAttempt(await api.submitQuestion(attempt.id, question.id))
    } catch (submitError) {
      setError(displayError(submitError))
    } finally {
      setBusy(false)
    }
  }

  const handleActivate = async (questionId: string) => {
    if (!attempt || busy) return
    setBusy(true)
    setError('')
    try {
      updateAttempt(await api.activateQuestion(attempt.id, questionId))
      setNotice('')
    } catch (activateError) {
      setError(displayError(activateError))
    } finally {
      setBusy(false)
    }
  }

  const handleExpiredQuestion = useCallback(
    async (activeAttempt: Attempt, question: QuestionProgress) => {
      try {
        updateAttempt(await api.submitQuestion(activeAttempt.id, question.id))
        setNotice('The question timer ended. This question is now locked.')
      } catch (expiryError) {
        setError(displayError(expiryError))
      }
    },
    [updateAttempt],
  )

  const handleExpiredExam = useCallback(
    async (activeAttempt: Attempt) => {
      try {
        updateAttempt(await api.submitAttempt(activeAttempt.id))
        setNotice('The overall exam time ended. Your attempt has been finalized.')
      } catch (expiryError) {
        try {
          updateAttempt(await api.result(activeAttempt.id))
        } catch (resultError) {
          setError(`${displayError(expiryError)} ${displayError(resultError)}`)
        }
      }
    },
    [updateAttempt],
  )

  const activeQuestion = attempt ? currentQuestion(attempt) : undefined

  return (
    <div className="app-shell">
      {screen !== 'loading' && screen !== 'auth' && (
        <header className="topbar">
          <button
            className="brand"
            type="button"
            onClick={() => {
              if (attempt?.status === 'in_progress') return
              setScreen('dashboard')
            }}
            aria-label="TermForge home"
          >
            <span className="brand-mark" aria-hidden="true">&gt;_</span>
            <span>termforge</span>
          </button>
          <div className="topbar-right">
            {user && <span className="user-greeting">Hi, {user.name}</span>}
            {user && (
              <button
                className="button button-quiet button-small"
                type="button"
                onClick={handleSignOut}
                disabled={attempt?.status === 'in_progress'}
                title={attempt?.status === 'in_progress' ? 'Finish or submit your active exam before signing out.' : undefined}
              >
                Sign out
              </button>
            )}
          </div>
        </header>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          <span>{error}</span>
          <button type="button" className="alert-close" aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {notice && screen !== 'loading' && (
        <div className="alert alert-info" role="status">
          <span>{notice}</span>
          <button type="button" className="alert-close" aria-label="Dismiss message" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}

      <main className={`main-content screen-${screen}`}>
        {screen === 'loading' && <LoadingScreen />}
        {screen === 'auth' && (
          <AuthScreen
            mode={authMode}
            busy={busy}
            onModeChange={(nextMode) => {
              setError('')
              setAuthMode(nextMode)
            }}
            onSubmit={handleAuthentication}
          />
        )}
        {screen === 'dashboard' && user && (
          <Dashboard user={user} busy={busy} onStart={handleLoadTopics} />
        )}
        {screen === 'topics' && (
          <TopicsScreen
            topics={topics}
            busy={busy}
            onSelect={handleChooseTopic}
            onBack={() => setScreen('dashboard')}
          />
        )}
        {screen === 'tests' && selectedTopic && (
          <TestsScreen
            topic={selectedTopic}
            busy={busy}
            onSelect={handleChooseTest}
            onBack={() => setScreen('topics')}
          />
        )}
        {screen === 'briefing' && exam && selectedTopic && (
          <BriefingScreen
            exam={exam}
            topic={selectedTopic}
            busy={busy}
            onBegin={handleBeginExam}
            onBack={() => setScreen('tests')}
          />
        )}
        {screen === 'exam' && attempt && (
          <ExamScreen
            attempt={attempt}
            question={activeQuestion}
            busy={busy}
            onCheck={handleQuestionCheck}
            onSubmitQuestion={handleQuestionSubmit}
            onActivate={handleActivate}
            onSubmitExam={handleFinalSubmit}
            onQuestionExpired={handleExpiredQuestion}
            onExamExpired={handleExpiredExam}
          />
        )}
        {screen === 'results' && attempt && (
          <ResultsScreen attempt={attempt} onDashboard={() => setScreen('dashboard')} />
        )}
      </main>
      {screen !== 'loading' && screen !== 'auth' && <Footer />}
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="loading-screen" role="status">
      <span className="brand-mark">&gt;_</span>
      <p>Restoring your exam workspace…</p>
    </div>
  )
}

function AuthScreen({
  mode,
  busy,
  onModeChange,
  onSubmit,
}: {
  mode: AuthMode
  busy: boolean
  onModeChange: (mode: AuthMode) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <section className="auth-layout">
      <div className="auth-intro">
        <span className="eyebrow">PRACTICE UNDER PRESSURE</span>
        <h1>Skills are built<br />one command at a time.</h1>
        <p>Hands-on technical exams that measure what you can do, not just what you know.</p>
        <div className="auth-terminal-art" aria-hidden="true">
          <span><i>$</i> git status</span>
          <span className="terminal-muted">On branch main</span>
          <span><i>$</i> docker ps</span>
          <span className="terminal-cursor">▌</span>
        </div>
      </div>
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-tabs" role="tablist" aria-label="Account access">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'sign-in'}
            className={mode === 'sign-in' ? 'auth-tab active' : 'auth-tab'}
            onClick={() => onModeChange('sign-in')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'auth-tab active' : 'auth-tab'}
            onClick={() => onModeChange('register')}
          >
            Create account
          </button>
        </div>
        <div className="auth-heading">
          <h2>{mode === 'sign-in' ? 'Welcome back' : 'Start your journey'}</h2>
          <p>{mode === 'sign-in' ? 'Sign in to continue to your workspace.' : 'Create an account to take your first exam.'}</p>
        </div>
        {mode === 'register' && (
          <label className="field">
            <span>Full name</span>
            <input autoComplete="name" name="name" placeholder="Your name" required maxLength={100} />
          </label>
        )}
        <label className="field">
          <span>Email address</span>
          <input autoComplete="email" type="email" name="email" placeholder="you@example.com" required maxLength={254} />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            type="password"
            name="password"
            placeholder="At least 8 characters"
            required
            minLength={mode === 'register' ? 8 : undefined}
          />
        </label>
        <button className="button button-primary auth-submit" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          {!busy && <span aria-hidden="true">→</span>}
        </button>
        <p className="auth-footnote">Secure access to your exam attempts and results.</p>
      </form>
    </section>
  )
}

function Dashboard({ user, busy, onStart }: { user: User; busy: boolean; onStart: () => void }) {
  return (
    <section className="dashboard-page">
      <div className="dashboard-hero">
        <div className="hero-copy">
          <span className="eyebrow">YOUR NEXT CHALLENGE AWAITS</span>
          <h1>Ready to get<br />your hands dirty?</h1>
          <p>Practice real-world technical skills in a focused, timed environment.</p>
          <button className="button button-primary" type="button" onClick={onStart} disabled={busy}>
            {busy ? 'Loading exams…' : 'Start contest'} <span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="hero-graphic" aria-hidden="true">
          <div className="hero-orbit orbit-one" />
          <div className="hero-orbit orbit-two" />
          <div className="hero-terminal">
            <div className="hero-terminal-head"><i /><i /><i /><span>~/workspace</span></div>
            <div className="hero-terminal-body">
              <p><b>$</b> git checkout -b feature/you</p>
              <p className="hero-success">Switched to a new branch</p>
              <p><b>$</b> docker build -t skills .</p>
              <p className="hero-success">Successfully built</p>
              <p><b>$</b> <span className="cursor-blink">▌</span></p>
            </div>
          </div>
          <span className="floating-chip chip-git">git</span>
          <span className="floating-chip chip-cli">CLI <b>✳</b></span>
        </div>
      </div>
      <div className="welcome-row">
        <div>
          <h2>Welcome, {user.name.split(' ')[0]}.</h2>
          <p>Choose a topic and put your skills to the test.</p>
        </div>
        <div className="dashboard-stat"><span>01</span><small>exam platform</small></div>
      </div>
      <div className="feature-strip">
        <Feature icon="⌘" title="Real practice" body="Hands-on tasks, not multiple choice." />
        <Feature icon="◷" title="Timed challenges" body="Work against the clock, just like the real thing." />
        <Feature icon="↗" title="Instant results" body="See your score and progress when you finish." />
      </div>
    </section>
  )
}

function Feature({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <article className="feature-card">
      <span className="feature-icon" aria-hidden="true">{icon}</span>
      <div><h3>{title}</h3><p>{body}</p></div>
    </article>
  )
}

function TopicsScreen({
  topics,
  busy,
  onSelect,
  onBack,
}: {
  topics: Topic[]
  busy: boolean
  onSelect: (topic: Topic) => void
  onBack: () => void
}) {
  return (
    <section className="content-page">
      <button className="back-link" type="button" onClick={onBack}>← Dashboard</button>
      <div className="page-heading">
        <span className="eyebrow">CHOOSE YOUR CHALLENGE</span>
        <h1>Pick a topic.</h1>
        <p>Each exam is worth 40 marks. Choose the area you want to tackle.</p>
      </div>
      {topics.length === 0 ? (
        <div className="empty-state">
          <span className="empty-symbol">⌁</span>
          <h2>No exams are available yet</h2>
          <p>Check back soon. Published challenges will appear here.</p>
        </div>
      ) : (
        <div className="topic-grid">
          {topics.map((topic, index) => (
            <button
              className="topic-card"
              type="button"
              key={topic.id}
              disabled={busy || topic.tests.length === 0}
              onClick={() => onSelect(topic)}
            >
              <span className={`topic-symbol topic-symbol-${index % 3}`} aria-hidden="true">
                {topic.slug === 'git-github' ? '⑂' : topic.slug === 'docker' ? '◈' : '⇄'}
              </span>
              <span className="topic-card-top">
                <span className="topic-kicker">TOPIC 0{index + 1}</span>
                <span className={topic.tests.length > 0 ? 'availability available' : 'availability'}>
                  <i />{topic.tests.length > 0 ? 'Available' : 'Coming soon'}
                </span>
              </span>
              <strong>{topic.name}</strong>
              <span className="topic-description">{topic.description}</span>
              <span className="topic-card-footer">
                {topic.tests.length > 0 ? `${topic.tests.length} tests available` : 'No published tests'}
                <b aria-hidden="true">↗</b>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function TestsScreen({
  topic,
  busy,
  onSelect,
  onBack,
}: {
  topic: Topic
  busy: boolean
  onSelect: (testId: string) => void
  onBack: () => void
}) {
  return (
    <section className="content-page">
      <button className="back-link" type="button" onClick={onBack}>← All topics</button>
      <div className="page-heading">
        <span className="eyebrow">{topic.name}</span>
        <h1>Choose a test.</h1>
        <p>Each test has 20 terminal questions, 40 marks, and a mix of easy, medium, and high difficulty.</p>
      </div>
      {topic.slug === 'docker' && (
        <div className="alert alert-info" role="note">
          Docker commands run in a simulator. No real images or containers are created.
        </div>
      )}
      <div className="topic-grid">
        {topic.tests.map((test) => (
          <button
            className="topic-card"
            type="button"
            key={test.id}
            disabled={busy}
            onClick={() => onSelect(test.id)}
          >
            <span className="topic-card-top">
              <span className="topic-kicker">PRACTICAL TEST</span>
              <span className="availability available"><i />Available</span>
            </span>
            <strong>{test.title}</strong>
            <span className="topic-description">{test.description}</span>
            <span className="topic-card-footer">
              {test.questionCount} questions · {test.totalMarks} marks
              <b aria-hidden="true">↗</b>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function BriefingScreen({
  exam,
  topic,
  busy,
  onBegin,
  onBack,
}: {
  exam: Exam
  topic: Topic
  busy: boolean
  onBegin: () => void
  onBack: () => void
}) {
  return (
    <section className="content-page briefing-page">
      <button className="back-link" type="button" onClick={onBack}>← All tests</button>
      <div className="briefing-header">
        <span className="topic-label">{topic.name}</span>
        <span className="briefing-rule" />
        <span className="eyebrow">EXAM BRIEFING</span>
      </div>
      <h1>{exam.title}</h1>
      <p className="briefing-lead">Take a moment to review the rules before you begin. Your timer starts as soon as you enter the workspace.</p>
      <div className="exam-stats">
        <BriefingStat label="Total marks" value={String(exam.totalMarks).padStart(2, '0')} note="maximum score" />
        <BriefingStat label="Questions" value={String(exam.questions.length).padStart(2, '0')} note="practical tasks" />
        <BriefingStat label="Overall time" value={formatTime(exam.overallDurationSeconds)} note="one continuous timer" />
      </div>
      <div className="briefing-columns">
        <section className="briefing-panel">
          <h2>Before you begin</h2>
          <ul className="rule-list">
            <li><span>01</span><div><strong>Every question is timed</strong><p>Question timers keep running if you move away. The overall timer never pauses.</p></div></li>
            <li><span>02</span><div><strong>Work is checked by state</strong><p>Complete each task in the provided terminal. Your score is calculated by the exam service.</p></div></li>
            <li><span>03</span><div><strong>Submitted questions lock</strong><p>You can move forward, but submitted or expired questions cannot be reopened.</p></div></li>
            <li><span>04</span><div><strong>You can submit early</strong><p>Submitting the exam ends your attempt and locks all remaining questions.</p></div></li>
          </ul>
        </section>
        <section className="question-overview">
          <h2>In this exam</h2>
          <div className="overview-list">
            {exam.questions.map((question, index) => (
              <div className="overview-row" key={question.id}>
                <span className="overview-number">{String(index + 1).padStart(2, '0')}</span>
                <div><strong>{question.title}</strong><span>{question.difficulty} difficulty · {formatTime(question.timeLimitSeconds)}</span></div>
                <span className="overview-marks">{question.marks} <small>pts</small></span>
              </div>
            ))}
          </div>
          <div className="overview-total"><span>Maximum score</span><strong>{exam.totalMarks} marks</strong></div>
        </section>
      </div>
      <div className="briefing-action">
        <p>Make sure you have enough uninterrupted time to complete the exam.</p>
        <button className="button button-primary" type="button" onClick={onBegin} disabled={busy}>
          {busy ? 'Preparing exam…' : 'Begin exam'} <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  )
}

function BriefingStat({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="exam-stat"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
}

function ExamScreen({
  attempt,
  question,
  busy,
  onCheck,
  onSubmitQuestion,
  onActivate,
  onSubmitExam,
  onQuestionExpired,
  onExamExpired,
}: {
  attempt: Attempt
  question?: QuestionProgress
  busy: boolean
  onCheck: (question: QuestionProgress) => void
  onSubmitQuestion: (question: QuestionProgress) => void
  onActivate: (questionId: string) => void
  onSubmitExam: () => void
  onQuestionExpired: (attempt: Attempt, question: QuestionProgress) => void
  onExamExpired: (attempt: Attempt) => void
}) {
  const [now, setNow] = useState(INITIAL_CLIENT_TIME)
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const expiredQuestions = useRef(new Set<string>())
  const examExpiryStarted = useRef(false)
  const questionRemaining = secondsRemaining(question?.deadlineAt, now)
  const examRemaining = secondsRemaining(attempt.examDeadlineAt, now)
  const completedCount = attempt.questions.filter((item) => item.status === 'submitted' || item.status === 'expired').length

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    expiredQuestions.current.clear()
    examExpiryStarted.current = false
  }, [attempt.id, question?.id])

  useEffect(() => {
    if (examRemaining === 0 && attempt.status === 'in_progress' && !examExpiryStarted.current) {
      examExpiryStarted.current = true
      onExamExpired(attempt)
      return
    }
    if (
      question &&
      question.status === 'active' &&
      questionRemaining === 0 &&
      !expiredQuestions.current.has(question.id)
    ) {
      expiredQuestions.current.add(question.id)
      onQuestionExpired(attempt, question)
    }
  }, [attempt, examRemaining, onExamExpired, onQuestionExpired, question, questionRemaining])

  const nextQuestion = attempt.questions.find((item) => item.status === 'locked' || item.status === 'skipped')
  const overallProgress = Math.min(100, Math.round((completedCount / attempt.questions.length) * 100))

  if (!question) {
    return (
      <div className="exam-empty">
        <h1>Exam state unavailable</h1>
        <p>The exam service did not return an active question. Refresh to restore the server-authoritative attempt.</p>
      </div>
    )
  }

  return (
    <div className="exam-layout">
      <div className="exam-toolbar">
        <div className="exam-identity">
          <span className="exam-topic-mark">&gt;_</span>
          <span><strong>Practical exam</strong><small>Attempt {attempt.id.slice(0, 8)}</small></span>
        </div>
        <div className="timer-group">
          <Timer label="Overall time" remaining={examRemaining} />
          <span className="timer-divider" />
          <Timer label="Question time" remaining={questionRemaining} />
        </div>
        <button
          className="button button-quiet button-small submit-exam-button"
          type="button"
          onClick={() => setConfirmSubmit(true)}
          disabled={busy}
        >
          Submit exam
        </button>
      </div>
      <div className="exam-progress-row">
        <div className="question-step">QUESTION <strong>{String(attempt.questions.indexOf(question) + 1).padStart(2, '0')}</strong><span>/ {String(attempt.questions.length).padStart(2, '0')}</span></div>
        <div className="progress-track" aria-label={`${overallProgress}% complete`}><span style={{ width: `${overallProgress}%` }} /></div>
        <span className="progress-copy">{completedCount} of {attempt.questions.length} complete</span>
      </div>
      <div className="exam-grid">
        <div className="question-column">
          <section className="question-card">
            <div className="question-card-meta">
              <span className="eyebrow">PRACTICAL TASK</span>
              <span className={`difficulty-pill difficulty-${question.difficulty}`}>{question.difficulty} difficulty</span>
              <span className="marks-pill">{question.marks} marks</span>
            </div>
            <h1>{question.title}</h1>
            <p className="question-prompt">{question.prompt}</p>
            <div className="subquestion-list">
              {question.subquestions.map((subquestion, index) => (
                <article className="subquestion" key={subquestion.id}>
                  <span className="subquestion-letter">{String.fromCharCode(65 + index)}</span>
                  <p>{subquestion.prompt}</p>
                  <span className="subquestion-marks">{subquestion.marks} pts</span>
                </article>
              ))}
            </div>
            <div className="question-tip"><span aria-hidden="true">ⓘ</span> Complete the tasks in the terminal below. Only executed work can be assessed.</div>
          </section>
          <TerminalPanel attemptId={attempt.id} question={question} />
          <div className="workspace-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={busy || question.status !== 'active'}
              onClick={() => onCheck(question)}
            >
              Check answer
            </button>
            {question.status === 'active' && (
              <button
                className="button button-primary"
                type="button"
                disabled={busy}
                onClick={() => onSubmitQuestion(question)}
              >
                Submit question <span aria-hidden="true">→</span>
              </button>
            )}
            {question.status !== 'active' && nextQuestion && (
              <button
                className="button button-primary"
                type="button"
                disabled={busy}
                onClick={() => onActivate(nextQuestion.id)}
              >
                Next question <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
        </div>
        <aside className="exam-sidebar">
          <div className="sidebar-card">
            <div className="sidebar-heading"><h2>Questions</h2><span>{attempt.totalScore}/{attempt.questions.reduce((sum, item) => sum + item.marks, 0)} pts</span></div>
            <div className="sidebar-question-list">
              {attempt.questions.map((item, index) => (
                <div className={`sidebar-question ${item.id === question.id ? 'current' : ''}`} key={item.id}>
                  <span className="sidebar-q-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="sidebar-q-name">{item.title}</span>
                  {item.status === 'submitted' ? <span className="status-check" aria-label="Submitted">✓</span> : item.id === question.id ? <span className="status-current" aria-label="Current" /> : <span className="sidebar-q-mark">{item.marks}</span>}
                </div>
              ))}
            </div>
            <div className="sidebar-total"><span>Exam total</span><strong>40 <small>marks</small></strong></div>
          </div>
          <div className="sidebar-note"><span aria-hidden="true">◷</span><p><strong>Timers keep running</strong>Your exam and question clocks continue even when you leave this page.</p></div>
        </aside>
      </div>
      {confirmSubmit && (
        <ConfirmDialog
          title="Submit your exam?"
          description="This will end your attempt and lock any unanswered questions. You cannot return to the workspace after submission."
          confirmLabel="Submit exam"
          busy={busy}
          onCancel={() => setConfirmSubmit(false)}
          onConfirm={() => {
            setConfirmSubmit(false)
            onSubmitExam()
          }}
        />
      )}
    </div>
  )
}

function Timer({ label, remaining }: { label: string; remaining: number }) {
  const urgent = remaining <= 60
  return (
    <div className={`timer ${urgent ? 'timer-urgent' : ''}`} aria-live="off">
      <span className="timer-label">{label}</span>
      <strong>{formatTime(remaining)}</strong>
      {urgent && <span className="timer-warning">Time is running out</span>}
    </div>
  )
}

function TerminalPanel({ attemptId, question }: { attemptId: string; question: QuestionProgress }) {
  const terminalHost = useRef<HTMLDivElement>(null)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline' | 'closed'>('connecting')
  const [connectionMessage, setConnectionMessage] = useState('')
  const activeTerminal = question.status === 'active'

  useEffect(() => {
    const host = terminalHost.current
    if (!host || !activeTerminal) {
      setConnection('closed')
      return
    }
    let disposed = false
    let socket: WebSocket | undefined
    let terminal: TerminalInstance | undefined
    let fitAddon: FitAddonInstance | undefined
    let resizeObserver: ResizeObserver | undefined

    const setup = async () => {
      setConnection('connecting')
      setConnectionMessage('')
      try {
        const session = await api.createTerminalSession(attemptId)
        if (disposed) return
        const [{ FitAddon }, { Terminal }] = await Promise.all([
          import('@xterm/addon-fit'),
          import('@xterm/xterm'),
        ])
        if (disposed) return
        const endpoint = new URL(session.websocketUrl, window.location.href)
        endpoint.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        terminal = new Terminal({
          cursorBlink: true,
          convertEol: true,
          fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", monospace',
          fontSize: 13,
          theme: {
            background: '#11131a',
            foreground: '#e4e8f0',
            cursor: '#72e0c2',
            selectionBackground: '#293b45',
          },
        })
        fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        terminal.open(host)
        fitAddon.fit()
        terminal.writeln('\x1b[38;2;114;224;194mConnected to your isolated workspace\x1b[0m')
        socket = new WebSocket(endpoint)
        socket.binaryType = 'arraybuffer'
        socket.addEventListener('open', () => {
          if (disposed) return
          setConnection('connected')
        })
        socket.addEventListener('message', (event) => {
          if (event.data instanceof ArrayBuffer) {
            terminal?.write(new Uint8Array(event.data))
          } else if (typeof event.data === 'string') {
            terminal?.write(event.data)
          } else {
            setConnectionMessage('The terminal sent an unsupported response.')
          }
        })
        socket.addEventListener('close', () => {
          if (!disposed) setConnection('closed')
        })
        socket.addEventListener('error', () => {
          if (!disposed) {
            setConnection('offline')
            setConnectionMessage('Could not connect to the isolated terminal worker.')
          }
        })
        let currentInput = ''
        terminal.onData((data) => {
          if (socket?.readyState !== WebSocket.OPEN) return
          for (const character of data) {
            if (character === '\r') {
              terminal?.write('\r\n')
              socket.send(`${currentInput}\n`)
              currentInput = ''
            } else if (character === '\u007f') {
              if (currentInput.length > 0) {
                currentInput = currentInput.slice(0, -1)
                terminal?.write('\b \b')
              }
            } else if (character === '\u0003') {
              if (currentInput.length > 0) {
                currentInput = ''
                terminal?.write('^C\r\n')
              }
            } else if (character === '\t') {
              currentInput += '    '
              terminal?.write('    ')
            } else if (character >= ' ') {
              currentInput += character
              terminal?.write(character)
            }
          }
        })
        resizeObserver = new ResizeObserver(() => {
          try {
            fitAddon?.fit()
          } catch {
            setConnectionMessage('The terminal could not resize to the available space.')
          }
        })
        resizeObserver.observe(host)
      } catch (terminalError) {
        if (disposed) return
        setConnection('offline')
        setConnectionMessage(
          terminalError instanceof ApiError && terminalError.status === 503
            ? 'Isolated terminal execution is not configured. Your exam is safe, but terminal commands are unavailable.'
            : displayError(terminalError),
        )
      }
    }
    void setup()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      socket?.close(1000, 'Question changed or workspace closed')
      terminal?.dispose()
    }
  }, [activeTerminal, attemptId, question.id])

  return (
    <section className="terminal-card" aria-label="Exam terminal">
      <div className="terminal-card-header">
        <div className="terminal-title"><span className="terminal-prompt-icon">&gt;_</span><strong>Terminal</strong><span className="terminal-path">~/workspace</span></div>
        <div className={`connection-status connection-${connection}`}><i />{connection === 'connected' ? 'Connected' : connection === 'connecting' ? 'Connecting' : connection === 'closed' ? 'Session closed' : 'Unavailable'}</div>
      </div>
      {connection === 'offline' && (
        <div className="terminal-disabled" role="status">
          <span className="terminal-disabled-icon">⌁</span>
          <strong>Isolated terminal unavailable</strong>
          <p>{connectionMessage || 'The exam API could not issue a terminal session.'}</p>
          <small>TermForge never runs exam commands on the application host.</small>
        </div>
      )}
      <div
        className={`terminal-screen ${connection === 'offline' ? 'terminal-screen-disabled' : ''}`}
        ref={terminalHost}
        aria-label="Terminal output"
      />
      {connectionMessage && connection !== 'offline' && <p className="terminal-inline-error" role="status">{connectionMessage}</p>}
    </section>
  )
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel()
    }}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <span className="dialog-icon">!</span>
        <h2 id="confirm-title">{title}</h2>
        <p>{description}</p>
        <div className="dialog-actions">
          <button className="button button-quiet" type="button" onClick={onCancel} disabled={busy}>Keep working</button>
          <button className="button button-primary" type="button" onClick={onConfirm} disabled={busy}>{busy ? 'Submitting…' : confirmLabel}</button>
        </div>
      </section>
    </div>
  )
}

function ResultsScreen({ attempt, onDashboard }: { attempt: Attempt; onDashboard: () => void }) {
  const maximum = attempt.questions.reduce((sum, question) => sum + question.marks, 0)
  const percentage = maximum === 0 ? 0 : Math.round((attempt.totalScore / maximum) * 100)
  const completed = attempt.questions.filter((question) => question.status === 'submitted').length
  const unanswered = attempt.questions.filter((question) => question.status === 'skipped' || question.status === 'locked').length

  return (
    <section className="results-page content-page">
      <div className="results-hero">
        <span className="eyebrow">ATTEMPT COMPLETE</span>
        <h1>You showed up.<br /><em>That counts.</em></h1>
        <p>Your results are ready. Review your score and question breakdown below.</p>
        <div className="result-score">
          <strong>{attempt.totalScore}</strong><span>/ {maximum}</span>
          <small>marks earned · {percentage}%</small>
        </div>
      </div>
      <div className="results-summary">
        <div><strong>{completed}</strong><span>questions submitted</span></div>
        <div><strong>{unanswered}</strong><span>left unanswered</span></div>
        <div><strong>{attempt.status === 'expired' ? 'Time' : 'Submitted'}</strong><span>{attempt.status === 'expired' ? 'exam ended' : 'attempt status'}</span></div>
      </div>
      <div className="results-breakdown">
        <div className="results-breakdown-heading"><div><span className="eyebrow">YOUR PERFORMANCE</span><h2>Question breakdown</h2></div><span>Score</span></div>
        {attempt.questions.map((question, index) => (
          <article className="result-question" key={question.id}>
            <span className="result-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="result-question-main">
              <strong>{question.title}</strong>
              {question.feedback?.length ? (
                <ul>{question.feedback.map((item, feedbackIndex) => <li key={`${question.id}-${feedbackIndex}`}>{item}</li>)}</ul>
              ) : (
                <span>{question.status === 'expired' ? 'Time expired' : question.status === 'skipped' || question.status === 'locked' ? 'Not attempted' : 'Submitted'}</span>
              )}
            </div>
            <strong className="result-marks">{question.score}<small> / {question.marks}</small></strong>
          </article>
        ))}
      </div>
      <div className="results-actions">
        <p>Keep practicing. Every attempt is progress.</p>
        <button className="button button-primary" type="button" onClick={onDashboard}>Back to dashboard <span aria-hidden="true">→</span></button>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="app-footer">
      <span><span className="brand-mark small">&gt;_</span> termforge</span>
      <span>Built for learning by doing.</span>
    </footer>
  )
}

export default App
