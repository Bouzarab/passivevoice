function hydrateStudentLink() {
  const origin = window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : '';
  const link = `${origin}/student`;
  const linkEl = document.getElementById('student-link');
  const copyBtn = document.getElementById('copy-link-btn');

  if (linkEl) linkEl.textContent = link;
  if (!copyBtn || copyBtn.dataset.bound === 'true') return;

  copyBtn.dataset.bound = 'true';
  copyBtn.addEventListener('click', () => {
    const copiedText = linkEl?.textContent || link;
    navigator.clipboard.writeText(copiedText).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 2000);
    });
  });
}

hydrateStudentLink();

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let currentTimeLimit = 40;
let latestState = null;
let showAnswerNames = false;
const MAX_SCORE = 5;

// ─── Screen management ────────────────────────────────────────────────────────
const screens = {
  lobby:       document.getElementById('screen-lobby'),
  question:    document.getElementById('screen-question'),
  results:     document.getElementById('screen-results'),
  leaderboard: document.getElementById('screen-leaderboard'),
  finished:    document.getElementById('screen-finished')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  (screens[name] || screens.lobby).classList.add('active');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatScore(raw) {
  const n = Math.round((Number(raw) || 0) * 100) / 100;
  return n.toFixed(2);
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

function makeEmpty(msg) {
  const p = document.createElement('p');
  p.className = 'muted';
  p.style.cssText = 'padding:10px 0;font-size:0.88rem;';
  p.textContent = msg;
  return p;
}

function formatStudentLabel(player) {
  const detail = [player.studentClass, player.number ? `#${player.number}` : ''].filter(Boolean).join(' · ');
  return detail ? `${player.name} (${detail})` : player.name;
}

// ─── Render player lists ──────────────────────────────────────────────────────
function renderPlayerList(containerId, players, mode) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const rows = Object.values(players)
    .filter(p => mode === 'active' ? p.status === 'active' : p.status !== 'active')
    .sort((a, b) => {
      if (mode === 'active') return (a.studentClass || '').localeCompare(b.studentClass || '') || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });

  if (!rows.length) {
    container.appendChild(makeEmpty(mode === 'active' ? 'No students yet.' : 'No removals.'));
    return;
  }

  rows.forEach(player => {
    const row = document.createElement('div');
    row.className = `student-row${player.status !== 'active' ? ' removed' : ''}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(player.name);

    const nameWrap = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'student-name';
    nameEl.textContent = player.name;
    const meta = document.createElement('span');
    meta.className = 'student-meta';
    const classNum = [player.studentClass, player.number ? `#${player.number}` : ''].filter(Boolean).join(' · ');
    const scoreStr = `${formatScore(player.score)} / ${MAX_SCORE}`;
    const progressStr = player.quizStatus === 'finished'
      ? `Finished · ${player.correctCount || 0}/${player.totalQuestions || 10} correct`
      : `Question ${player.currentQuestionNumber || 1}/${player.totalQuestions || 10} · ${scoreStr}`;
    const activeStatus = player.connectionStatus === 'reconnecting' ? 'Reconnecting...' : progressStr;
    meta.textContent = player.status === 'active'
      ? `${classNum} · ${activeStatus}`
      : `${classNum} · ${scoreStr} — ${player.status === 'allowed_back' ? 'can rejoin' : (player.removalReason || 'removed')}`;
    nameWrap.append(nameEl, meta);

    const action = document.createElement('button');
    if (player.status === 'active') {
      action.className = 'btn danger';
      action.style.cssText = 'min-height:34px;padding:4px 10px;font-size:0.8rem;';
      action.textContent = 'Remove';
      action.addEventListener('click', () => {
        if (window.confirm(`Remove "${player.name}" from the quiz?`)) {
          socket.emit('teacher:kickPlayer', { playerId: player.id });
        }
      });
    } else if (player.status === 'allowed_back') {
      action.className = 'status-pill allowed';
      action.style.cursor = 'default';
      action.textContent = 'Can rejoin';
    } else {
      action.className = 'btn ghost';
      action.style.cssText = 'min-height:34px;padding:4px 10px;font-size:0.8rem;';
      action.textContent = 'Let back';
      action.addEventListener('click', () => {
        socket.emit('teacher:restorePlayer', { playerId: player.id });
      });
    }

    row.append(avatar, nameWrap, action);
    container.appendChild(row);
  });
}

// ─── Leaderboard render ───────────────────────────────────────────────────────
function renderLeaderboard(containerId, leaderboard) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!leaderboard || !leaderboard.length) {
    container.appendChild(makeEmpty('No scores yet.'));
    return;
  }

  leaderboard.forEach((player, index) => {
    const row = document.createElement('div');
    row.className = `leaderboard-row${player.status !== 'active' ? ' removed' : ''}`;

    const rankEl = document.createElement('div');
    rankEl.className = `avatar rank rank-${index + 1}`;
    rankEl.textContent = String(index + 1);

    const nameWrap = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'leader-name';
    nameEl.textContent = player.name;
    const detail = document.createElement('span');
    detail.className = 'small-text';
    const classMeta = [player.studentClass, player.number ? `#${player.number}` : ''].filter(Boolean).join(' · ');
    const progressMeta = player.quizStatus === 'finished'
      ? `Finished · ${player.correctCount || 0}/${player.totalQuestions || 10} correct`
      : `Question ${player.currentQuestionNumber || 1}/${player.totalQuestions || 10}`;
    detail.textContent = player.status === 'active'
      ? [classMeta, progressMeta].filter(Boolean).join(' · ') || 'Active'
      : `${classMeta ? classMeta + ' · ' : ''}${player.removalReason || 'Removed'}`;
    nameWrap.append(nameEl, detail);

    const scoreEl = document.createElement('span');
    scoreEl.className = player.status === 'active' ? 'score-pill' : 'status-pill removed';
    scoreEl.textContent = `${formatScore(player.score)} / ${MAX_SCORE}`;

    row.append(rankEl, nameWrap, scoreEl);
    container.appendChild(row);
  });
}

function renderAnswerNameGroup(containerId, students, emptyText) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (!students.length) {
    const empty = document.createElement('span');
    empty.className = 'answer-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  students.forEach(player => {
    const chip = document.createElement('span');
    chip.className = 'answer-chip';
    chip.textContent = formatStudentLabel(player);
    container.appendChild(chip);
  });
}

function renderAnswerNameLists(players) {
  const wrapper = document.getElementById('answer-name-lists');
  if (!wrapper) return;

  wrapper.classList.toggle('hidden', !showAnswerNames);
  if (!showAnswerNames) return;

  const activeStudents = Object.values(players)
    .filter(p => p.status === 'active')
    .sort((a, b) => (a.studentClass || '').localeCompare(b.studentClass || '') || a.name.localeCompare(b.name));
  const answered = activeStudents.filter(p => p.quizStatus === 'finished');
  const unanswered = activeStudents.filter(p => p.quizStatus !== 'finished');

  renderAnswerNameGroup('answered-student-list', answered, 'No answers yet.');
  renderAnswerNameGroup('unanswered-student-list', unanswered, 'Everyone answered.');
}

// ─── Question render ──────────────────────────────────────────────────────────
function renderQuestion(question) {
  if (!question) return;
  currentTimeLimit = question.timeLimit;

  // Hide "Next question" on the last question — there is no next
  const moveNextBtn = document.getElementById('move-next-btn');
  const movePrevBtn = document.getElementById('move-prev-btn');
  const resultsNextBtn = document.getElementById('results-next-btn');
  const resultsPrevBtn = document.getElementById('results-prev-btn');
  const leaderboardNextBtn = document.getElementById('leaderboard-next-btn');
  const leaderboardPrevBtn = document.getElementById('leaderboard-prev-btn');
  const isLast = question.number >= question.total;
  const isFirst = question.number <= 1;
  [moveNextBtn, resultsNextBtn, leaderboardNextBtn].forEach(btn => {
    if (btn) btn.style.display = isLast ? 'none' : '';
  });
  [movePrevBtn, resultsPrevBtn, leaderboardPrevBtn].forEach(btn => {
    if (btn) btn.style.display = isFirst ? 'none' : '';
  });

  setText('question-number', `Q${question.number} / ${question.total}`);
  setText('question-section', question.section);
  setText('question-prompt', question.prompt);

  const passage = document.getElementById('question-passage');
  if (question.passage) {
    passage.textContent = question.passage;
    passage.classList.remove('hidden');
  } else {
    passage.classList.add('hidden');
    passage.textContent = '';
  }

  const imageFrame = document.getElementById('question-image-frame');
  const image = document.getElementById('question-image');
  if (question.image) {
    image.src = question.image;
    image.alt = question.imageAlt || '';
    imageFrame.classList.remove('hidden');
  } else {
    image.removeAttribute('src');
    imageFrame.classList.add('hidden');
  }

  const optionsEl = document.getElementById('question-options');
  optionsEl.innerHTML = '';
  question.options.forEach((optionText, index) => {
    const row = document.createElement('div');
    // Highlight correct answer (correctIndex is included for teacher)
    const isCorrect = question.correctIndex !== undefined && index === question.correctIndex;
    row.className = `option${isCorrect ? ' correct' : ''}`;

    const letter = document.createElement('span');
    letter.className = 'option-letter';
    letter.textContent = String.fromCharCode(65 + index);

    const label = document.createElement('span');
    label.textContent = optionText + (isCorrect ? ' ✓' : '');

    row.append(letter, label);
    optionsEl.appendChild(row);
  });

  updateTimer(question.timeLimit);
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function updateTimer(seconds) {
  const timerNumber = document.getElementById('timer-number');
  const timerFill   = document.getElementById('timer-fill');
  const safe = Math.max(0, Number(seconds) || 0);
  const pct  = currentTimeLimit ? (safe / currentTimeLimit) * 100 : 0;

  timerNumber.textContent = formatTime(safe);
  timerFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;

  timerNumber.className = 'timer-number';
  timerFill.className   = 'timer-fill';

  if (safe <= 5) {
    timerNumber.classList.add('danger');
    timerFill.classList.add('danger');
  } else if (safe <= 10) {
    timerNumber.classList.add('warning');
    timerFill.classList.add('warning');
  }
}

// ─── Update answer progress ───────────────────────────────────────────────────
function updateAnswerProgress(count, total) {
  setText('answer-count', count);
  setText('answer-total', total);
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  setText('answer-pct', `${pct}%`);
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = `${pct}%`;
}

// ─── Apply full teacher state ─────────────────────────────────────────────────
function applyTeacherState(state) {
  latestState = state;
  const players = state.players || {};
  const allPlayers = Object.values(players);
  const activeCount   = allPlayers.filter(p => p.status === 'active').length;
  const removedCount  = allPlayers.filter(p => p.status !== 'active').length;

  setText('active-count', activeCount);
  setText('removed-count', removedCount);

  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    startBtn.disabled = true;
    if (state.windowStatus?.state === 'open') startBtn.textContent = 'Quiz Open';
    else if (state.windowStatus?.state === 'closed') startBtn.textContent = 'Window Closed';
    else startBtn.textContent = 'Not Open Yet';
  }

  renderPlayerList('lobby-student-list', players, 'active');
  renderPlayerList('lobby-removed-list', players, 'removed');
  renderPlayerList('question-student-list', players, 'active');
  renderPlayerList('question-removed-list', players, 'removed');
  renderLeaderboard('leaderboard-list', state.leaderboard || []);
  renderLeaderboard('results-leaderboard', state.leaderboard || []);
  renderLeaderboard('final-leaderboard', state.leaderboard || []);
  renderLeaderboard('teacher-dashboard-ranking', state.leaderboard || []);
  renderAnswerNameLists(players);

  updateAnswerProgress(state.answerCount || 0, activeCount);

  if (state.currentQuestion) {
    renderQuestion(state.currentQuestion);
    updateTimer(state.timeRemaining || 0);
  }

  if (state.phase === 'lobby')       showScreen('lobby');
  if (state.phase === 'question')    showScreen('question');
  if (state.phase === 'results')     showScreen('results');
  if (state.phase === 'leaderboard') showScreen('leaderboard');
  if (state.phase === 'finished')    showScreen('finished');
}

// ─── Socket setup ─────────────────────────────────────────────────────────────
socket.emit('teacher:join');

socket.on('teacher:state', applyTeacherState);

socket.on('game:question', (question) => {
  renderQuestion(question);
  updateAnswerProgress(latestState?.answerCount || 0, latestState?.activeCount || 0);
  showScreen('question');
});

socket.on('game:timer', ({ timeRemaining }) => {
  updateTimer(timeRemaining);
});

socket.on('game:answerCount', ({ count, total }) => {
  updateAnswerProgress(count, total);
});

socket.on('game:results', (data) => {
  const wrongCount = Math.max(data.stats.totalAnswered - data.stats.correctCount, 0);
  setText('correct-count', data.stats.correctCount);
  setText('wrong-count', wrongCount);
  setText('no-answer-count', data.stats.noAnswerCount);

  const strip = document.getElementById('correct-answer-strip');
  strip.className = 'result-strip correct';
  strip.textContent = data.correctAnswer || 'Students had randomized questions.';

  renderLeaderboard('results-leaderboard', data.leaderboard || []);
  showScreen('results');
});

socket.on('game:leaderboard', ({ leaderboard }) => {
  renderLeaderboard('leaderboard-list', leaderboard || []);
  showScreen('leaderboard');
});

socket.on('game:finished', ({ leaderboard }) => {
  renderLeaderboard('final-leaderboard', leaderboard || []);
  renderLeaderboard('teacher-dashboard-ranking', leaderboard || []);
  showScreen('finished');
});

socket.on('game:rankings', ({ leaderboard }) => {
  renderLeaderboard('teacher-dashboard-ranking', leaderboard || []);
});

socket.on('teacher:notice', ({ message }) => {
  window.alert(message || 'Please check the quiz settings.');
});

socket.on('game:reset', () => {
  showScreen('lobby');
});

// ─── Button bindings ──────────────────────────────────────────────────────────
document.getElementById('start-btn').addEventListener('click', () => {
  socket.emit('teacher:start');
});

document.getElementById('answer-names-toggle').addEventListener('change', (event) => {
  showAnswerNames = event.target.checked;
  renderAnswerNameLists(latestState?.players || {});
});

document.getElementById('restart-btn').addEventListener('click', () => {
  if (window.confirm('Reset the lobby? This clears all scores and removes all students.')) {
    socket.emit('teacher:restart');
  }
});

document.getElementById('final-restart-btn').addEventListener('click', () => {
  if (window.confirm('Start a new quiz session? This removes all students and clears all scores.')) {
    socket.emit('teacher:restart');
  }
});

document.getElementById('move-next-btn').addEventListener('click', () => {
  socket.emit('teacher:moveNext');
});

document.getElementById('move-prev-btn').addEventListener('click', () => {
  socket.emit('teacher:movePrevious');
});

// "Show results & end quiz" — ends the entire quiz and shows all final scores
document.getElementById('show-results-btn').addEventListener('click', () => {
  if (window.confirm('End the quiz now and show all students their final results?')) {
    socket.emit('teacher:showResults');
  }
});

document.getElementById('results-next-btn').addEventListener('click', () => {
  socket.emit('teacher:moveNext');
});

document.getElementById('results-prev-btn').addEventListener('click', () => {
  socket.emit('teacher:movePrevious');
});

document.getElementById('results-end-btn').addEventListener('click', () => {
  if (window.confirm('End the quiz now?')) socket.emit('teacher:endQuiz');
});

document.getElementById('leaderboard-btn').addEventListener('click', () => {
  socket.emit('teacher:showLeaderboard');
});

document.getElementById('leaderboard-next-btn').addEventListener('click', () => {
  socket.emit('teacher:moveNext');
});

document.getElementById('leaderboard-prev-btn').addEventListener('click', () => {
  socket.emit('teacher:movePrevious');
});

document.getElementById('leaderboard-end-btn').addEventListener('click', () => {
  if (window.confirm('End the quiz now?')) socket.emit('teacher:endQuiz');
});

document.getElementById('end-quiz-btn').addEventListener('click', () => {
  if (latestState?.phase === 'finished') return;
  if (window.confirm('End the quiz now and show final scores to all students?')) {
    socket.emit('teacher:endQuiz');
  }
});
