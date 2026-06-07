const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let currentQuestion = null;
let currentTimeLimit = 40;
let hasAnswered = false;
let studentName = '';
let studentNumber = '';
let studentClass = '';
let playerId = '';
let playerToken = '';
let myScore = 0;
let totalQuestions = 10;
let protectionArmed = false;
let violationSent = false;
let removed = false;
let translationClear = true;
let translationGateUpdating = false;
const MAX_SCORE = 5;

// ─── Screen management ────────────────────────────────────────────────────────
const screens = {
  join:        document.getElementById('screen-join'),
  waiting:     document.getElementById('screen-waiting'),
  question:    document.getElementById('screen-question'),
  result:      document.getElementById('screen-result'),
  leaderboard: document.getElementById('screen-leaderboard'),
  finished:    document.getElementById('screen-finished')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  (screens[name] || screens.join).classList.add('active');
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

function updateScore(score) {
  myScore = Math.round((Number(score) || 0) * 100) / 100;
  const display = `${formatScore(myScore)} / ${MAX_SCORE}`;
  setText('score-value', display);
  setText('result-score', display);
  setText('removed-score', `${formatScore(myScore)} / ${MAX_SCORE}`);
}

function resetStudentSession(clearForm = false) {
  currentQuestion = null;
  hasAnswered = false;
  studentName = '';
  studentNumber = '';
  studentClass = '';
  playerId = '';
  playerToken = '';
  protectionArmed = false;
  violationSent = false;
  removed = false;

  document.body.classList.remove('protected');
  document.getElementById('removed-overlay').classList.remove('active');
  document.getElementById('answer-status').classList.add('hidden');
  if (clearForm) joinForm.reset();
  clearError();
  updateScore(0);
  setText('score-name', 'Student');
  setText('result-name', 'Student');
  showScreen('join');
}

function markAnswerSubmitted() {
  hasAnswered = true;
  document.querySelectorAll('#question-options .option').forEach((opt) => {
    opt.disabled = true;
    opt.blur();
    opt.classList.remove('selected', 'correct', 'incorrect');
  });
  document.getElementById('answer-status').classList.remove('hidden');
}

function looksTranslated() {
  const html = document.documentElement;
  const htmlClass = html.className || '';
  const bodyText = document.body?.innerText || '';
  const sentinel = document.getElementById('translation-sentinel');
  const sentinelText = sentinel?.textContent || '';

  return htmlClass.includes('translated-ltr')
    || htmlClass.includes('translated-rtl')
    || !/^en\b/i.test(html.getAttribute('lang') || 'en')
    || Boolean(document.querySelector('iframe.skiptranslate, .goog-te-banner-frame, #goog-gt-tt, .goog-tooltip'))
    || /[\u0600-\u06FF]/.test(bodyText)
    || (sentinel && !sentinelText.includes('Keep this page in English'));
}

function updateTranslationGate() {
  if (translationGateUpdating) return translationClear;
  translationGateUpdating = true;
  translationClear = !looksTranslated();

  const gate = document.getElementById('translation-gate');
  if (gate) {
    const nextClass = `translation-gate ${translationClear ? 'ok' : 'blocked'}`;
    const nextText = translationClear
      ? 'Page language check: English page is active.'
      : 'Turn off page translation before joining. The quiz must stay in English.';
    if (gate.className !== nextClass) gate.className = nextClass;
    if (gate.textContent !== nextText) gate.textContent = nextText;
  }

  if (joinBtn) {
    joinBtn.disabled = !translationClear;
  }

  if (!translationClear && protectionArmed && !removed) {
    sendViolation('Page translation is active. Turn it off and ask the teacher to let you back in.', 'translation');
  }

  translationGateUpdating = false;
  return translationClear;
}

// ─── Render question ──────────────────────────────────────────────────────────
function renderQuestion(question) {
  currentQuestion = question;
  currentTimeLimit = question.timeLimit;
  hasAnswered = false;

  setText('question-number', `Q${question.number} / ${question.total}`);
  setText('question-section', question.section);
  setText('question-prompt', question.prompt);

  document.getElementById('answer-status').classList.add('hidden');

  // Passage
  const passage = document.getElementById('question-passage');
  if (question.passage) {
    passage.textContent = question.passage;
    passage.classList.remove('hidden');
  } else {
    passage.textContent = '';
    passage.classList.add('hidden');
  }

  // Question image
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

  // Options (already shuffled by server)
  const optionsEl = document.getElementById('question-options');
  optionsEl.innerHTML = '';
  question.options.forEach((optionText, index) => {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.type = 'button';

    const letter = document.createElement('span');
    letter.className = 'option-letter';
    letter.textContent = String.fromCharCode(65 + index);

    const label = document.createElement('span');
    label.textContent = optionText;

    btn.append(letter, label);
    btn.addEventListener('click', () => submitAnswer(index, btn));
    optionsEl.appendChild(btn);
  });

  updateTimer(question.timeLimit);
  showScreen('question');
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function updateTimer(seconds) {
  const timerNumber = document.getElementById('timer-number');
  const timerFill = document.getElementById('timer-fill');
  const safe = Math.max(0, Number(seconds) || 0);
  const pct = currentTimeLimit ? (safe / currentTimeLimit) * 100 : 0;

  timerNumber.textContent = formatTime(safe);
  timerFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;

  timerNumber.className = 'timer-number';
  timerFill.className = 'timer-fill';

  if (safe <= 5) {
    timerNumber.classList.add('danger');
    timerFill.classList.add('danger');
  } else if (safe <= 10) {
    timerNumber.classList.add('warning');
    timerFill.classList.add('warning');
  }
}

// ─── Submit answer ────────────────────────────────────────────────────────────
function submitAnswer(choiceIndex, btn) {
  if (hasAnswered || !currentQuestion || removed) return;
  if (!updateTranslationGate()) return;
  markAnswerSubmitted();
  if (btn) btn.blur();

  socket.emit('student:answer', {
    questionId: currentQuestion.id,
    choiceIndex,
    token: playerToken,
    translationOk: translationClear
  });
}

// ─── Leaderboard render ───────────────────────────────────────────────────────
function renderLeaderboard(containerId, leaderboard) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (!leaderboard || !leaderboard.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.padding = '12px 0';
    p.textContent = 'No scores yet.';
    container.appendChild(p);
    return;
  }

  leaderboard.forEach((player, index) => {
    if (player.id === playerId) updateScore(player.score);

    const row = document.createElement('div');
    row.className = `leaderboard-row${player.status !== 'active' ? ' removed' : ''}`;

    const rankEl = document.createElement('div');
    rankEl.className = `avatar rank rank-${index + 1}`;
    rankEl.textContent = String(index + 1);

    const nameWrap = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'leader-name';
    nameEl.textContent = player.id === playerId ? `${player.name} (you)` : player.name;
    const detail = document.createElement('span');
    detail.className = 'small-text';
    detail.textContent = player.studentClass
      ? `${player.studentClass} · ${player.status === 'active' ? 'Active' : 'Removed'}`
      : (player.status === 'active' ? 'Active' : 'Removed');
    nameWrap.append(nameEl, detail);

    const scoreEl = document.createElement('span');
    scoreEl.className = player.status === 'active' ? 'score-pill' : 'status-pill removed';
    scoreEl.textContent = `${formatScore(player.score)} / ${MAX_SCORE}`;

    row.append(rankEl, nameWrap, scoreEl);
    container.appendChild(row);
  });
}

// ─── Removed overlay ──────────────────────────────────────────────────────────
function showRemoved(reason, score) {
  removed = true;
  protectionArmed = false;
  document.body.classList.remove('protected');
  setText('removed-reason', reason || 'You left the quiz.');
  updateScore(score ?? myScore);
  document.getElementById('removed-overlay').classList.add('active');
}

// ─── Violation ────────────────────────────────────────────────────────────────
function sendViolation(reason, type) {
  if (!protectionArmed || removed || violationSent) return;
  violationSent = true;

  const payload = { playerId, token: playerToken, reason, type };

  try { socket.emit('student:violation', payload); } catch (_) {}

  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/exam1bac/violation', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/exam1bac/violation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      }).catch(() => {});
    }
  } catch (_) {}

  showRemoved(reason, myScore);
}

function armProtection() {
  protectionArmed = true;
  document.body.classList.add('protected');
}

// ─── Registration form ────────────────────────────────────────────────────────
const joinForm = document.getElementById('join-form');
const joinBtn  = document.getElementById('join-btn');

function showError(msg) {
  const box = document.getElementById('join-error');
  box.textContent = msg;
  document.getElementById('student-name').classList.toggle('error', msg.includes('name'));
  document.getElementById('student-number').classList.toggle('error', msg.includes('number'));
  document.getElementById('student-class').classList.toggle('error', msg.includes('class'));
}

function clearError() {
  const box = document.getElementById('join-error');
  box.textContent = '';
  ['student-name', 'student-number', 'student-class'].forEach(id => {
    document.getElementById(id).classList.remove('error');
  });
}

// Client-side English-only check (mirrors server)
function isEnglishOnly(str) {
  return /^[a-zA-Z\s\-'\.]+$/.test(str);
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  clearError();

  const name   = document.getElementById('student-name').value.trim();
  const number = document.getElementById('student-number').value.trim();
  const cls    = document.getElementById('student-class').value;

  if (name.length < 2 || name.split(/\s+/).length < 2) {
    showError('Please enter your full first and last name.');
    return;
  }
  if (!isEnglishOnly(name)) {
    showError('Please write your name using English letters only (no Arabic or other scripts).');
    return;
  }
  if (!number) {
    showError('Please enter your student number.');
    return;
  }
  if (!cls) {
    showError('Please select your class.');
    return;
  }
  if (!updateTranslationGate()) {
    showError('Please turn off page translation and keep this page in English before joining.');
    return;
  }

  // Switch to waiting screen immediately — no need to stare at the form
  setText('waiting-name', name);
  setText('waiting-detail', `${cls} · #${number}`);
  setText('waiting-status', 'Your registration is being confirmed...');
  showScreen('waiting');

  socket.emit('student:join', { name, number, studentClass: cls, translationOk: translationClear });
});

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('connect', () => {
  if (playerToken && studentName) {
    socket.emit('student:resume', { token: playerToken });
  }
});

socket.on('student:joinRejected', ({ message }) => {
  // Bring the form back and show the error
  showScreen('join');
  showError(message || 'Could not join. Please try again.');
});

socket.on('student:joined', ({ id, token, name, number, studentClass: cls, score, totalQuestions: serverTotalQuestions }) => {
  playerId      = id;
  playerToken   = token;
  studentName   = name;
  studentNumber = number;
  studentClass  = cls;
  totalQuestions = Number(serverTotalQuestions) || totalQuestions;

  updateScore(score || 0);

  // Keep name visible everywhere
  setText('score-name', name);
  setText('result-name', name);
  setText('waiting-name', name);
  setText('waiting-detail', `${cls} · #${number}`);
  setText('waiting-status', 'Preparing your 10 random questions...');

  // Stay on the waiting screen (already showing), arm protection
  armProtection();
  updateTranslationGate();
});

socket.on('student:resumed', ({ id, token, name, number, studentClass: cls, score, totalQuestions: serverTotalQuestions }) => {
  playerId = id;
  playerToken = token;
  studentName = name;
  studentNumber = number;
  studentClass = cls;
  totalQuestions = Number(serverTotalQuestions) || totalQuestions;

  setText('score-name', name);
  setText('result-name', name);
  setText('waiting-name', name);
  setText('waiting-detail', `${cls} · #${number}`);
  setText('waiting-status', 'Connection restored. Loading your quiz...');
  updateScore(score);
  removed = false;
  violationSent = false;
  document.getElementById('removed-overlay').classList.remove('active');
  armProtection();
  updateTranslationGate();
});

socket.on('game:question', (question) => {
  if (removed || !playerToken) return;
  renderQuestion(question);
});

socket.on('game:timer', ({ timeRemaining }) => {
  if (removed) return;
  if (!currentQuestion && playerToken) {
    socket.emit('student:sync', { token: playerToken });
  }
  updateTimer(timeRemaining);
});

socket.on('student:answerReceived', () => {
  markAnswerSubmitted();
});

socket.on('student:score', ({ score }) => {
  updateScore(score);
});

socket.on('game:results', (data) => {
  if (removed || !playerToken) return;
  const result = data.results?.[playerId];
  const strip = document.getElementById('result-strip');

  if (result) updateScore(result.score);

  if (result?.correct) {
    strip.className = 'result-strip correct';
    strip.textContent = `✓ Correct! +${formatScore(result.points)} pts`;
  } else if (!result || result?.noAnswer) {
    strip.className = 'result-strip wrong';
    strip.textContent = '✗ No answer submitted.';
  } else {
    strip.className = 'result-strip wrong';
    strip.textContent = '✗ Incorrect.';
  }

  setText('correct-answer', result?.correctAnswer || data.correctAnswer);
  showScreen('result');
});

socket.on('game:leaderboard', ({ leaderboard }) => {
  if (removed || !playerToken) return;
  renderLeaderboard('leaderboard-list', leaderboard || []);
  showScreen('leaderboard');
});

socket.on('game:rankings', ({ leaderboard }) => {
  renderLeaderboard('student-dashboard-ranking', leaderboard || []);
});

socket.on('game:finished', ({ leaderboard }) => {
  if (removed || !playerToken) return;

  // Find the student's own entry for the summary
  const me = leaderboard.find(p => p.id === playerId);
  if (me) updateScore(me.score);

  // Correct answers count
  const correctCount = leaderboard.find(p => p.id === playerId);
  setText('final-score', formatScore(myScore));

  // Count correct from leaderboard (we don't have it directly, but score is reliable).
  const estimatedCorrect = Math.round((myScore / MAX_SCORE) * totalQuestions);
  setText('final-correct', `${estimatedCorrect} correct answers out of ${totalQuestions}`);

  renderLeaderboard('final-leaderboard', leaderboard || []);
  showScreen('finished');
});

socket.on('game:reset', ({ clearStudents } = {}) => {
  if (clearStudents) {
    resetStudentSession(true);
    return;
  }
  if (removed) return;
  updateScore(0);
  violationSent = false;
  showScreen(studentName ? 'waiting' : 'join');
});

socket.on('student:removed', ({ reason, score }) => {
  showRemoved(reason, score);
});

socket.on('student:restored', ({ score } = {}) => {
  removed = false;
  violationSent = false;
  document.getElementById('removed-overlay').classList.remove('active');
  updateScore(score ?? myScore);
  armProtection();
  updateTranslationGate();
  if (playerToken) {
    socket.emit('student:sync', { token: playerToken });
  }
});

setInterval(updateTranslationGate, 1200);

new MutationObserver(() => updateTranslationGate()).observe(document.documentElement, {
  attributes: true,
  childList: true,
  subtree: true,
  characterData: true
});

updateTranslationGate();

// ─── Anti-cheat ───────────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sendViolation('You left the quiz page.', 'visibility');
});

window.addEventListener('blur', () => {
  sendViolation('You opened another app or window during the quiz.', 'blur');
});

window.addEventListener('pagehide', () => {
  sendViolation('You left the quiz page.', 'pagehide');
});

window.addEventListener('beforeunload', () => {
  sendViolation('You left the quiz page.', 'beforeunload');
});

document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  const isScreenshot = e.key === 'PrintScreen'
    || (e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key))
    || (e.ctrlKey && e.shiftKey && ['s', 'p'].includes(key));

  const isBlocked = isScreenshot
    || e.key === 'F12'
    || (e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].includes(key))
    || (e.metaKey && e.altKey && ['i', 'j', 'c'].includes(key))
    || ((e.ctrlKey || e.metaKey) && ['u', 's', 'p', 'a', 'c'].includes(key));

  if (isBlocked) { e.preventDefault(); e.stopPropagation(); }
  if (isScreenshot) sendViolation('Screenshot attempt detected.', 'screenshot');
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'PrintScreen') sendViolation('Screenshot attempt detected.', 'screenshot');
});

document.addEventListener('contextmenu', (e) => {
  if (protectionArmed) e.preventDefault();
});

document.addEventListener('copy', (e) => {
  if (protectionArmed) e.preventDefault();
});

if (navigator.mediaDevices?.getDisplayMedia) {
  const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = (...args) => {
    sendViolation('Screen recording attempt detected.', 'screen-capture');
    return orig(...args);
  };
}
