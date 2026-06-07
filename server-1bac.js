const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const XLSX = require('xlsx');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const QUIZ_TITLE = '1 BAC Passive Voice Quiz';
const TOTAL_SCORE = 5;
const QUIZ_QUESTION_COUNT = 10;
const STANDARD_TIME = 90;
const DISCONNECT_GRACE_MS = 30000;

const VALID_CLASSES = ['1BACSH2', '1BACSE3', '1BACSE4'];
const QUIZ_TIME_ZONE = 'Africa/Casablanca';
const QUIZ_WINDOW = {
  year: 2026,
  month: 6,
  day: 8,
  startHour: 17,
  startMinute: 0,
  endHour: 17,
  endMinute: 30
};

app.use((req, res, next) => {
  if (/\.(?:html|css|js)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
  next();
});
app.use(express.static(__dirname));

app.get('/', (req, res) => res.redirect('/exam1bac-student.html'));
app.get('/teacher', (req, res) => res.redirect('/exam1bac-teacher.html'));
app.get('/student', (req, res) => res.redirect('/exam1bac-student.html'));

app.get('/health', (req, res) => {
  const windowStatus = getQuizWindowStatus();
  res.status(200).json({
    status: 'ok',
    exam: 'passive-voice-1bac',
    title: QUIZ_TITLE,
    phase: getTeacherPhase(),
    windowStatus,
    activePlayers: getActivePlayers().length,
    totalPlayers: Object.keys(gameState.players).length
  });
});

// ─── Excel Export ────────────────────────────────────────────────────────────
app.get('/exam1bac/export-results', (req, res) => {
  const players = Object.values(gameState.players);
  if (!players.length) {
    return res.status(404).json({ error: 'No student data available.' });
  }

  const questionCount = QUIZ_QUESTION_COUNT;

  // Header row
  const header = ['Name', 'Number', 'Class'];
  for (let i = 0; i < questionCount; i++) {
    header.push(`Q${i + 1}`);
  }
  header.push(`Score (/${TOTAL_SCORE})`, `Correct (/${questionCount})`, 'Status');

  const rows = [header];

  // Sort: active first, then by score desc
  const sorted = [...players].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return b.score - a.score || a.name.localeCompare(b.name);
  });

  for (const player of sorted) {
    const row = [
      player.name,
      player.number || '',
      player.studentClass || ''
    ];

    let correctCount = 0;
    for (let i = 0; i < questionCount; i++) {
      const qNum = i + 1;
      const ans = player.answers.find(a => a.questionNumber === qNum);
      if (!ans || ans.choiceIndex === null) {
        row.push('— No answer');
      } else {
        const prefix = ans.correct ? '✓' : '✗';
        row.push(`${prefix} ${ans.prompt || ans.questionId}: ${ans.choiceText || ''}`);
        if (ans.correct) correctCount++;
      }
    }

    const score = Math.round(player.score * 100) / 100;
    const statusLabel = player.status !== 'active'
      ? (player.status === 'allowed_back' ? 'Allowed back' : 'Removed')
      : (player.quizStatus === 'finished' ? 'Finished' : 'In progress');
    row.push(score, correctCount, statusLabel);
    rows.push(row);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 28 },
    { wch: 10 },
    { wch: 12 },
    ...Array.from({ length: questionCount }, () => ({ wch: 42 })),
    { wch: 12 },
    { wch: 12 },
    { wch: 10 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Quiz Results');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="passive-voice-results.xlsx"');
  res.send(buf);
});

// ─── Violation beacon ────────────────────────────────────────────────────────
app.post('/exam1bac/violation', express.text({ type: '*/*' }), (req, res) => {
  try {
    const payload = JSON.parse(req.body || '{}');
    const { playerId, token, reason, type } = payload;
    if (playerId && token) {
      markPlayerRemoved(playerId, reason || 'Left the quiz', type || 'leave', token, false);
    }
  } catch (err) {
    console.warn('Violation beacon parse error:', err.message);
  }
  res.status(204).end();
});

// ─── Questions ───────────────────────────────────────────────────────────────
const passiveVoiceItems = [
  ['The postman delivers the letters every morning.', 'The letters ___ every morning.', ['deliver', 'are delivered', 'delivered', 'were deliver'], 1],
  ['Someone broke the window yesterday.', 'The window ___ yesterday.', ['is broken', 'breaks', 'was broken', 'broken'], 2],
  ['People speak English in many countries.', 'English ___ in many countries.', ['speaks', 'is spoken', 'spoke', 'was speak'], 1],
  ['My sister made the cake last night.', 'The cake ___ by my sister last night.', ['made', 'is made', 'was made', 'makes'], 2],
  ['Workers make these cars in Germany.', 'These cars ___ in Germany.', ['are made', 'made', 'was made', 'make'], 0],
  ['Someone cleans the room every day.', 'The room ___ every day.', ['cleans', 'is cleaned', 'cleaned', 'was clean'], 1],
  ['They finished the report last week.', 'The report ___ last week.', ['is finished', 'finished', 'was finished', 'finishes'], 2],
  ['They keep the books on the shelf.', 'The books ___ on the shelf.', ['are kept', 'keeps', 'was kept', 'kept'], 0],
  ['They built the house in 1990.', 'The house ___ in 1990.', ['is built', 'built', 'was built', 'build'], 2],
  ['Farmers grow coffee in Brazil.', 'Coffee ___ in Brazil.', ['grows', 'is grown', 'was grow', 'grew'], 1],
  ['The manager sent the emails yesterday.', 'The emails ___ by the manager yesterday.', ['are sent', 'sent', 'were sent', 'sends'], 2],
  ['Many people love this song.', 'This song ___ by many people.', ['loves', 'is loved', 'loved', 'was love'], 1],
  ['Someone closed the door at 8 p.m. last night.', 'The door ___ at 8 p.m. last night.', ['is closed', 'closes', 'was closed', 'closed'], 2],
  ['The teacher tests the students every Monday.', 'The students ___ by the teacher every Monday.', ['test', 'are tested', 'was tested', 'tested'], 1],
  ['Workers repaired the old bridge in 2015.', 'The old bridge ___ in 2015.', ['repaired', 'is repaired', 'was repaired', 'repairs'], 2],
  ['They wash the floors twice a week.', 'The floors ___ twice a week.', ['are washed', 'washed', 'was washed', 'washes'], 0],
  ['Picasso painted the picture.', 'The picture ___ by Picasso.', ['painted', 'is painted', 'was painted', 'paints'], 2],
  ['People speak many languages in India.', 'Many languages ___ in India.', ['are spoken', 'speaks', 'was spoken', 'spoke'], 0],
  ['The police caught the thief yesterday.', 'The thief ___ by the police yesterday.', ['catches', 'is caught', 'was caught', 'caught'], 2],
  ['The students do the homework every day.', 'The homework ___ by the students every day.', ['does', 'is done', 'was do', 'did'], 1],
  ['They moved the chairs after the meeting.', 'The chairs ___ after the meeting.', ['were moved', 'are move', 'moved', 'moves'], 0],
  ['Someone delivers the newspaper every morning.', 'The newspaper ___ every morning.', ['is delivered', 'delivered', 'was deliver', 'delivers'], 0],
  ['Thousands of tourists visited the museum last year.', 'The museum ___ by thousands of tourists last year.', ['visits', 'is visited', 'was visited', 'visited'], 2],
  ['People turn on the lights at night.', 'The lights ___ at night.', ['turn on', 'are turned on', 'was turned on', 'turned'], 1],
  ['They sent the invitation two days ago.', 'The invitation ___ two days ago.', ['sends', 'is sent', 'was sent', 'send'], 2],
  ['Someone cleans the classroom before the lesson.', 'The classroom ___ before the lesson.', ['is cleaned', 'cleans', 'was clean', 'cleaning'], 0],
  ['A technician fixed the computer yesterday.', 'The computer ___ yesterday.', ['fixed', 'is fixed', 'was fixed', 'fixes'], 2],
  ['Designers design these shoes in Italy.', 'These shoes ___ in Italy.', ['are designed', 'designed', 'was designed', 'designs'], 0],
  ['They cancelled the match because of the rain.', 'The match ___ because of the rain.', ['cancelled', 'is cancel', 'was cancelled', 'cancels'], 2],
  ['They wash the dishes after dinner.', 'The dishes ___ after dinner.', ['are washed', 'washes', 'was washed', 'washing'], 0],
  ['The assistant made the mistake yesterday.', 'The mistake ___ by the assistant yesterday.', ['made', 'is made', 'was made', 'makes'], 2],
  ['Someone opens the shop at 9 a.m. every day.', 'The shop ___ at 9 a.m. every day.', ['opens', 'is opened', 'was open', 'opened'], 1],
  ['Gardeners water the trees every summer.', 'The trees ___ every summer.', ['water', 'are watered', 'was watered', 'watered'], 1],
  ['Alexander Graham Bell invented the phone in 1876.', 'The phone ___ in 1876.', ['invented', 'is invented', 'was invented', 'invents'], 2],
  ['I received the message five minutes ago.', 'The message ___ five minutes ago.', ['received', 'is received', 'was received', 'receives'], 2],
  ['They clean the windows every Friday.', 'The windows ___ every Friday.', ['are cleaned', 'cleaned', 'was cleaned', 'cleans'], 0],
  ['Tourists visit the city every year.', 'The city ___ by tourists every year.', ['visits', 'is visited', 'was visit', 'visited'], 1],
  ['She wrote the letter by hand yesterday.', 'The letter ___ by hand yesterday.', ['writes', 'is written', 'was written', 'wrote'], 2],
  ['The chef prepares the food in the kitchen.', 'The food ___ in the kitchen.', ['prepares', 'is prepared', 'was prepare', 'prepared'], 1],
  ['The porter carried the bags last night.', 'The bags ___ by the porter last night.', ['carried', 'are carried', 'were carried', 'carries'], 2],
  ['Everyone follows the rules.', 'The rules ___ by everyone.', ['follow', 'are followed', 'was followed', 'followed'], 1],
  ['They solved the problem quickly yesterday.', 'The problem ___ quickly yesterday.', ['solved', 'is solved', 'was solved', 'solves'], 2],
  ['People buy the tickets online.', 'The tickets ___ online.', ['buy', 'are bought', 'was bought', 'bought'], 1],
  ['They painted the wall last month.', 'The wall ___ last month.', ['paints', 'is painted', 'was painted', 'paint'], 2],
  ['They store the documents in a safe place.', 'The documents ___ in a safe place.', ['are stored', 'stored', 'was stored', 'stores'], 0],
  ['My father washed the car yesterday.', 'The car ___ by my father yesterday.', ['washed', 'is washed', 'was washed', 'washes'], 2],
  ['The teacher asks the questions.', 'The questions ___ by the teacher.', ['asks', 'are asked', 'was asked', 'asked'], 1],
  ['They opened the school in 1985.', 'The school ___ in 1985.', ['opened', 'is opened', 'was opened', 'opens'], 2],
  ['They make the beds every morning.', 'The beds ___ every morning.', ['make', 'are made', 'was made', 'made'], 1],
  ['A famous writer writes the story.', 'The story ___ by a famous writer.', ['wrote', 'is written', 'was write', 'writes'], 1]
];

const questionsRaw = passiveVoiceItems.map(([active, question, options, correctIndex], index) => ({
  id: `PV${String(index + 1).padStart(2, '0')}`,
  section: 'Passive Voice Quiz',
  prompt: `Active: ${active} ${question}`,
  options,
  correctIndex,
  timeLimit: STANDARD_TIME
}));

const POINTS_PER_QUESTION = TOTAL_SCORE / QUIZ_QUESTION_COUNT;

const questions = questionsRaw.map((q, i) => ({
  ...q,
  number: i + 1,
  points: POINTS_PER_QUESTION
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize for duplicate detection (order-sensitive) */
function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Normalize for ban detection (order-independent: "Dan Injel" = "Injel Dan") */
function normalizeNameForBan(name) {
  return name.trim().toLowerCase().split(/\s+/).sort().join(' ');
}

/** Only allow Latin letters, spaces, hyphens, apostrophes, dots */
function isEnglishOnly(name) {
  return /^[a-zA-Z\s\-'\.]+$/.test(name);
}

/** Fisher-Yates shuffle, returns a new array */
function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Shuffle a question's options, returns new question object */
function shuffleQuestionOptions(question) {
  const indices = question.options.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const shuffledOptions = indices.map(i => question.options[i]);
  const newCorrectIndex = indices.indexOf(question.correctIndex);
  return { ...question, options: shuffledOptions, correctIndex: newCorrectIndex };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getQuizWindowDateKey() {
  return `${QUIZ_WINDOW.year}-${pad2(QUIZ_WINDOW.month)}-${pad2(QUIZ_WINDOW.day)}`;
}

function getZonedDateTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: QUIZ_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`
  };
}

function quizWindowLabel() {
  return 'Monday, June 8, 2026 from 17:00 to 17:30';
}

function getQuizWindowStatus(date = new Date()) {
  if (process.env.QUIZ_TEST_MODE === 'open') {
    const remainingSeconds = Number(process.env.QUIZ_TEST_REMAINING_SECONDS) || 1800;
    return {
      state: 'open',
      remainingSeconds,
      message: `Test mode: the quiz is open for ${Math.round(remainingSeconds / 60)} minutes.`
    };
  }

  const now = getZonedDateTimeParts(date);
  const targetDateKey = getQuizWindowDateKey();
  const startSeconds = (QUIZ_WINDOW.startHour * 60 + QUIZ_WINDOW.startMinute) * 60;
  const endSeconds = (QUIZ_WINDOW.endHour * 60 + QUIZ_WINDOW.endMinute) * 60;
  const nowSeconds = (now.hour * 60 + now.minute) * 60 + now.second;

  if (now.dateKey < targetDateKey || (now.dateKey === targetDateKey && nowSeconds < startSeconds)) {
    return {
      state: 'upcoming',
      remainingSeconds: 0,
      message: `The quiz opens on ${quizWindowLabel()} (${QUIZ_TIME_ZONE}).`
    };
  }

  if (now.dateKey === targetDateKey && nowSeconds < endSeconds) {
    return {
      state: 'open',
      remainingSeconds: Math.max(0, endSeconds - nowSeconds),
      message: `The quiz is open until 17:30 (${QUIZ_TIME_ZONE}).`
    };
  }

  return {
    state: 'closed',
    remainingSeconds: 0,
    message: `The quiz window closed on ${quizWindowLabel()} (${QUIZ_TIME_ZONE}).`
  };
}

function buildStudentQuestionSet() {
  return shuffleArray(questions)
    .slice(0, QUIZ_QUESTION_COUNT)
    .map(q => shuffleQuestionOptions(q));
}

function getSessionTimeRemaining(player) {
  if (!player || player.quizStatus === 'finished') return 0;
  const windowStatus = getQuizWindowStatus();
  return windowStatus.state === 'open' ? windowStatus.remainingSeconds : 0;
}

function questionForSlot(question, slotIndex, player) {
  return {
    ...question,
    number: slotIndex + 1,
    total: QUIZ_QUESTION_COUNT,
    timeLimit: Math.max(1, getSessionTimeRemaining(player) || STANDARD_TIME)
  };
}

function ensureStudentQuestionSet(player) {
  if (!player.questionSet || player.questionSet.length !== QUIZ_QUESTION_COUNT) {
    player.questionSet = buildStudentQuestionSet();
  }
  return player.questionSet;
}

function getPlayerQuestion(player, slotIndex = player?.currentQuestionIndex ?? 0) {
  if (!player || slotIndex < 0 || slotIndex >= QUIZ_QUESTION_COUNT) return null;
  const questionSet = ensureStudentQuestionSet(player);
  return questionForSlot(questionSet[slotIndex], slotIndex, player);
}

function publicQuestion(question) {
  return {
    id: question.id,
    number: question.number,
    total: question.total || QUIZ_QUESTION_COUNT,
    section: question.section,
    prompt: question.prompt,
    passage: question.passage || null,
    image: question.image || null,
    imageAlt: question.imageAlt || '',
    options: question.options,
    points: question.points,
    timeLimit: question.timeLimit
  };
}

function teacherSlotQuestion() {
  const windowStatus = getQuizWindowStatus();
  return {
    id: 'open-session',
    number: 1,
    total: QUIZ_QUESTION_COUNT,
    section: 'Scheduled Passive Voice Quiz',
    prompt: windowStatus.state === 'open'
      ? `The quiz is open. Each student receives 10 random questions from a ${questions.length}-question passive voice bank.`
      : windowStatus.message,
    passage: null,
    image: null,
    imageAlt: '',
    options: ['Students have individual randomized questions and shuffled choices.'],
    points: POINTS_PER_QUESTION,
    timeLimit: Math.max(1, windowStatus.remainingSeconds || STANDARD_TIME)
  };
}

function getActivePlayers() {
  return Object.values(gameState.players).filter(p => p.status === 'active');
}

function getFinishedPlayers() {
  return getActivePlayers().filter(p => p.quizStatus === 'finished');
}

function findAnswer(player, slotIndex = player?.currentQuestionIndex ?? 0) {
  if (!player || slotIndex < 0) return null;
  return player.answers.find(a => a.questionNumber === slotIndex + 1) || null;
}

function currentAnswerCount() {
  return getFinishedPlayers().length;
}

function emitAnswerProgress() {
  io.to('teachers').emit('game:answerCount', {
    count: currentAnswerCount(),
    total: getActivePlayers().length
  });
}

function findPlayerEntryByToken(token) {
  if (!token) return null;
  return Object.entries(gameState.players).find(([, player]) => player.token === token) || null;
}

function clearPendingDisconnect(token) {
  const timer = token ? gameState.pendingDisconnects[token] : null;
  if (timer) {
    clearTimeout(timer);
    delete gameState.pendingDisconnects[token];
  }
}

function clearPlayerTimer(player) {
  if (player?.sessionTimer) {
    clearInterval(player.sessionTimer);
    player.sessionTimer = null;
  }
}

function clearAllPlayerTimers() {
  Object.values(gameState.players).forEach(clearPlayerTimer);
}

function getLeaderboard() {
  return Object.values(gameState.players)
    .map(p => ({
      id: p.id,
      name: p.name,
      number: p.number || '',
      studentClass: p.studentClass || '',
      score: Math.round(p.score * 100) / 100,
      status: p.status,
      quizStatus: p.quizStatus || 'in_progress',
      correctCount: p.answers?.filter(a => a.correct).length || 0,
      removalReason: p.removalReason || ''
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function publicPlayer(player) {
  const hasAnsweredCurrent = player.quizStatus === 'finished'
    ? true
    : Boolean(findAnswer(player, player.currentQuestionIndex));

  return {
    id: player.id,
    name: player.name,
    number: player.number || '',
    studentClass: player.studentClass || '',
    score: Math.round(player.score * 100) / 100,
    status: player.status,
    quizStatus: player.quizStatus || 'in_progress',
    currentQuestionNumber: (player.currentQuestionIndex ?? 0) + 1,
    totalQuestions: QUIZ_QUESTION_COUNT,
    correctCount: player.answers?.filter(a => a.correct).length || 0,
    connectionStatus: player.connectionStatus || 'online',
    hasAnsweredCurrent,
    removalReason: player.removalReason || '',
    removalType: player.removalType || ''
  };
}

function getTeacherPhase() {
  if (gameState.phase === 'finished') return 'finished';
  const windowStatus = getQuizWindowStatus();
  if (windowStatus.state === 'open' && getActivePlayers().length) return 'question';
  return 'lobby';
}

function getTeacherState() {
  const phase = getTeacherPhase();
  const currentQuestion = phase === 'question' ? teacherSlotQuestion() : null;
  const players = Object.fromEntries(
    Object.entries(gameState.players).map(([id, p]) => [id, publicPlayer(p)])
  );
  const windowStatus = getQuizWindowStatus();
  return {
    phase,
    players,
    leaderboard: getLeaderboard(),
    currentQuestion,
    currentQuestionIndex: 0,
    totalQuestions: QUIZ_QUESTION_COUNT,
    activeCount: getActivePlayers().length,
    answerCount: currentAnswerCount(),
    timeRemaining: windowStatus.remainingSeconds,
    windowStatus
  };
}

function emitTeacherState() {
  io.to('teachers').emit('teacher:state', getTeacherState());
  io.emit('game:rankings', { leaderboard: getLeaderboard() });
}

function emitStudentCurrentState(socket, player) {
  if (!player || player.status !== 'active') return;

  socket.emit('student:score', {
    score: Math.round(player.score * 100) / 100
  });

  if (player.quizStatus === 'finished') {
    socket.emit('game:finished', { leaderboard: getLeaderboard() });
    return;
  }

  const windowStatus = getQuizWindowStatus();
  if (windowStatus.state !== 'open') {
    finishPlayerQuiz(player, 'time');
    return;
  }

  const question = getPlayerQuestion(player);
  if (!question) return;

  socket.emit('game:question', publicQuestion(question));
  socket.emit('game:timer', { timeRemaining: getSessionTimeRemaining(player) });
}

// ─── Game state ───────────────────────────────────────────────────────────────
const gameState = {
  phase: 'lobby',
  players: {},
  bannedNames: new Set(),    // stores banKey (order-independent)
  pendingDisconnects: {}
};

// ─── Quiz flow ────────────────────────────────────────────────────────────────
function tickPlayerTimer(player) {
  const currentPlayer = gameState.players[player.id];
  if (!currentPlayer || currentPlayer.status !== 'active' || currentPlayer.quizStatus === 'finished') {
    clearPlayerTimer(player);
    return;
  }

  const remaining = getSessionTimeRemaining(currentPlayer);
  currentPlayer.timeRemaining = remaining;
  io.to(currentPlayer.id).emit('game:timer', { timeRemaining: remaining });
  if (remaining <= 0) {
    finishPlayerQuiz(currentPlayer, 'time');
  } else {
    emitTeacherState();
  }
}

function startPlayerTimer(player) {
  clearPlayerTimer(player);
  tickPlayerTimer(player);
  if (player.status === 'active' && player.quizStatus !== 'finished') {
    player.sessionTimer = setInterval(() => tickPlayerTimer(player), 1000);
  }
}

function finishPlayerQuiz(player, reason = 'completed', notifyTeacher = true) {
  if (!player || player.quizStatus === 'finished') return;
  clearPlayerTimer(player);
  player.quizStatus = 'finished';
  player.finishReason = reason;
  player.finishedAt = Date.now();
  player.timeRemaining = 0;

  io.to(player.id).emit('student:score', {
    score: Math.round(player.score * 100) / 100
  });
  io.to(player.id).emit('game:finished', { leaderboard: getLeaderboard() });

  if (notifyTeacher) {
    emitAnswerProgress();
    emitTeacherState();
  }
}

function finishQuiz() {
  clearAllPlayerTimers();
  for (const player of getActivePlayers()) {
    finishPlayerQuiz(player, player.quizStatus === 'finished' ? player.finishReason : 'ended_by_teacher', false);
  }
  gameState.phase = 'finished';
  io.emit('game:finished', { leaderboard: getLeaderboard() });
  emitAnswerProgress();
  emitTeacherState();
}

function markPlayerRemoved(playerId, reason, type, token, shouldDisconnect = true) {
  const player = gameState.players[playerId];
  if (!player || player.status !== 'active') return false;
  if (token && player.token !== token) return false;
  clearPendingDisconnect(player.token);
  clearPlayerTimer(player);

  player.status = 'removed';
  player.removalReason = reason || 'Removed from the quiz';
  player.removalType = type || 'rule';
  player.removedAt = Date.now();

  // Ban by order-independent name key
  gameState.bannedNames.add(player.banKey);

  io.to('teachers').emit('game:playerRemoved', {
    id: playerId,
    name: player.name,
    score: Math.round(player.score * 100) / 100,
    reason: player.removalReason,
    type: player.removalType,
    activeCount: getActivePlayers().length
  });
  io.emit('game:playerCount', { count: getActivePlayers().length });
  emitAnswerProgress();
  emitTeacherState();

  const targetSocket = io.sockets.sockets.get(playerId);
  if (targetSocket) {
    targetSocket.emit('student:removed', {
      reason: player.removalReason,
      score: Math.round(player.score * 100) / 100
    });
  }

  return true;
}

function restorePlayer(playerId) {
  const player = gameState.players[playerId];
  if (!player || player.status === 'active') return false;

  clearPendingDisconnect(player.token);
  gameState.bannedNames.delete(player.banKey);

  const targetSocket = io.sockets.sockets.get(playerId);
  if (targetSocket) {
    player.status = 'active';
    player.connectionStatus = 'online';
    player.removalReason = '';
    player.removalType = '';
    player.allowedBackAt = Date.now();
    player.disconnectedAt = null;

    targetSocket.emit('student:restored', {
      score: Math.round(player.score * 100) / 100
    });
    if (player.quizStatus !== 'finished' && getQuizWindowStatus().state === 'open') {
      startPlayerTimer(player);
    } else if (player.quizStatus !== 'finished') {
      finishPlayerQuiz(player, 'time', false);
    }
    emitStudentCurrentState(targetSocket, player);
    io.emit('game:playerCount', { count: getActivePlayers().length });
    emitAnswerProgress();
    emitTeacherState();
    return true;
  }

  player.status = 'allowed_back';
  player.connectionStatus = 'offline';
  player.removalReason = 'Allowed to rejoin';
  player.removalType = '';
  player.allowedBackAt = Date.now();

  emitTeacherState();
  return true;
}

function resetQuiz() {
  clearAllPlayerTimers();
  Object.values(gameState.pendingDisconnects).forEach(clearTimeout);
  gameState.players = {};

  gameState.bannedNames.clear();
  gameState.phase = 'lobby';
  gameState.pendingDisconnects = {};

  io.emit('game:reset', { clearStudents: true });
  emitTeacherState();
}

function resumePlayer(socket, token) {
  const entry = findPlayerEntryByToken(String(token || ''));
  if (!entry) return null;

  const [oldSocketId, player] = entry;
  if (player.status !== 'active' && player.status !== 'allowed_back') return null;

  clearPendingDisconnect(player.token);

  if (oldSocketId !== socket.id) {
    delete gameState.players[oldSocketId];
    player.id = socket.id;
    gameState.players[socket.id] = player;
  }

  if (player.status === 'allowed_back') {
    gameState.bannedNames.delete(player.banKey);
  }
  player.connectionStatus = 'online';
  player.status = 'active';
  player.removalReason = '';
  player.removalType = '';
  player.disconnectedAt = null;
  socket.data.playerToken = player.token;

  socket.emit('student:resumed', {
    id: socket.id,
    token: player.token,
    name: player.name,
    number: player.number,
    studentClass: player.studentClass,
    score: Math.round(player.score * 100) / 100,
    totalQuestions: QUIZ_QUESTION_COUNT
  });

  if (player.quizStatus !== 'finished' && getQuizWindowStatus().state === 'open') {
    startPlayerTimer(player);
  } else if (player.quizStatus !== 'finished') {
    finishPlayerQuiz(player, 'time', false);
  }
  emitStudentCurrentState(socket, player);
  emitAnswerProgress();
  emitTeacherState();
  return player;
}

function scheduleDisconnectRemoval(playerId) {
  const player = gameState.players[playerId];
  if (!player || player.status !== 'active') return;

  player.connectionStatus = 'reconnecting';
  player.disconnectedAt = Date.now();
  clearPlayerTimer(player);
  clearPendingDisconnect(player.token);

  gameState.pendingDisconnects[player.token] = setTimeout(() => {
    markPlayerRemoved(player.id, 'Left the quiz or lost connection', 'disconnect', null, false);
  }, DISCONNECT_GRACE_MS);

  emitTeacherState();
}

function findAllowedBackEntry(normalizedName, number, studentClass) {
  return Object.entries(gameState.players).find(([, player]) => (
    player.status === 'allowed_back'
    && player.normalizedName === normalizedName
    && player.number === number
    && player.studentClass === studentClass
  )) || null;
}

function activateAllowedBackPlayer(socket, entry, cleanName, cleanNumber, cleanClass, normalizedName, banKey) {
  const [oldSocketId, player] = entry;
  const token = crypto.randomBytes(18).toString('hex');

  clearPendingDisconnect(player.token);
  delete gameState.players[oldSocketId];

  player.id = socket.id;
  player.token = token;
  player.name = cleanName;
  player.number = cleanNumber;
  player.studentClass = cleanClass;
  player.normalizedName = normalizedName;
  player.banKey = banKey;
  player.status = 'active';
  player.connectionStatus = 'online';
  player.removalReason = '';
  player.removalType = '';
  player.disconnectedAt = null;
  player.rejoinedAt = Date.now();

  socket.data.playerToken = token;
  gameState.players[socket.id] = player;

  socket.emit('student:joined', {
    id: socket.id,
    token,
    name: cleanName,
    number: cleanNumber,
    studentClass: cleanClass,
    score: Math.round(player.score * 100) / 100,
    totalQuestions: QUIZ_QUESTION_COUNT
  });

  if (player.quizStatus !== 'finished' && getQuizWindowStatus().state === 'open') {
    startPlayerTimer(player);
  } else if (player.quizStatus !== 'finished') {
    finishPlayerQuiz(player, 'time', false);
  }
  emitStudentCurrentState(socket, player);
  io.emit('game:playerCount', { count: getActivePlayers().length });
  emitAnswerProgress();
  emitTeacherState();
  return player;
}

// ─── Socket.IO events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  function safe(fn) {
    return (...args) => {
      try { fn(...args); } catch (err) { console.error(`Socket error [${socket.id}]:`, err); }
    };
  }

  // ── Teacher events ──
  socket.on('teacher:join', safe(() => {
    socket.join('teachers');
    socket.emit('teacher:state', getTeacherState());
  }));

  socket.on('teacher:start', safe(() => {
    socket.emit('teacher:notice', {
      message: `This quiz opens automatically on ${quizWindowLabel()} (${QUIZ_TIME_ZONE}). Students start their own 10-question set when they join during that window.`
    });
  }));

  // "Show Results Now" = end the quiz immediately and show all final results
  socket.on('teacher:showResults', safe(() => {
    finishQuiz();
  }));

  socket.on('teacher:moveNext', safe(() => {
    socket.emit('teacher:notice', {
      message: 'Students advance independently in this scheduled quiz.'
    });
  }));

  socket.on('teacher:movePrevious', safe(() => {
    socket.emit('teacher:notice', {
      message: 'Students advance independently in this scheduled quiz.'
    });
  }));

  socket.on('teacher:showLeaderboard', safe(() => {
    gameState.phase = 'leaderboard';
    io.emit('game:leaderboard', { leaderboard: getLeaderboard() });
    emitTeacherState();
  }));

  socket.on('teacher:endQuiz', safe(() => {
    finishQuiz();
  }));

  socket.on('teacher:restart', safe(() => {
    resetQuiz();
  }));

  socket.on('teacher:kickPlayer', safe(({ playerId }) => {
    markPlayerRemoved(playerId, 'Removed by teacher', 'teacher', null, true);
  }));

  socket.on('teacher:restorePlayer', safe(({ playerId }) => {
    restorePlayer(playerId);
  }));

  socket.on('student:resume', safe(({ token }) => {
    resumePlayer(socket, token);
  }));

  socket.on('student:sync', safe(({ token }) => {
    const player = resumePlayer(socket, token);
    if (player) return;

    const currentPlayer = gameState.players[socket.id];
    if (currentPlayer && currentPlayer.status === 'active') {
      emitStudentCurrentState(socket, currentPlayer);
    }
  }));

  // ── Student events ──
  socket.on('student:join', safe(({ name, number, studentClass, translationOk }) => {
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const cleanNumber = String(number || '').trim().slice(0, 20);
    const cleanClass = String(studentClass || '').trim();

    if (cleanName.length < 2) {
      socket.emit('student:joinRejected', { message: 'Please enter your full name.' });
      return;
    }
    if (!isEnglishOnly(cleanName)) {
      socket.emit('student:joinRejected', {
        message: 'Please write your name in English letters only (no Arabic or other scripts).'
      });
      return;
    }
    if (cleanName.split(/\s+/).length < 2) {
      socket.emit('student:joinRejected', { message: 'Please enter both your first and last name.' });
      return;
    }
    if (!cleanNumber) {
      socket.emit('student:joinRejected', { message: 'Please enter your student number.' });
      return;
    }
    if (!VALID_CLASSES.includes(cleanClass)) {
      socket.emit('student:joinRejected', { message: 'Please select a valid class.' });
      return;
    }
    if (translationOk === false) {
      socket.emit('student:joinRejected', {
        message: 'Please turn off page translation and keep the quiz page in English before joining.'
      });
      return;
    }
    if (gameState.phase === 'finished') {
      socket.emit('student:joinRejected', { message: 'The quiz has finished. Please wait for the next session.' });
      return;
    }
    const windowStatus = getQuizWindowStatus();
    if (windowStatus.state !== 'open') {
      socket.emit('student:joinRejected', { message: windowStatus.message });
      return;
    }

    const normalizedName = normalizeName(cleanName);
    const banKey = normalizeNameForBan(cleanName);
    const allowedBackEntry = findAllowedBackEntry(normalizedName, cleanNumber, cleanClass);

    if (allowedBackEntry) {
      activateAllowedBackPlayer(socket, allowedBackEntry, cleanName, cleanNumber, cleanClass, normalizedName, banKey);
      return;
    }

    if (gameState.bannedNames.has(banKey)) {
      socket.emit('student:joinRejected', {
        message: 'You have been removed from this quiz session. Ask the teacher to let you back in.'
      });
      return;
    }

    const duplicate = Object.values(gameState.players).some(
      p => p.status === 'active' && p.normalizedName === normalizedName
    );
    if (duplicate) {
      socket.emit('student:joinRejected', { message: 'This name is already in the quiz.' });
      return;
    }

    const token = crypto.randomBytes(18).toString('hex');
    socket.data.playerToken = token;
    gameState.players[socket.id] = {
      id: socket.id,
      token,
      name: cleanName,
      number: cleanNumber,
      studentClass: cleanClass,
      normalizedName,
      banKey,
      score: 0,
      answers: [],
      questionSet: buildStudentQuestionSet(),
      currentQuestionIndex: 0,
      quizStatus: 'in_progress',
      timeRemaining: windowStatus.remainingSeconds,
      translationOk: translationOk !== false,
      status: 'active',
      connectionStatus: 'online',
      startedAt: Date.now(),
      joinedAt: Date.now()
    };

    socket.emit('student:joined', {
      id: socket.id,
      token,
      name: cleanName,
      number: cleanNumber,
      studentClass: cleanClass,
      score: 0,
      totalQuestions: QUIZ_QUESTION_COUNT
    });
    startPlayerTimer(gameState.players[socket.id]);
    io.emit('game:playerCount', { count: getActivePlayers().length });
    emitStudentCurrentState(socket, gameState.players[socket.id]);
    emitAnswerProgress();
    emitTeacherState();
  }));

  socket.on('student:answer', safe(({ questionId, choiceIndex, token, translationOk }) => {
    let player = gameState.players[socket.id];
    if (!player && token) {
      player = resumePlayer(socket, token);
    }
    if (!player || player.status !== 'active') return;
    if (player.quizStatus === 'finished') return;
    if (translationOk === false) {
      player.translationOk = false;
      markPlayerRemoved(socket.id, 'Page translation is active. Turn it off and ask the teacher to let you back in.', 'translation', token, false);
      return;
    }
    player.translationOk = true;
    if (getQuizWindowStatus().state !== 'open') {
      finishPlayerQuiz(player, 'time');
      return;
    }
    const question = getPlayerQuestion(player);
    if (!question || question.id !== questionId) return;

    const existingAnswer = findAnswer(player);
    if (existingAnswer) {
      socket.emit('student:answerReceived', { choiceIndex: existingAnswer.choiceIndex });
      return;
    }

    const numericChoice = Number(choiceIndex);
    if (!Number.isInteger(numericChoice) || numericChoice < 0 || numericChoice >= question.options.length) return;

    const isCorrect = numericChoice === question.correctIndex;
    const points = isCorrect ? question.points : 0;
    if (isCorrect) {
      player.score += points;
    }

    player.answers.push({
      questionId: question.id,
      questionNumber: question.number,
      prompt: question.prompt,
      choiceIndex: numericChoice,
      choiceText: question.options[numericChoice] || '',
      correctAnswer: question.options[question.correctIndex],
      correct: isCorrect,
      points,
      answeredAt: Date.now()
    });

    socket.emit('student:answerReceived', { choiceIndex: numericChoice });
    socket.emit('student:score', {
      score: Math.round(player.score * 100) / 100
    });
    emitAnswerProgress();
    emitTeacherState();

    if (player.currentQuestionIndex >= QUIZ_QUESTION_COUNT - 1) {
      finishPlayerQuiz(player, 'completed');
      return;
    }

    player.currentQuestionIndex += 1;
    setTimeout(() => {
      if (gameState.players[socket.id] === player && player.status === 'active' && player.quizStatus !== 'finished') {
        emitStudentCurrentState(socket, player);
      }
    }, 250);
  }));

  socket.on('student:violation', safe(({ playerId, token, reason, type }) => {
    if (playerId && playerId !== socket.id) return;
    markPlayerRemoved(socket.id, reason || 'Left the quiz', type || 'rule', token, true);
  }));

  socket.on('disconnect', () => {
    try {
      const player = gameState.players[socket.id];
      if (player && player.status === 'active' && gameState.phase !== 'finished') {
        scheduleDisconnectRemoval(socket.id);
      }
    } catch (err) {
      console.error('disconnect error:', err);
    }
    console.log(`Disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`${QUIZ_TITLE} -> ${HOST}:${PORT}`);
  console.log(`  Window: ${quizWindowLabel()} (${QUIZ_TIME_ZONE})`);
  console.log('  Teacher: /teacher');
  console.log('  Student: /student');
});
