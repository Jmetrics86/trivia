import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STORAGE_KEY,
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
  importBackup,
  isValidQuestion,
  loadState,
  logsToCsv,
  pullRandomQuestion,
  recordQuestionOutcome,
  renameTeam,
  resetDeck,
  resetScores,
  saveState,
  setActiveTeam
} from '../src/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

test('questions.json has 4 categories and 60 valid questions (15 each)', async () => {
  const raw = await fs.readFile(path.join(rootDir, 'data/questions.json'), 'utf8');
  const data = JSON.parse(raw);

  assert.equal(data.categories.length, 4);
  assert.deepEqual(
    data.categories.map((c) => c.id),
    ['history', 'anatomy', 'music', 'food']
  );

  assert.equal(data.questions.length, 60);

  const ids = new Set();
  const counts = { history: 0, anatomy: 0, music: 0, food: 0 };
  for (const q of data.questions) {
    assert.equal(isValidQuestion(q), true, `Invalid question: ${q.id}`);
    assert.equal(ids.has(q.id), false, `Duplicate ID: ${q.id}`);
    ids.add(q.id);
    counts[q.category] += 1;
    assert.ok([100, 200, 300].includes(q.points), `Unexpected points on ${q.id}`);
  }

  assert.deepEqual(counts, { history: 15, anatomy: 15, music: 15, food: 15 });
});

test('browser storage load/save persists state cleanly', () => {
  const storage = createMemoryStorage();
  const initial = loadState(storage);
  assert.equal(initial.teams.length, 2);

  const { state: updated } = addTeam(initial, '6AM Crew', '#518D9E');
  assert.equal(saveState(updated, storage), true);
  assert.ok(storage.getItem(STORAGE_KEY));

  const reloaded = loadState(storage);
  assert.equal(reloaded.teams.length, 3);
  assert.equal(reloaded.teams[2].name, '6AM Crew');
});

test('team lifecycle: add, duplicate guard, rename, setActive, delete', () => {
  let state = createInitialState();

  const emptyRes = addTeam(state, '   ');
  assert.ok(emptyRes.error);

  const dupRes = addTeam(state, 'team valor');
  assert.ok(dupRes.error);

  const added = addTeam(state, 'Evening Barbell', '#2F6F5E');
  assert.equal(added.error, undefined);
  state = added.state;
  assert.equal(state.teams.length, 3);

  const teamId = added.team.id;
  const renamed = renameTeam(state, teamId, 'Night Crew');
  assert.equal(renamed.error, undefined);
  state = renamed.state;
  assert.equal(state.teams.find((t) => t.id === teamId).name, 'Night Crew');

  state = setActiveTeam(state, teamId);
  assert.equal(state.activeTeamId, teamId);

  state = deleteTeam(state, teamId);
  assert.equal(state.teams.length, 2);
  assert.notEqual(state.activeTeamId, teamId);
});

test('pullRandomQuestion filters by category/difficulty and avoids asked questions', async () => {
  const raw = await fs.readFile(path.join(rootDir, 'data/questions.json'), 'utf8');
  const { questions } = JSON.parse(raw);
  let state = createInitialState();

  const pick1 = pullRandomQuestion(questions, state, {
    category: 'music',
    difficulty: 'hard',
    rng: () => 0
  });
  assert.ok(pick1.question);
  assert.equal(pick1.question.category, 'music');
  assert.equal(pick1.question.difficulty, 'hard');

  // Exhaust all hard music questions
  const hardMusic = questions.filter((q) => q.category === 'music' && q.difficulty === 'hard');
  state = { ...state, askedIds: hardMusic.map((q) => q.id) };

  const exhausted = pullRandomQuestion(questions, state, {
    category: 'music',
    difficulty: 'hard'
  });
  assert.equal(exhausted.question, null);
  assert.equal(exhausted.remainingInFilter, 0);

  state = resetDeck(state);
  assert.equal(getAvailableQuestions(questions, state, { category: 'music' }).length, 15);
});

test('recordQuestionOutcome handles correct, wrong (with/without penalty), and skip', async () => {
  const raw = await fs.readFile(path.join(rootDir, 'data/questions.json'), 'utf8');
  const { questions } = JSON.parse(raw);
  const q = questions.find((item) => item.points === 200);
  let state = createInitialState();
  const [team1, team2] = state.teams;

  // Wrong without penalty: score stays 0, question stays unasked for steal
  state = recordQuestionOutcome(state, { question: q, teamId: team1.id, isCorrect: false });
  assert.equal(state.teams[0].score, 0);
  assert.equal(state.askedIds.includes(q.id), false);

  // Wrong with penalty enabled
  state = { ...state, settings: { ...state.settings, wrongPenalty: true } };
  state = recordQuestionOutcome(state, { question: q, teamId: team1.id, isCorrect: false });
  assert.equal(state.teams[0].score, -200);

  // Team 2 steals correctly: +200, marks asked, rotates activeTeamId
  state = recordQuestionOutcome(state, { question: q, teamId: team2.id, isCorrect: true });
  assert.equal(state.teams[1].score, 200);
  assert.equal(state.askedIds.includes(q.id), true);
  assert.equal(state.activeTeamId, team1.id);

  // Skip marks asked without changing score
  const q2 = questions.find((item) => item.id !== q.id);
  state = recordQuestionOutcome(state, { question: q2, isSkip: true });
  assert.equal(state.askedIds.includes(q2.id), true);
  assert.equal(state.logs[0].type, 'skip');
});

test('manual score edits, custom questions, backup import/export, and CSV logs work', async () => {
  const raw = await fs.readFile(path.join(rootDir, 'data/questions.json'), 'utf8');
  const { questions } = JSON.parse(raw);
  let state = createInitialState();

  state = adjustTeamScore(state, state.teams[0].id, 150, 'Bonus burpee challenge');
  assert.equal(state.teams[0].score, 150);
  assert.equal(state.logs[0].type, 'manual');

  const cqRes = addCustomQuestion(state, {
    category: 'history',
    difficulty: 'easy',
    question: 'What street is Iron Valor CrossFit located on in Delray Beach?',
    choices: ['NE 4th Street', 'SE 2nd Avenue', 'SW 10th Street', 'NW 8th Avenue'],
    answerIndex: 0,
    explanation: 'Iron Valor CrossFit is at 360 NE 4th St in downtown Delray Beach.'
  });
  assert.equal(cqRes.error, undefined);
  state = cqRes.state;
  assert.equal(getAllQuestions(questions, state).length, 61);

  const jsonBackup = exportBackup(state);
  const restored = importBackup(jsonBackup);
  assert.equal(restored.teams[0].score, 150);
  assert.equal(restored.customQuestions.length, 1);

  const csv = logsToCsv(restored.logs);
  assert.match(csv, /Bonus burpee challenge/);

  state = deleteCustomQuestion(state, cqRes.question.id);
  assert.equal(state.customQuestions.length, 0);

  state = resetScores(state);
  assert.equal(state.teams[0].score, 0);

  state = clearLogs(state);
  assert.equal(state.logs.length, 1);
});
