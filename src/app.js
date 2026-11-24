import {
  DIFFICULTY_LABELS,
  DIFFICULTY_POINTS,
  TEAM_COLORS,
  addCustomQuestion,
  addTeam,
  adjustTeamScore,
  clearLogs,
  createInitialState,
  deleteCustomQuestion,
  deleteTeam,
  exportBackup,
  getAllQuestions,
  getAvailableQuestions,
  getQuestionPoints,
  importBackup,
  loadState,
  logsToCsv,
  pullRandomQuestion,
  recordQuestionOutcome,
  renameTeam,
  resetDeck,
  resetScores,
  saveState,
  setActiveTeam
} from './state.js';

const CATEGORY_META = {
  history: { label: 'History', icon: '🏛️' },
  anatomy: { label: 'Anatomy & Gear', fullLabel: 'Anatomy & Equipment', icon: '🏋️' },
  music: { label: 'Music', icon: '🎵' },
  food: { label: 'Food', icon: '🥑' }
};

const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];

let baseCategories = [];
let baseQuestions = [];
let state = loadState();

const ui = {
  activeTab: 'play',
  selectedCategory: 'all',
  selectedDifficulty: 'all',
  filtersExpandedWhileActive: false,
  selectedTeamColor: TEAM_COLORS[0].hex,
  awardTargetTeamId: state.activeTeamId,
  missedTeamIds: [],
  revealed: false,
  choicesShown: state.settings.showChoicesByDefault,
  pickedChoiceIndex: null,
  lastPulledId: null,
  logTeamFilter: 'all',
  logTypeFilter: 'all',
  toastTimer: null,
  sheetResolve: null
};

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getCategoryLabel(catId, short = false) {
  const meta = CATEGORY_META[catId];
  if (!meta) return catId;
  return short ? meta.label : (meta.fullLabel || meta.label);
}

function getLeaderTeamId() {
  if (state.teams.length === 0) return null;
  const maxScore = Math.max(...state.teams.map((t) => t.score));
  if (maxScore <= 0) return null;
  const leaders = state.teams.filter((t) => t.score === maxScore);
  return leaders.length === 1 ? leaders[0].id : null;
}

function getTeamRankMap() {
  const sorted = [...state.teams].sort((a, b) => b.score - a.score);
  const rankMap = new Map();
  let currentRank = 1;
  sorted.forEach((team, idx) => {
    if (idx > 0 && team.score < sorted[idx - 1].score) {
      currentRank = idx + 1;
    }
    rankMap.set(team.id, currentRank);
  });
  return rankMap;
}

function commitState(nextState) {
  state = nextState;
  saveState(state);
  if (!state.teams.some((t) => t.id === ui.awardTargetTeamId)) {
    ui.awardTargetTeamId = state.activeTeamId ?? state.teams[0]?.id ?? null;
  }
  renderAll();
}

function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  if (ui.toastTimer) clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

/* ---------------- MOBILE BOTTOM SHEET MODAL ---------------- */

function openSheet({
  title,
  message = '',
  confirmText = 'Confirm',
  destructive = false,
  inputValue = null,
  inputPlaceholder = ''
}) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('sheet-backdrop');
    const titleEl = document.getElementById('sheet-title');
    const msgEl = document.getElementById('sheet-message');
    const inputWrap = document.getElementById('sheet-input-wrap');
    const inputEl = document.getElementById('sheet-input');
    const confirmBtn = document.getElementById('sheet-confirm');

    if (!backdrop || !titleEl || !msgEl || !inputWrap || !inputEl || !confirmBtn) {
      resolve(null);
      return;
    }

    ui.sheetResolve = resolve;
    titleEl.textContent = title;
    msgEl.textContent = message;
    msgEl.hidden = !message;
    confirmBtn.textContent = confirmText;
    confirmBtn.className = destructive ? 'btn btn-primary' : 'btn btn-secondary';

    const hasInput = inputValue !== null;
    inputWrap.hidden = !hasInput;
    if (hasInput) {
      inputEl.value = inputValue;
      inputEl.placeholder = inputPlaceholder;
    }

    backdrop.hidden = false;
    if (hasInput) {
      requestAnimationFrame(() => {
        inputEl.focus();
        inputEl.select();
      });
    } else {
      requestAnimationFrame(() => confirmBtn.focus());
    }
  });
}

function closeSheet(result) {
  const backdrop = document.getElementById('sheet-backdrop');
  if (backdrop) backdrop.hidden = true;
  if (ui.sheetResolve) {
    const fn = ui.sheetResolve;
    ui.sheetResolve = null;
    fn(result);
  }
}

function getCurrentQuestion() {
  if (!state.currentQuestionId) return null;
  return getAllQuestions(baseQuestions, state).find((q) => q.id === state.currentQuestionId) || null;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function pullNextQuestion() {
  const all = getAllQuestions(baseQuestions, state);
  const { question } = pullRandomQuestion(all, state, {
    category: ui.selectedCategory,
    difficulty: ui.selectedDifficulty
  });
  if (!question) {
    showToast('No unasked questions match this filter.');
    return;
  }
  ui.revealed = false;
  ui.pickedChoiceIndex = null;
  ui.missedTeamIds = [];
  ui.filtersExpandedWhileActive = false;
  ui.choicesShown = state.settings.showChoicesByDefault;
  ui.awardTargetTeamId = state.activeTeamId ?? state.teams[0]?.id ?? null;
  ui.lastPulledId = question.id;
  commitState({ ...state, currentQuestionId: question.id });
  const stage = document.getElementById('question-stage');
  stage?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------- RENDERING ---------------- */

function renderHeaderAndBadges() {
  const all = getAllQuestions(baseQuestions, state);
  const available = getAvailableQuestions(all, state);
  const pill = document.getElementById('deck-counter-pill');
  if (pill) {
    pill.textContent = `${available.length} / ${all.length} left`;
  }

  const teamsBadge = document.getElementById('nav-badge-teams');
  if (teamsBadge) {
    teamsBadge.textContent = String(state.teams.length);
    teamsBadge.hidden = state.teams.length === 0;
  }

  const logsBadge = document.getElementById('nav-badge-logs');
  if (logsBadge) {
    const actionableLogs = state.logs.filter((l) => l.type !== 'system').length;
    logsBadge.textContent = actionableLogs > 99 ? '99+' : String(actionableLogs);
    logsBadge.hidden = actionableLogs === 0;
  }
}

function renderScoreboardStrip() {
  const container = document.getElementById('play-scoreboard');
  if (!container) return;

  container.classList.remove('scoreboard-grid-1', 'scoreboard-grid-2', 'scoreboard-grid-compact');

  if (state.teams.length === 0) {
    container.classList.add('scoreboard-grid-1');
    container.innerHTML = `
      <div class="empty-teams-banner">
        <span>No teams yet. Add teams to keep score.</span>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-jump-teams">+ Add Team</button>
      </div>
    `;
    document.getElementById('btn-jump-teams')?.addEventListener('click', () => switchTab('teams'));
    return;
  }

  const count = state.teams.length;
  const isCompact = count >= 5;
  if (count === 1) container.classList.add('scoreboard-grid-1');
  else if (isCompact) container.classList.add('scoreboard-grid-compact');
  else container.classList.add('scoreboard-grid-2');

  const leaderId = getLeaderTeamId();

  container.innerHTML = state.teams
    .map((team) => {
      const isActive = team.id === state.activeTeamId;
      const isLeader = team.id === leaderId;
      if (isCompact) {
        return `
          <button
            type="button"
            class="score-pill ${isActive ? 'active' : ''}"
            data-select-team="${escapeHtml(team.id)}"
            aria-pressed="${isActive}"
          >
            <span class="score-pill-top">
              <span class="team-dot" style="background:${escapeHtml(team.color)}"></span>
              <span class="score-pill-name">${escapeHtml(team.name)}</span>
            </span>
            <span class="score-pill-bottom">
              <span class="score-pill-sub">
                ${isActive ? '<span class="score-pill-turn">Up</span>' : ''}
                ${isLeader ? '<span class="leader-tag">★</span>' : ''}
              </span>
              <span class="score-pill-val">${team.score}</span>
            </span>
          </button>
        `;
      }

      return `
        <button
          type="button"
          class="score-pill ${isActive ? 'active' : ''}"
          data-select-team="${escapeHtml(team.id)}"
          aria-pressed="${isActive}"
        >
          <span class="score-pill-left">
            <span class="team-dot" style="background:${escapeHtml(team.color)}"></span>
            <span class="score-pill-info">
              <span class="score-pill-name">${escapeHtml(team.name)}</span>
              <span class="score-pill-sub">
                ${isActive ? '<span class="score-pill-turn">Up Now</span>' : ''}
                ${isLeader ? '<span class="leader-tag">★ #1</span>' : ''}
              </span>
            </span>
          </span>
          <span class="score-pill-val">${team.score}</span>
        </button>
      `;
    })
    .join('');

  container.querySelectorAll('[data-select-team]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-select-team');
      ui.awardTargetTeamId = id;
      commitState(setActiveTeam(state, id));
    });
  });
}

function renderPlayControls() {
  const hasActiveQ = Boolean(getCurrentQuestion());
  const collapsedBar = document.getElementById('controls-collapsed-bar');
  const controlsBody = document.getElementById('controls-body');
  const collapseBtn = document.getElementById('btn-collapse-filters');
  const toggleBtn = document.getElementById('btn-toggle-filters');
  const summaryText = document.getElementById('filter-summary-text');

  const isCollapsed = hasActiveQ && !ui.filtersExpandedWhileActive;
  if (collapsedBar) collapsedBar.hidden = !isCollapsed;
  if (controlsBody) controlsBody.hidden = isCollapsed;
  if (collapseBtn) collapseBtn.hidden = !hasActiveQ;
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));

  if (summaryText) {
    const catLabel = ui.selectedCategory === 'all' ? 'All Categories' : getCategoryLabel(ui.selectedCategory, true);
    const diffLabel =
      ui.selectedDifficulty === 'all'
        ? 'Any Tier'
        : state.settings.scoringMode === 'flat'
          ? DIFFICULTY_LABELS[ui.selectedDifficulty]
          : `${DIFFICULTY_LABELS[ui.selectedDifficulty]} (${DIFFICULTY_POINTS[ui.selectedDifficulty]})`;
    summaryText.textContent = `${catLabel} • ${diffLabel}`;
  }

  renderDifficultyFilter();
  renderCategoryPicker();
}

function renderDifficultyFilter() {
  const container = document.getElementById('difficulty-filter');
  if (!container) return;
  const isFlat = state.settings.scoringMode === 'flat';
  const flatPts = state.settings.flatPoints;

  const items = [
    { id: 'all', label: 'Any', pts: isFlat ? `${flatPts} pts` : '100–300' },
    { id: 'easy', label: 'Easy', pts: isFlat ? `${flatPts} pts` : `${DIFFICULTY_POINTS.easy} pts` },
    { id: 'medium', label: 'Med', pts: isFlat ? `${flatPts} pts` : `${DIFFICULTY_POINTS.medium} pts` },
    { id: 'hard', label: 'Hard', pts: isFlat ? `${flatPts} pts` : `${DIFFICULTY_POINTS.hard} pts` }
  ];

  container.innerHTML = items
    .map((item) => {
      const active = ui.selectedDifficulty === item.id;
      return `
        <button
          type="button"
          class="diff-btn ${active ? 'active' : ''}"
          data-diff="${item.id}"
          aria-pressed="${active}"
        >
          <span class="diff-btn-label">${item.label}</span>
          <span class="diff-btn-pts">${item.pts}</span>
        </button>
      `;
    })
    .join('');

  container.querySelectorAll('[data-diff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.selectedDifficulty = btn.getAttribute('data-diff');
      renderPlayControls();
    });
  });
}

function renderCategoryPicker() {
  const container = document.getElementById('category-picker');
  if (!container) return;
  const all = getAllQuestions(baseQuestions, state);

  const allTotal = all.filter((q) => ui.selectedDifficulty === 'all' || q.difficulty === ui.selectedDifficulty).length;
  const allLeft = getAvailableQuestions(all, state, {
    category: 'all',
    difficulty: ui.selectedDifficulty
  }).length;

  const cards = [
    `
      <button
        type="button"
        class="cat-btn cat-all ${ui.selectedCategory === 'all' ? 'active' : ''}"
        data-cat="all"
      >
        <span class="cat-btn-top">
          <span class="cat-icon" aria-hidden="true">🎯</span>
          <span class="cat-btn-name">All Categories (Random Mix)</span>
        </span>
        <span class="cat-btn-count">${allLeft} / ${allTotal} left</span>
      </button>
    `
  ];

  for (const cat of baseCategories) {
    const total = all.filter(
      (q) => q.category === cat.id && (ui.selectedDifficulty === 'all' || q.difficulty === ui.selectedDifficulty)
    ).length;
    const left = getAvailableQuestions(all, state, {
      category: cat.id,
      difficulty: ui.selectedDifficulty
    }).length;
    const pct = total > 0 ? Math.round((left / total) * 100) : 0;
    const icon = CATEGORY_META[cat.id]?.icon || '❓';

    cards.push(`
      <button
        type="button"
        class="cat-btn ${ui.selectedCategory === cat.id ? 'active' : ''}"
        data-cat="${escapeHtml(cat.id)}"
      >
        <span class="cat-btn-top">
          <span class="cat-icon" aria-hidden="true">${icon}</span>
          <span class="cat-btn-name">${escapeHtml(getCategoryLabel(cat.id, true))}</span>
        </span>
        <span class="cat-btn-count">${left} / ${total} left</span>
        <span class="cat-progress" aria-hidden="true">
          <span class="cat-progress-fill" style="width:${pct}%"></span>
        </span>
      </button>
    `);
  }

  container.innerHTML = cards.join('');
  container.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.selectedCategory = btn.getAttribute('data-cat');
      renderPlayControls();
    });
  });

  updatePullButtonState();
}

function updatePullButtonState() {
  const all = getAllQuestions(baseQuestions, state);
  const avail = getAvailableQuestions(all, state, {
    category: ui.selectedCategory,
    difficulty: ui.selectedDifficulty
  });
  const disabled = avail.length === 0;
  const pullBtn = document.getElementById('btn-pull-random');
  const redrawBtn = document.getElementById('btn-redraw-compact');
  if (pullBtn) pullBtn.disabled = disabled;
  if (redrawBtn) redrawBtn.disabled = disabled;
}

function getNextStealTeamId(afterTeamId) {
  if (state.teams.length === 0) return null;
  const missedSet = new Set(ui.missedTeamIds);
  const startIdx = state.teams.findIndex((t) => t.id === afterTeamId);
  for (let offset = 1; offset <= state.teams.length; offset += 1) {
    const candidate = state.teams[(Math.max(startIdx, 0) + offset) % state.teams.length];
    if (!missedSet.has(candidate.id)) return candidate.id;
  }
  return state.teams[0].id;
}

function renderQuestionStage() {
  const stage = document.getElementById('question-stage');
  if (!stage) return;

  const q = getCurrentQuestion();
  const all = getAllQuestions(baseQuestions, state);
  const availInFilter = getAvailableQuestions(all, state, {
    category: ui.selectedCategory,
    difficulty: ui.selectedDifficulty
  });

  if (q && ui.lastPulledId === q.id) {
    stage.classList.remove('is-animated');
    void stage.offsetWidth;
    stage.classList.add('is-animated');
    ui.lastPulledId = null;
  } else {
    stage.classList.remove('is-animated');
  }

  if (!q) {
    if (availInFilter.length === 0) {
      stage.innerHTML = `
        <div class="question-empty">
          <div class="question-empty-icon" aria-hidden="true">🏁</div>
          <h3>No Unasked Questions Left</h3>
          <p>You've gone through every question matching this filter. Switch categories or reset the deck to keep playing.</p>
          <button type="button" class="btn btn-secondary" id="btn-inline-reset-deck">Reset Question Deck</button>
        </div>
      `;
      document.getElementById('btn-inline-reset-deck')?.addEventListener('click', () => {
        commitState(resetDeck(state));
        showToast('Question deck reset!');
      });
      return;
    }

    stage.innerHTML = `
      <div class="question-empty">
        <div class="question-empty-icon" aria-hidden="true">🏋️</div>
        <h3>Ready for the Next Round</h3>
        <p>Select a category &amp; difficulty above (or stay on <strong>All Categories</strong>) and tap <strong>Pull Random Trivia</strong>.</p>
      </div>
    `;
    return;
  }

  const pts = getQuestionPoints(q, state.settings);
  const catName = getCategoryLabel(q.category, false);
  const diffKey = Object.prototype.hasOwnProperty.call(DIFFICULTY_LABELS, q.difficulty)
    ? q.difficulty
    : 'medium';
  const diffLabel = DIFFICULTY_LABELS[diffKey];
  const ptsBadgeText =
    state.settings.scoringMode === 'flat'
      ? `${diffLabel} • ${pts} PTS (Flat)`
      : `${diffLabel} • ${pts} PTS`;

  const targetId = ui.awardTargetTeamId ?? state.activeTeamId ?? state.teams[0]?.id ?? null;
  const missedSet = new Set(ui.missedTeamIds);

  const choicesHtml = ui.choicesShown || ui.revealed
    ? `
      <div class="choices-list">
        ${q.choices
          .map((choice, idx) => {
            let cls = 'choice-btn';
            if (ui.revealed) {
              if (idx === q.answerIndex) cls += ' is-correct';
              else if (ui.pickedChoiceIndex === idx) cls += ' is-wrong';
              else cls += ' is-dimmed';
            } else if (ui.pickedChoiceIndex === idx) {
              cls += idx === q.answerIndex ? ' is-correct' : ' is-wrong';
            }
            const marker = ui.revealed && idx === q.answerIndex ? '✓' : CHOICE_LETTERS[idx];
            return `
              <button type="button" class="${cls}" data-choice="${idx}">
                <span class="choice-letter">${marker}</span>
                <span>${escapeHtml(choice)}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    `
    : `
      <div class="flashcard-cover">
        <button type="button" class="btn btn-ghost" id="btn-show-choices">Show Choices</button>
        <button type="button" class="btn btn-secondary" id="btn-reveal-answer">Reveal Answer</button>
      </div>
    `;

  const revealBarHtml = ui.choicesShown && !ui.revealed
    ? `<button type="button" class="btn btn-ghost btn-sm btn-full" id="btn-reveal-answer" style="margin-bottom:10px;">Reveal Answer</button>`
    : '';

  const explanationHtml = ui.revealed
    ? `
      <div class="explanation-box">
        <strong>✓ ${CHOICE_LETTERS[q.answerIndex]}: ${escapeHtml(q.choices[q.answerIndex])}</strong>
        ${escapeHtml(q.explanation || '')}
      </div>
    `
    : '';

  const teamChipsHtml = state.teams.length > 0
    ? `
      <div class="award-team-chips">
        ${state.teams
          .map((t) => {
            const selected = t.id === targetId;
            const missed = missedSet.has(t.id);
            return `
              <button
                type="button"
                class="team-chip ${selected ? 'selected' : ''} ${missed ? 'missed' : ''}"
                data-award-team="${escapeHtml(t.id)}"
              >
                <span class="team-dot" style="background:${escapeHtml(t.color)}"></span>
                <span>${escapeHtml(t.name)}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    `
    : '<div class="setting-help">No teams created — add teams in the Teams tab to keep score.</div>';

  const wrongLabel = state.settings.wrongPenalty ? `Wrong (-${pts})` : 'Wrong (0)';
  const stealBanner = ui.missedTeamIds.length > 0
    ? '<span class="steal-hint">Open for Steal!</span>'
    : '';

  stage.innerHTML = `
    <div class="q-meta-row">
      <div class="badge-group">
        <span class="badge badge-cat">${escapeHtml(catName)}</span>
        <span class="badge badge-${diffKey}">${escapeHtml(ptsBadgeText)}</span>
        ${q.custom ? '<span class="badge badge-custom">Custom</span>' : ''}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-skip-question">Skip</button>
    </div>

    <p class="q-prompt">${escapeHtml(q.question)}</p>

    ${choicesHtml}
    ${revealBarHtml}
    ${explanationHtml}

    <div class="award-panel">
      <div class="award-header">
        <span class="award-label">Score for Team</span>
        ${stealBanner}
      </div>
      ${teamChipsHtml}
      <div class="award-actions-row">
        <button type="button" class="btn btn-success" id="btn-mark-correct">
          ✓ Correct (+${pts})
        </button>
        <button type="button" class="btn btn-danger-outline" id="btn-mark-wrong">
          ✕ ${wrongLabel}
        </button>
      </div>
    </div>
  `;

  stage.querySelectorAll('[data-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-choice'));
      ui.pickedChoiceIndex = idx;
      ui.revealed = true;
      renderQuestionStage();
    });
  });

  document.getElementById('btn-show-choices')?.addEventListener('click', () => {
    ui.choicesShown = true;
    renderQuestionStage();
  });

  document.getElementById('btn-reveal-answer')?.addEventListener('click', () => {
    ui.choicesShown = true;
    ui.revealed = true;
    renderQuestionStage();
  });

  stage.querySelectorAll('[data-award-team]').forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.awardTargetTeamId = btn.getAttribute('data-award-team');
      renderQuestionStage();
    });
  });

  document.getElementById('btn-skip-question')?.addEventListener('click', () => {
    const next = recordQuestionOutcome(state, { question: q, isSkip: true });
    ui.revealed = false;
    ui.pickedChoiceIndex = null;
    ui.missedTeamIds = [];
    ui.filtersExpandedWhileActive = false;
    ui.choicesShown = next.settings.showChoicesByDefault;
    commitState(next);
    showToast('Question skipped & logged.');
  });

  document.getElementById('btn-mark-correct')?.addEventListener('click', () => {
    const team = state.teams.find((t) => t.id === targetId) || null;
    const next = recordQuestionOutcome(state, {
      question: q,
      teamId: team?.id ?? null,
      isCorrect: true
    });
    ui.revealed = false;
    ui.pickedChoiceIndex = null;
    ui.missedTeamIds = [];
    ui.filtersExpandedWhileActive = false;
    ui.choicesShown = next.settings.showChoicesByDefault;
    ui.awardTargetTeamId = next.activeTeamId;
    commitState(next);
    showToast(team ? `+${pts} pts to ${team.name}!` : 'Marked correct & logged.');
  });

  document.getElementById('btn-mark-wrong')?.addEventListener('click', () => {
    const team = state.teams.find((t) => t.id === targetId) || null;
    const next = recordQuestionOutcome(state, {
      question: q,
      teamId: team?.id ?? null,
      isCorrect: false
    });
    if (team && !ui.missedTeamIds.includes(team.id)) {
      ui.missedTeamIds = [...ui.missedTeamIds, team.id];
    }
    if (team && next.teams.length > 1) {
      ui.awardTargetTeamId = getNextStealTeamId(team.id);
    }
    commitState(next);
    if (team) {
      showToast(
        next.settings.wrongPenalty
          ? `-${pts} pts for ${team.name}. Open for steal!`
          : `Logged wrong for ${team.name}. Open for steal!`
      );
    } else {
      showToast('Logged wrong attempt.');
    }
  });
}

function renderColorPicker() {
  const row = document.getElementById('team-color-picker');
  if (!row) return;
  row.innerHTML = TEAM_COLORS.map((c) => {
    const selected = c.hex === ui.selectedTeamColor;
    return `
      <button
        type="button"
        class="color-swatch ${selected ? 'selected' : ''}"
        style="background:${c.hex}"
        aria-label="${c.label}"
        aria-checked="${selected}"
        role="radio"
        data-color="${c.hex}"
      ></button>
    `;
  }).join('');

  row.querySelectorAll('[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.selectedTeamColor = btn.getAttribute('data-color');
      renderColorPicker();
    });
  });
}

function renderTeamsTab() {
  renderColorPicker();
  const list = document.getElementById('teams-list');
  if (!list) return;

  if (state.teams.length === 0) {
    list.innerHTML = `
      <div class="card question-empty">
        <h3>No Teams Yet</h3>
        <p>Create your first team above (e.g., 6AM Crew, Barbell Club, Coaches).</p>
      </div>
    `;
    return;
  }

  const rankMap = getTeamRankMap();
  const leaderId = getLeaderTeamId();

  list.innerHTML = state.teams
    .map((team) => {
      const wins = state.logs.filter((l) => l.teamId === team.id && l.type === 'correct').length;
      const losses = state.logs.filter((l) => l.teamId === team.id && l.type === 'wrong').length;
      const isActive = team.id === state.activeTeamId;
      const isLeader = team.id === leaderId;
      const rank = rankMap.get(team.id) ?? 1;
      const initial = (team.name[0] || 'T').toUpperCase();

      return `
        <article class="card team-card" data-team-card="${escapeHtml(team.id)}">
          <div class="team-card-top">
            <div class="team-card-id">
              <div class="team-avatar" style="background:${escapeHtml(team.color)}">${escapeHtml(initial)}</div>
              <div>
                <div class="team-card-name">
                  <span>${escapeHtml(team.name)}</span>
                  <span class="rank-pill ${isLeader ? 'is-leader' : ''}">${isLeader ? '★ #1' : `#${rank}`}</span>
                  ${isActive ? '<span class="score-pill-turn">Up Now</span>' : ''}
                </div>
                <div class="team-card-meta">${wins} correct • ${losses} wrong</div>
              </div>
            </div>
            <div class="team-card-score">${team.score}</div>
          </div>

          <div class="delta-row">
            <button type="button" class="btn btn-ghost btn-sm" data-delta="-100">-100</button>
            <button type="button" class="btn btn-ghost btn-sm" data-delta="-50">-50</button>
            <button type="button" class="btn btn-ghost btn-sm" data-delta="50">+50</button>
            <button type="button" class="btn btn-ghost btn-sm" data-delta="100">+100</button>
          </div>

          <div class="custom-delta-row">
            <input
              type="number"
              inputmode="numeric"
              min="1"
              class="input"
              placeholder="Custom pts"
              aria-label="Custom points for ${escapeHtml(team.name)}"
              data-custom-delta
            />
            <button type="button" class="btn btn-danger-outline btn-sm" data-apply-sub>− Sub</button>
            <button type="button" class="btn btn-secondary btn-sm" data-apply-add>+ Add</button>
          </div>

          <div class="team-card-footer">
            <button type="button" class="btn btn-ghost btn-sm" data-set-active ${isActive ? 'disabled' : ''}>
              ${isActive ? 'Active Turn' : 'Set Active'}
            </button>
            <div class="btn-inline-group">
              <button type="button" class="btn btn-ghost btn-sm" data-rename-team>Rename</button>
              <button type="button" class="btn btn-danger-outline btn-sm" data-delete-team>Delete</button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  list.querySelectorAll('[data-team-card]').forEach((card) => {
    const teamId = card.getAttribute('data-team-card');
    const team = state.teams.find((t) => t.id === teamId);
    if (!team) return;

    card.querySelectorAll('[data-delta]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.getAttribute('data-delta'));
        commitState(adjustTeamScore(state, teamId, delta, `Quick adjustment (${delta > 0 ? '+' : ''}${delta})`));
        showToast(`${delta > 0 ? '+' : ''}${delta} pts to ${team.name}`);
      });
    });

    const applyCustom = (sign) => {
      const input = card.querySelector('[data-custom-delta]');
      const raw = Math.abs(Math.trunc(Number(input?.value)));
      if (!Number.isFinite(raw) || raw === 0) {
        showToast('Enter a point value greater than 0.');
        return;
      }
      const delta = sign * raw;
      commitState(adjustTeamScore(state, teamId, delta, `Admin custom score edit (${delta > 0 ? '+' : ''}${delta})`));
      showToast(`${delta > 0 ? '+' : ''}${delta} pts to ${team.name}`);
    };

    card.querySelector('[data-apply-add]')?.addEventListener('click', () => applyCustom(1));
    card.querySelector('[data-apply-sub]')?.addEventListener('click', () => applyCustom(-1));

    card.querySelector('[data-set-active]')?.addEventListener('click', () => {
      ui.awardTargetTeamId = teamId;
      commitState(setActiveTeam(state, teamId));
      showToast(`${team.name} is now up.`);
    });

    card.querySelector('[data-rename-team]')?.addEventListener('click', async () => {
      const nextName = await openSheet({
        title: 'Rename Team',
        message: `Enter a new name for "${team.name}".`,
        confirmText: 'Save Name',
        inputValue: team.name,
        inputPlaceholder: 'Team name'
      });
      if (nextName === null) return;
      const res = renameTeam(state, teamId, nextName);
      if (res.error) {
        showToast(res.error);
        return;
      }
      commitState(res.state);
      showToast('Team renamed.');
    });

    card.querySelector('[data-delete-team]')?.addEventListener('click', async () => {
      const confirmed = await openSheet({
        title: `Delete "${team.name}"?`,
        message: 'Their current score will be removed from the scoreboard, while historical log entries stay.',
        confirmText: 'Delete Team',
        destructive: true
      });
      if (!confirmed) return;
      commitState(deleteTeam(state, teamId));
      showToast(`Deleted ${team.name}.`);
    });
  });
}

function renderLogsTab() {
  const teamSelect = document.getElementById('log-filter-team');
  const typeSelect = document.getElementById('log-filter-type');
  const statsEl = document.getElementById('log-stats');
  const feedEl = document.getElementById('logs-feed');
  if (!teamSelect || !typeSelect || !statsEl || !feedEl) return;

  const teamOptions = new Map();
  for (const t of state.teams) teamOptions.set(t.id, t.name);
  for (const l of state.logs) {
    if (l.teamId && !teamOptions.has(l.teamId)) teamOptions.set(l.teamId, l.teamName || 'Former Team');
  }

  teamSelect.innerHTML = [
    '<option value="all">All Teams</option>',
    ...Array.from(teamOptions.entries()).map(
      ([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`
    )
  ].join('');
  teamSelect.value = teamOptions.has(ui.logTeamFilter) ? ui.logTeamFilter : 'all';
  typeSelect.value = ui.logTypeFilter;

  const filtered = state.logs.filter((entry) => {
    if (ui.logTeamFilter !== 'all' && entry.teamId !== ui.logTeamFilter) return false;
    if (ui.logTypeFilter !== 'all' && entry.type !== ui.logTypeFilter) return false;
    return true;
  });

  const correctCount = filtered.filter((l) => l.type === 'correct').length;
  const wrongCount = filtered.filter((l) => l.type === 'wrong').length;
  statsEl.textContent = `${filtered.length} entries shown • ${correctCount} correct • ${wrongCount} wrong`;

  if (filtered.length === 0) {
    feedEl.innerHTML = `
      <div class="card question-empty">
        <h3>No Matching Log Entries</h3>
        <p>Activity will appear here as you pull questions, score teams, or adjust points.</p>
      </div>
    `;
    return;
  }

  feedEl.innerHTML = filtered
    .map((entry) => {
      const deltaClass = entry.delta > 0 ? 'pos' : entry.delta < 0 ? 'neg' : 'zero';
      const deltaStr = entry.delta > 0 ? `+${entry.delta}` : `${entry.delta ?? 0}`;
      const catLabel = entry.category ? getCategoryLabel(entry.category, true) : entry.type;
      const scoreAfter = entry.newScore != null ? ` • Score: ${entry.newScore}` : '';
      return `
        <article class="log-item">
          <div class="log-item-top">
            <div class="badge-group">
              <span class="badge badge-cat">${escapeHtml(entry.teamName || 'System')}</span>
              <span class="badge badge-pts">${escapeHtml(catLabel)}</span>
            </div>
            <span class="log-delta ${deltaClass}">${deltaStr} pts</span>
          </div>
          <div class="log-desc">${escapeHtml(entry.questionText)}</div>
          <div class="log-time">${escapeHtml(formatTime(entry.timestamp))}${escapeHtml(scoreAfter)}</div>
        </article>
      `;
    })
    .join('');
}

function renderAdminTab() {
  const scoringMode = document.getElementById('setting-scoring-mode');
  const flatRow = document.getElementById('flat-points-row');
  const flatInput = document.getElementById('setting-flat-points');
  const penaltyToggle = document.getElementById('setting-wrong-penalty');
  const rotateToggle = document.getElementById('setting-auto-rotate');
  const showChoicesToggle = document.getElementById('setting-show-choices');

  if (scoringMode) scoringMode.value = state.settings.scoringMode;
  if (flatRow) flatRow.hidden = state.settings.scoringMode !== 'flat';
  if (flatInput) flatInput.value = String(state.settings.flatPoints);
  if (penaltyToggle) penaltyToggle.checked = state.settings.wrongPenalty;
  if (rotateToggle) rotateToggle.checked = state.settings.autoRotateTeam;
  if (showChoicesToggle) showChoicesToggle.checked = state.settings.showChoicesByDefault;

  const breakdown = document.getElementById('admin-deck-breakdown');
  if (breakdown) {
    const all = getAllQuestions(baseQuestions, state);
    breakdown.innerHTML = baseCategories
      .map((cat) => {
        const total = all.filter((q) => q.category === cat.id).length;
        const left = getAvailableQuestions(all, state, { category: cat.id }).length;
        return `
          <div class="deck-stat-box">
            <div class="deck-stat-name">${escapeHtml(getCategoryLabel(cat.id, true))}</div>
            <div class="deck-stat-val">${left} / ${total} left</div>
          </div>
        `;
      })
      .join('');
  }

  const customList = document.getElementById('custom-questions-list');
  if (customList) {
    if (state.customQuestions.length === 0) {
      customList.innerHTML = '<div class="setting-help">No custom questions added yet.</div>';
    } else {
      customList.innerHTML = state.customQuestions
        .map(
          (q) => `
            <div class="custom-q-item">
              <div>
                <strong>${escapeHtml(getCategoryLabel(q.category, true))} (${DIFFICULTY_LABELS[q.difficulty] || 'Med'} • ${DIFFICULTY_POINTS[q.difficulty] || q.points})</strong>
                <div>${escapeHtml(q.question)}</div>
              </div>
              <button type="button" class="btn btn-danger-outline btn-sm" data-del-cq="${escapeHtml(q.id)}">
                Delete
              </button>
            </div>
          `
        )
        .join('');

      customList.querySelectorAll('[data-del-cq]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-del-cq');
          commitState(deleteCustomQuestion(state, id));
          showToast('Deleted custom question.');
        });
      });
    }
  }
}

function renderAll() {
  renderHeaderAndBadges();
  renderScoreboardStrip();
  renderPlayControls();
  renderQuestionStage();
  renderTeamsTab();
  renderLogsTab();
  renderAdminTab();
}

/* ---------------- NAVIGATION & EVENTS ---------------- */

function switchTab(tabName) {
  ui.activeTab = tabName;
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const match = panel.id === `tab-${tabName}`;
    panel.hidden = !match;
    panel.classList.toggle('active', match);
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const match = btn.getAttribute('data-tab') === tabName;
    btn.classList.toggle('active', match);
    if (match) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function bindEvents() {
  // Bottom Nav
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  // Bottom Sheet Modal controls
  const backdrop = document.getElementById('sheet-backdrop');
  const sheetInput = document.getElementById('sheet-input');
  const sheetInputWrap = document.getElementById('sheet-input-wrap');

  document.getElementById('sheet-cancel')?.addEventListener('click', () => {
    closeSheet(sheetInputWrap?.hidden ? false : null);
  });

  document.getElementById('sheet-confirm')?.addEventListener('click', () => {
    closeSheet(sheetInputWrap?.hidden ? true : (sheetInput?.value ?? ''));
  });

  backdrop?.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeSheet(sheetInputWrap?.hidden ? false : null);
    }
  });

  sheetInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      closeSheet(sheetInput.value);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop && !backdrop.hidden) {
      closeSheet(sheetInputWrap?.hidden ? false : null);
    }
  });

  // Collapsible filter toggles & random pulls
  document.getElementById('btn-toggle-filters')?.addEventListener('click', () => {
    ui.filtersExpandedWhileActive = true;
    renderPlayControls();
  });

  document.getElementById('btn-collapse-filters')?.addEventListener('click', () => {
    ui.filtersExpandedWhileActive = false;
    renderPlayControls();
  });

  document.getElementById('btn-pull-random')?.addEventListener('click', pullNextQuestion);
  document.getElementById('btn-redraw-compact')?.addEventListener('click', pullNextQuestion);

  // Create Team
  document.getElementById('create-team-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('new-team-name');
    const res = addTeam(state, input.value, ui.selectedTeamColor);
    if (res.error) {
      showToast(res.error);
      return;
    }
    input.value = '';
    commitState(res.state);
    showToast(`Added "${res.team.name}"!`);
  });

  // Log Filters & Actions
  document.getElementById('log-filter-team')?.addEventListener('change', (e) => {
    ui.logTeamFilter = e.target.value;
    renderLogsTab();
  });

  document.getElementById('log-filter-type')?.addEventListener('change', (e) => {
    ui.logTypeFilter = e.target.value;
    renderLogsTab();
  });

  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    const csv = logsToCsv(state.logs);
    downloadFile('iron-valor-trivia-logs.csv', csv, 'text/csv;charset=utf-8');
    showToast('Logs exported as CSV.');
  });

  document.getElementById('btn-clear-logs')?.addEventListener('click', async () => {
    const confirmed = await openSheet({
      title: 'Clear Session Logs?',
      message: 'All log entries will be cleared. Team names and current scores will remain unchanged.',
      confirmText: 'Clear Logs',
      destructive: true
    });
    if (!confirmed) return;
    commitState(clearLogs(state));
    showToast('Logs cleared.');
  });

  // Admin Settings
  document.getElementById('setting-scoring-mode')?.addEventListener('change', (e) => {
    commitState({
      ...state,
      settings: { ...state.settings, scoringMode: e.target.value === 'flat' ? 'flat' : 'difficulty' }
    });
  });

  document.getElementById('setting-flat-points')?.addEventListener('change', (e) => {
    const val = Math.max(1, Math.min(10000, Math.trunc(Number(e.target.value) || 100)));
    commitState({ ...state, settings: { ...state.settings, flatPoints: val } });
  });

  document.getElementById('setting-wrong-penalty')?.addEventListener('change', (e) => {
    commitState({ ...state, settings: { ...state.settings, wrongPenalty: e.target.checked } });
  });

  document.getElementById('setting-auto-rotate')?.addEventListener('change', (e) => {
    commitState({ ...state, settings: { ...state.settings, autoRotateTeam: e.target.checked } });
  });

  document.getElementById('setting-show-choices')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    ui.choicesShown = checked;
    commitState({ ...state, settings: { ...state.settings, showChoicesByDefault: checked } });
  });

  // Admin Deck & Reset Buttons
  document.getElementById('btn-reset-deck')?.addEventListener('click', async () => {
    const confirmed = await openSheet({
      title: 'Reset Question Deck?',
      message: 'All questions will become available to pull again. Teams and scores will stay intact.',
      confirmText: 'Reset Deck'
    });
    if (!confirmed) return;
    ui.revealed = false;
    ui.pickedChoiceIndex = null;
    ui.missedTeamIds = [];
    commitState(resetDeck(state));
    showToast('Question deck reset!');
  });

  document.getElementById('btn-reset-scores')?.addEventListener('click', async () => {
    const confirmed = await openSheet({
      title: 'Zero All Scores?',
      message: 'Every team score will be set back to 0 and logged.',
      confirmText: 'Zero Scores',
      destructive: true
    });
    if (!confirmed) return;
    commitState(resetScores(state));
    showToast('All team scores set to 0.');
  });

  document.getElementById('btn-export-backup')?.addEventListener('click', () => {
    downloadFile('iron-valor-trivia-backup.json', exportBackup(state), 'application/json');
    showToast('Backup JSON downloaded.');
  });

  document.getElementById('input-import-backup')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const restored = importBackup(text);
      ui.revealed = false;
      ui.pickedChoiceIndex = null;
      ui.missedTeamIds = [];
      commitState(restored);
      showToast('Backup restored!');
    } catch {
      showToast('Invalid backup JSON file.');
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('btn-factory-reset')?.addEventListener('click', async () => {
    const confirmed = await openSheet({
      title: 'Factory Reset App?',
      message: 'This erases all teams, scores, logs, settings, and custom questions stored in this browser.',
      confirmText: 'Factory Reset',
      destructive: true
    });
    if (!confirmed) return;
    ui.revealed = false;
    ui.pickedChoiceIndex = null;
    ui.missedTeamIds = [];
    ui.filtersExpandedWhileActive = false;
    const fresh = createInitialState();
    ui.choicesShown = fresh.settings.showChoicesByDefault;
    ui.awardTargetTeamId = fresh.activeTeamId;
    commitState(fresh);
    showToast('Browser state reset to defaults.');
  });

  // Add Custom Question
  document.getElementById('custom-question-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const res = addCustomQuestion(state, {
      category: document.getElementById('cq-category').value,
      difficulty: document.getElementById('cq-difficulty').value,
      question: document.getElementById('cq-prompt').value,
      choices: [
        document.getElementById('cq-choice-0').value,
        document.getElementById('cq-choice-1').value,
        document.getElementById('cq-choice-2').value,
        document.getElementById('cq-choice-3').value
      ],
      answerIndex: Number(document.getElementById('cq-answer').value),
      explanation: document.getElementById('cq-explanation').value
    });

    if (res.error) {
      showToast(res.error);
      return;
    }

    e.target.reset();
    commitState(res.state);
    showToast('Custom question saved!');
  });
}

async function init() {
  bindEvents();
  try {
    const res = await fetch('./data/questions.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    baseCategories = Array.isArray(data.categories) ? data.categories : [];
    baseQuestions = Array.isArray(data.questions) ? data.questions : [];
    renderAll();
  } catch (err) {
    const stage = document.getElementById('question-stage');
    if (stage) {
      stage.innerHTML = `
        <div class="question-empty">
          <h3>Could Not Load Questions</h3>
          <p>Serve this app over HTTP (e.g. GitHub Pages or a local server). Error: ${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }
}

init();
