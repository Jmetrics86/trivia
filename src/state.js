export const STORAGE_KEY = 'ivcf_trivia_state_v1';

export const TEAM_COLORS = [
  { id: 'crimson', label: 'Valor Red', hex: '#A8302D' },
  { id: 'navy', label: 'Iron Navy', hex: '#212A59' },
  { id: 'steel', label: 'Steel Blue', hex: '#518D9E' },
  { id: 'gold', label: 'Gold', hex: '#B47B2B' },
  { id: 'pine', label: 'Pine', hex: '#2F6F5E' },
  { id: 'slate', label: 'Charcoal', hex: '#4B5568' }
];

const MAX_LOGS = 500;

/** Generate a compact unique identifier for teams, custom questions, and logs. */
export function makeId(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** Build a fresh default application state. */
export function createInitialState() {
  const teamA = { id: 'team-1', name: 'Team Valor', color: '#A8302D', score: 0 };
  const teamB = { id: 'team-2', name: 'Team Iron', color: '#212A59', score: 0 };
  return {
    version: 1,
    teams: [teamA, teamB],
    activeTeamId: teamA.id,
    askedIds: [],
    currentQuestionId: null,
    logs: [
      {
        id: makeId('log'),
        timestamp: new Date().toISOString(),
        type: 'system',
        teamId: null,
        teamName: 'System',
        category: null,
        questionId: null,
        questionText: 'New Iron Valor Trivia session initialized.',
        delta: 0,
        newScore: null
      }
    ],
    customQuestions: [],
    settings: {
      scoringMode: 'difficulty',
      flatPoints: 100,
      wrongPenalty: false,
      autoRotateTeam: true,
      showChoicesByDefault: true
    }
  };
}

function getDefaultStorage() {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

/** Load persisted state from storage, falling back safely to defaults. */
export function loadState(storage = getDefaultStorage()) {
  if (!storage) return createInitialState();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    return sanitizeState(JSON.parse(raw));
  } catch {
    return createInitialState();
  }
}

/** Persist state to storage. */
export function saveState(state, storage = getDefaultStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Normalize an untrusted/imported state object so missing fields never crash the UI. */
export function sanitizeState(raw) {
  const base = createInitialState();
  if (!raw || typeof raw !== 'object') return base;

  const teams = Array.isArray(raw.teams)
    ? raw.teams
        .filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string')
        .map((t, idx) => ({
          id: t.id,
          name: t.name.trim().slice(0, 32) || `Team ${idx + 1}`,
          color: typeof t.color === 'string' ? t.color : TEAM_COLORS[idx % TEAM_COLORS.length].hex,
          score: Number.isFinite(Number(t.score)) ? Math.trunc(Number(t.score)) : 0
        }))
    : base.teams;

  const activeTeamId = teams.some((t) => t.id === raw.activeTeamId)
    ? raw.activeTeamId
    : (teams[0]?.id ?? null);

  const settingsRaw = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const flatPoints = Number.isFinite(Number(settingsRaw.flatPoints))
    ? Math.max(1, Math.min(10000, Math.trunc(Number(settingsRaw.flatPoints))))
    : base.settings.flatPoints;

  const customQuestions = Array.isArray(raw.customQuestions)
    ? raw.customQuestions.filter(isValidQuestion)
    : [];

  return {
    version: 1,
    teams,
    activeTeamId,
    askedIds: Array.isArray(raw.askedIds) ? raw.askedIds.filter((id) => typeof id === 'string') : [],
    currentQuestionId: typeof raw.currentQuestionId === 'string' ? raw.currentQuestionId : null,
    logs: Array.isArray(raw.logs) ? raw.logs.slice(0, MAX_LOGS) : [],
    customQuestions,
    settings: {
      scoringMode: settingsRaw.scoringMode === 'flat' ? 'flat' : 'difficulty',
      flatPoints,
      wrongPenalty: Boolean(settingsRaw.wrongPenalty),
      autoRotateTeam: settingsRaw.autoRotateTeam !== undefined ? Boolean(settingsRaw.autoRotateTeam) : true,
      showChoicesByDefault:
        settingsRaw.showChoicesByDefault !== undefined ? Boolean(settingsRaw.showChoicesByDefault) : true
    }
  };
}

/** Validate the structure of a trivia question object. */
export function isValidQuestion(q) {
  if (!q || typeof q !== 'object') return false;
  if (typeof q.id !== 'string' || !q.id.trim()) return false;
  if (typeof q.category !== 'string' || !q.category.trim()) return false;
  if (typeof q.question !== 'string' || !q.question.trim()) return false;
  if (!Array.isArray(q.choices) || q.choices.length !== 4) return false;
  if (q.choices.some((c) => typeof c !== 'string' || !c.trim())) return false;
  if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex > 3) return false;
  return true;
}

/** Combine built-in questions with admin-added custom questions. */
export function getAllQuestions(baseQuestions, state) {
  return [...baseQuestions, ...(state.customQuestions || [])];
}

/** Compute the point value for a question under the current admin settings. */
export function getQuestionPoints(question, settings) {
  if (settings.scoringMode === 'flat') {
    return settings.flatPoints;
  }
  const pts = Number(question?.points);
  return Number.isFinite(pts) && pts > 0 ? Math.trunc(pts) : 100;
}

/** Filter unasked questions by optional category and difficulty. */
export function getAvailableQuestions(allQuestions, state, { category = 'all', difficulty = 'all' } = {}) {
  const askedSet = new Set(state.askedIds);
  return allQuestions.filter((q) => {
    if (askedSet.has(q.id)) return false;
    if (category !== 'all' && q.category !== category) return false;
    if (difficulty !== 'all' && q.difficulty !== difficulty) return false;
    return true;
  });
}

/** Pull a random unasked question matching the selected filters (avoiding immediate repeat of currentQuestionId when possible). */
export function pullRandomQuestion(
  allQuestions,
  state,
  { category = 'all', difficulty = 'all', rng = Math.random } = {}
) {
  const pool = getAvailableQuestions(allQuestions, state, { category, difficulty });
  if (pool.length === 0) {
    return { question: null, remainingInFilter: 0 };
  }
  const nonCurrent = pool.length > 1
    ? pool.filter((q) => q.id !== state.currentQuestionId)
    : pool;
  const idx = Math.floor(rng() * nonCurrent.length);
  const picked = nonCurrent[Math.min(idx, nonCurrent.length - 1)];
  return { question: picked, remainingInFilter: pool.length };
}

function appendLog(logs, entry) {
  const next = [
    {
      id: makeId('log'),
      timestamp: new Date().toISOString(),
      ...entry
    },
    ...logs
  ];
  return next.slice(0, MAX_LOGS);
}

/** Add a new team and log it. */
export function addTeam(state, name, color = TEAM_COLORS[0].hex) {
  const cleanName = String(name || '').trim().slice(0, 32);
  if (!cleanName) {
    return { state, error: 'Team name cannot be empty.' };
  }
  const duplicate = state.teams.some(
    (t) => t.name.toLowerCase() === cleanName.toLowerCase()
  );
  if (duplicate) {
    return { state, error: `Team "${cleanName}" already exists.` };
  }
  const newTeam = {
    id: makeId('team'),
    name: cleanName,
    color,
    score: 0
  };
  const teams = [...state.teams, newTeam];
  const next = {
    ...state,
    teams,
    activeTeamId: state.activeTeamId || newTeam.id,
    logs: appendLog(state.logs, {
      type: 'system',
      teamId: newTeam.id,
      teamName: newTeam.name,
      category: null,
      questionId: null,
      questionText: `Created team "${newTeam.name}".`,
      delta: 0,
      newScore: 0
    })
  };
  return { state: next, team: newTeam };
}

/** Rename an existing team and log the change. */
export function renameTeam(state, teamId, newName) {
  const cleanName = String(newName || '').trim().slice(0, 32);
  if (!cleanName) return { state, error: 'Team name cannot be empty.' };
  const existing = state.teams.find((t) => t.id === teamId);
  if (!existing) return { state, error: 'Team not found.' };
  const duplicate = state.teams.some(
    (t) => t.id !== teamId && t.name.toLowerCase() === cleanName.toLowerCase()
  );
  if (duplicate) return { state, error: `Team "${cleanName}" already exists.` };

  const teams = state.teams.map((t) => (t.id === teamId ? { ...t, name: cleanName } : t));
  const next = {
    ...state,
    teams,
    logs: appendLog(state.logs, {
      type: 'system',
      teamId,
      teamName: cleanName,
      category: null,
      questionId: null,
      questionText: `Renamed team "${existing.name}" to "${cleanName}".`,
      delta: 0,
      newScore: existing.score
    })
  };
  return { state: next };
}

/** Delete a team and update activeTeamId if needed. */
export function deleteTeam(state, teamId) {
  const existing = state.teams.find((t) => t.id === teamId);
  if (!existing) return state;
  const teams = state.teams.filter((t) => t.id !== teamId);
  const activeTeamId =
    state.activeTeamId === teamId ? (teams[0]?.id ?? null) : state.activeTeamId;
  return {
    ...state,
    teams,
    activeTeamId,
    logs: appendLog(state.logs, {
      type: 'system',
      teamId,
      teamName: existing.name,
      category: null,
      questionId: null,
      questionText: `Removed team "${existing.name}" (final score: ${existing.score}).`,
      delta: 0,
      newScore: null
    })
  };
}

/** Set the currently selected active team. */
export function setActiveTeam(state, teamId) {
  if (!state.teams.some((t) => t.id === teamId)) return state;
  return { ...state, activeTeamId: teamId };
}

/** Manually adjust a team's score by delta and write an audit log entry. */
export function adjustTeamScore(state, teamId, delta, note = 'Manual admin adjustment') {
  const numDelta = Math.trunc(Number(delta));
  if (!Number.isFinite(numDelta) || numDelta === 0) return state;
  const target = state.teams.find((t) => t.id === teamId);
  if (!target) return state;

  const newScore = target.score + numDelta;
  const teams = state.teams.map((t) =>
    t.id === teamId ? { ...t, score: newScore } : t
  );
  return {
    ...state,
    teams,
    logs: appendLog(state.logs, {
      type: 'manual',
      teamId: target.id,
      teamName: target.name,
      category: null,
      questionId: null,
      questionText: String(note || 'Manual admin adjustment').trim(),
      delta: numDelta,
      newScore
    })
  };
}

/** Advance activeTeamId to the next team in order. */
function getNextTeamId(teams, currentId) {
  if (teams.length === 0) return null;
  const idx = teams.findIndex((t) => t.id === currentId);
  if (idx === -1) return teams[0].id;
  return teams[(idx + 1) % teams.length].id;
}

/** Record a question result (correct, wrong, or skipped), mark question asked when appropriate, and update logs/scores. */
export function recordQuestionOutcome(state, { question, teamId = null, isCorrect = false, isSkip = false }) {
  if (!question) return state;

  if (isSkip) {
    const askedIds = state.askedIds.includes(question.id)
      ? state.askedIds
      : [...state.askedIds, question.id];
    return {
      ...state,
      askedIds,
      currentQuestionId: null,
      logs: appendLog(state.logs, {
        type: 'skip',
        teamId: null,
        teamName: 'Host',
        category: question.category,
        questionId: question.id,
        questionText: `Skipped: ${question.question}`,
        delta: 0,
        newScore: null
      })
    };
  }

  const team = state.teams.find((t) => t.id === teamId);
  const pts = getQuestionPoints(question, state.settings);
  let delta = 0;
  if (team) {
    if (isCorrect) {
      delta = pts;
    } else if (state.settings.wrongPenalty) {
      delta = -pts;
    }
  }

  const teams = team
    ? state.teams.map((t) => (t.id === team.id ? { ...t, score: t.score + delta } : t))
    : state.teams;
  const updatedTeam = team ? teams.find((t) => t.id === team.id) : null;

  // Mark asked when answered correctly (or if there are no teams / host dismisses).
  // On a wrong answer with teams present, keep the card open unless caller clears it,
  // or still allow steals; marking asked on correct keeps wrong questions stealable.
  const askedIds =
    isCorrect && !state.askedIds.includes(question.id)
      ? [...state.askedIds, question.id]
      : state.askedIds;

  const nextActiveTeamId =
    isCorrect && state.settings.autoRotateTeam && teams.length > 0
      ? getNextTeamId(teams, team ? team.id : state.activeTeamId)
      : state.activeTeamId;

  return {
    ...state,
    teams,
    askedIds,
    currentQuestionId: isCorrect ? null : state.currentQuestionId,
    activeTeamId: nextActiveTeamId,
    logs: appendLog(state.logs, {
      type: isCorrect ? 'correct' : 'wrong',
      teamId: updatedTeam?.id ?? null,
      teamName: updatedTeam?.name ?? 'Unassigned',
      category: question.category,
      questionId: question.id,
      questionText: question.question,
      delta,
      newScore: updatedTeam ? updatedTeam.score : null
    })
  };
}

/** Add a custom admin question persisted in browser state. */
export function addCustomQuestion(state, payload) {
  const cleanQuestion = String(payload.question || '').trim();
  const choices = Array.isArray(payload.choices)
    ? payload.choices.map((c) => String(c || '').trim())
    : [];
  const answerIndex = Number(payload.answerIndex);
  const difficulty = ['easy', 'medium', 'hard'].includes(payload.difficulty)
    ? payload.difficulty
    : 'medium';
  const pointsMap = { easy: 100, medium: 200, hard: 300 };

  if (!cleanQuestion) return { state, error: 'Question prompt is required.' };
  if (choices.length !== 4 || choices.some((c) => !c)) {
    return { state, error: 'All 4 answer choices are required.' };
  }
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
    return { state, error: 'Select the correct answer option (A–D).' };
  }

  const newQ = {
    id: makeId('custom'),
    category: payload.category || 'history',
    difficulty,
    points: pointsMap[difficulty],
    question: cleanQuestion,
    choices,
    answerIndex,
    explanation: String(payload.explanation || '').trim() || 'Custom Iron Valor trivia question.',
    custom: true
  };

  return {
    state: {
      ...state,
      customQuestions: [newQ, ...state.customQuestions],
      logs: appendLog(state.logs, {
        type: 'system',
        teamId: null,
        teamName: 'Admin',
        category: newQ.category,
        questionId: newQ.id,
        questionText: `Added custom question: ${newQ.question}`,
        delta: 0,
        newScore: null
      })
    },
    question: newQ
  };
}

/** Remove a custom question by ID. */
export function deleteCustomQuestion(state, questionId) {
  const target = state.customQuestions.find((q) => q.id === questionId);
  if (!target) return state;
  return {
    ...state,
    customQuestions: state.customQuestions.filter((q) => q.id !== questionId),
    askedIds: state.askedIds.filter((id) => id !== questionId),
    currentQuestionId: state.currentQuestionId === questionId ? null : state.currentQuestionId,
    logs: appendLog(state.logs, {
      type: 'system',
      teamId: null,
      teamName: 'Admin',
      category: target.category,
      questionId: target.id,
      questionText: `Deleted custom question: ${target.question}`,
      delta: 0,
      newScore: null
    })
  };
}

/** Reset the asked-question deck while preserving teams, scores, and logs. */
export function resetDeck(state) {
  return {
    ...state,
    askedIds: [],
    currentQuestionId: null,
    logs: appendLog(state.logs, {
      type: 'system',
      teamId: null,
      teamName: 'Admin',
      category: null,
      questionId: null,
      questionText: 'Reset question deck (all questions available again).',
      delta: 0,
      newScore: null
    })
  };
}

/** Reset all team scores to zero while preserving teams and question history. */
export function resetScores(state) {
  return {
    ...state,
    teams: state.teams.map((t) => ({ ...t, score: 0 })),
    logs: appendLog(state.logs, {
      type: 'system',
      teamId: null,
      teamName: 'Admin',
      category: null,
      questionId: null,
      questionText: 'Reset all team scores to 0.',
      delta: 0,
      newScore: null
    })
  };
}

/** Clear all logs and insert a single audit marker. */
export function clearLogs(state) {
  return {
    ...state,
    logs: [
      {
        id: makeId('log'),
        timestamp: new Date().toISOString(),
        type: 'system',
        teamId: null,
        teamName: 'Admin',
        category: null,
        questionId: null,
        questionText: 'Activity log cleared by admin.',
        delta: 0,
        newScore: null
      }
    ]
  };
}

/** Export state as formatted JSON string. */
export function exportBackup(state) {
  return JSON.stringify(state, null, 2);
}

/** Parse and sanitize an imported JSON backup string. */
export function importBackup(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.teams)) {
    throw new Error('Invalid backup format.');
  }
  return sanitizeState(parsed);
}

/** Convert logs to RFC-4180 CSV text for download/review. */
export function logsToCsv(logs) {
  const escape = (val) => {
    const str = val == null ? '' : String(val);
    return `"${str.replaceAll('"', '""')}"`;
  };
  const header = ['Timestamp', 'Type', 'Team', 'Category', 'QuestionId', 'Details', 'Delta', 'NewScore'];
  const rows = logs.map((entry) => [
    entry.timestamp,
    entry.type,
    entry.teamName,
    entry.category || '',
    entry.questionId || '',
    entry.questionText,
    entry.delta ?? 0,
    entry.newScore ?? ''
  ]);
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
}
