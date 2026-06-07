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
const questionsRaw = [
  // Present simple passive
  {
    id: 'PV01', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "People speak English in many countries."',
    options: [
      'English is spoken in many countries.',
      'English speaks in many countries.',
      'English was spoken in many countries.',
      'English is speak in many countries.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV02', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "Farmers grow olives in Morocco."',
    options: [
      'Olives are grown in Morocco.',
      'Olives grow farmers in Morocco.',
      'Olives is grown in Morocco.',
      'Olives were grow in Morocco.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV03', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "The teacher checks the homework every day."',
    options: [
      'The homework is checked every day.',
      'The homework checks every day.',
      'The homework was checked every day.',
      'The homework is checking every day.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV04', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "They clean the classrooms every morning."',
    options: [
      'The classrooms are cleaned every morning.',
      'The classrooms clean every morning.',
      'The classrooms were cleaned every morning.',
      'The classrooms are clean every morning.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV05', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "The company sells computers online."',
    options: [
      'Computers are sold online.',
      'Computers sell online.',
      'Computers are selling online.',
      'Computers were sold online.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV06', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "Someone opens the gate at 8 o\'clock."',
    options: [
      'The gate is opened at 8 o\'clock.',
      'The gate opened at 8 o\'clock.',
      'The gate is opening at 8 o\'clock.',
      'The gate was open at 8 o\'clock.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV07', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "Many students use smartphones."',
    options: [
      'Smartphones are used by many students.',
      'Smartphones use many students.',
      'Smartphones are using by many students.',
      'Smartphones were used by many students.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV08', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "The chef prepares lunch at noon."',
    options: [
      'Lunch is prepared at noon.',
      'Lunch prepares at noon.',
      'Lunch was prepared at noon.',
      'Lunch is prepare at noon.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV09', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "People celebrate Eid in Morocco."',
    options: [
      'Eid is celebrated in Morocco.',
      'Eid celebrates in Morocco.',
      'Eid was celebrated in Morocco.',
      'Eid is celebrating in Morocco.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV10', section: 'Passive Voice: Present Simple',
    prompt: 'Choose the correct passive form: "They do not allow phones in the exam room."',
    options: [
      'Phones are not allowed in the exam room.',
      'Phones do not allow in the exam room.',
      'Phones were not allowed in the exam room.',
      'Phones are not allowing in the exam room.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },

  // Past simple passive
  {
    id: 'PV11', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "Shakespeare wrote Hamlet."',
    options: [
      'Hamlet was written by Shakespeare.',
      'Hamlet is written by Shakespeare.',
      'Hamlet wrote Shakespeare.',
      'Hamlet was wrote by Shakespeare.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV12', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "The police arrested the thief yesterday."',
    options: [
      'The thief was arrested yesterday.',
      'The thief arrested yesterday.',
      'The thief is arrested yesterday.',
      'The thief was arrest yesterday.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV13', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "They built this bridge in 2010."',
    options: [
      'This bridge was built in 2010.',
      'This bridge is built in 2010.',
      'This bridge built in 2010.',
      'This bridge was build in 2010.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV14', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "My father repaired the car."',
    options: [
      'The car was repaired by my father.',
      'The car repaired my father.',
      'The car is repaired by my father.',
      'The car was repairing by my father.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV15', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "Someone stole my bag last night."',
    options: [
      'My bag was stolen last night.',
      'My bag stole last night.',
      'My bag is stolen last night.',
      'My bag was stole last night.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV16', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "The storm damaged many houses."',
    options: [
      'Many houses were damaged by the storm.',
      'Many houses damaged the storm.',
      'Many houses was damaged by the storm.',
      'Many houses are damaged by the storm.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV17', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "The students answered the questions."',
    options: [
      'The questions were answered by the students.',
      'The questions answered the students.',
      'The questions was answered by the students.',
      'The questions are answered by the students.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV18', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "The manager cancelled the meeting."',
    options: [
      'The meeting was cancelled by the manager.',
      'The meeting cancelled the manager.',
      'The meeting is cancelled by the manager.',
      'The meeting was cancelling by the manager.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV19', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive form: "They did not invite Sara."',
    options: [
      'Sara was not invited.',
      'Sara did not invited.',
      'Sara is not invited.',
      'Sara was not invite.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV20', section: 'Passive Voice: Past Simple',
    prompt: 'Choose the correct passive question: "Did they finish the project?"',
    options: [
      'Was the project finished?',
      'Did the project finished?',
      'Is the project finished?',
      'Was the project finish?'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },

  // Future and modals
  {
    id: 'PV21', section: 'Passive Voice: Future',
    prompt: 'Choose the correct passive form: "They will announce the results tomorrow."',
    options: [
      'The results will be announced tomorrow.',
      'The results will announce tomorrow.',
      'The results are announced tomorrow.',
      'The results will be announce tomorrow.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV22', section: 'Passive Voice: Future',
    prompt: 'Choose the correct passive form: "The school will organize a trip."',
    options: [
      'A trip will be organized by the school.',
      'A trip will organize the school.',
      'A trip is organized by the school.',
      'A trip will be organize by the school.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV23', section: 'Passive Voice: Modals',
    prompt: 'Choose the correct passive form: "You must wear a helmet."',
    options: [
      'A helmet must be worn.',
      'A helmet must wear.',
      'A helmet must be wore.',
      'A helmet is must worn.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV24', section: 'Passive Voice: Modals',
    prompt: 'Choose the correct passive form: "Students should submit homework on time."',
    options: [
      'Homework should be submitted on time.',
      'Homework should submit on time.',
      'Homework should be submit on time.',
      'Homework is should submitted on time.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV25', section: 'Passive Voice: Modals',
    prompt: 'Choose the correct passive form: "We can solve this problem."',
    options: [
      'This problem can be solved.',
      'This problem can solve.',
      'This problem is can solved.',
      'This problem can be solve.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV26', section: 'Passive Voice: Modals',
    prompt: 'Choose the correct passive form: "They may postpone the match."',
    options: [
      'The match may be postponed.',
      'The match may postpone.',
      'The match may be postpone.',
      'The match is may postponed.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV27', section: 'Passive Voice: Future',
    prompt: 'Choose the correct passive form: "Nobody will forget this lesson."',
    options: [
      'This lesson will not be forgotten.',
      'This lesson will not forget.',
      'This lesson is not forgotten.',
      'This lesson will be not forget.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV28', section: 'Passive Voice: Going To',
    prompt: 'Choose the correct passive form: "The mechanic is going to fix the bus."',
    options: [
      'The bus is going to be fixed by the mechanic.',
      'The bus is going to fix by the mechanic.',
      'The bus was going to be fixed by the mechanic.',
      'The bus is going to be fix by the mechanic.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV29', section: 'Passive Voice: Have To',
    prompt: 'Choose the correct passive form: "They have to clean the lab."',
    options: [
      'The lab has to be cleaned.',
      'The lab has to clean.',
      'The lab have to be cleaned.',
      'The lab has to be clean.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV30', section: 'Passive Voice: Modals',
    prompt: 'Choose the correct passive question: "Can they repair the computer?"',
    options: [
      'Can the computer be repaired?',
      'Can the computer repair?',
      'Is the computer can repaired?',
      'Can the computer be repair?'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },

  // Perfect and continuous passives
  {
    id: 'PV31', section: 'Passive Voice: Present Perfect',
    prompt: 'Choose the correct passive form: "They have sent the email."',
    options: [
      'The email has been sent.',
      'The email has sent.',
      'The email was sent.',
      'The email has been send.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV32', section: 'Passive Voice: Present Perfect',
    prompt: 'Choose the correct passive form: "Someone has broken the window."',
    options: [
      'The window has been broken.',
      'The window has broken.',
      'The window was been broken.',
      'The window has been broke.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV33', section: 'Passive Voice: Present Perfect',
    prompt: 'Choose the correct passive form: "We have already discussed the topic."',
    options: [
      'The topic has already been discussed.',
      'The topic has already discussed.',
      'The topic was already discussed.',
      'The topic has already been discuss.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV34', section: 'Passive Voice: Present Perfect',
    prompt: 'Choose the correct passive form: "They have not painted the wall yet."',
    options: [
      'The wall has not been painted yet.',
      'The wall has not painted yet.',
      'The wall was not painted yet.',
      'The wall has not been paint yet.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV35', section: 'Passive Voice: Present Perfect',
    prompt: 'Choose the correct passive question: "Has the teacher corrected the tests?"',
    options: [
      'Have the tests been corrected by the teacher?',
      'Have the tests corrected by the teacher?',
      'Were the tests been corrected by the teacher?',
      'Have the tests been correct by the teacher?'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV36', section: 'Passive Voice: Past Perfect',
    prompt: 'Choose the correct passive form: "They had finished the work before sunset."',
    options: [
      'The work had been finished before sunset.',
      'The work had finished before sunset.',
      'The work was been finished before sunset.',
      'The work had been finish before sunset.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV37', section: 'Passive Voice: Past Perfect',
    prompt: 'Choose the correct passive form: "Someone had locked the door."',
    options: [
      'The door had been locked.',
      'The door had locked.',
      'The door was been locked.',
      'The door had been lock.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV38', section: 'Passive Voice: Present Continuous',
    prompt: 'Choose the correct passive form: "They are building a new library."',
    options: [
      'A new library is being built.',
      'A new library is building.',
      'A new library was being built.',
      'A new library is being build.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV39', section: 'Passive Voice: Present Continuous',
    prompt: 'Choose the correct passive form: "The nurse is helping the patient."',
    options: [
      'The patient is being helped by the nurse.',
      'The patient is helping by the nurse.',
      'The patient was being helped by the nurse.',
      'The patient is being help by the nurse.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV40', section: 'Passive Voice: Past Continuous',
    prompt: 'Choose the correct passive form: "They were interviewing the actor."',
    options: [
      'The actor was being interviewed.',
      'The actor was interviewing.',
      'The actor is being interviewed.',
      'The actor was being interview.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },

  // Mixed passive voice practice
  {
    id: 'PV41', section: 'Passive Voice: Mixed Practice',
    prompt: 'Choose the correct passive form: "The children broke the vase."',
    options: [
      'The vase was broken by the children.',
      'The vase broke the children.',
      'The vase is broken by the children.',
      'The vase was broke by the children.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV42', section: 'Passive Voice: Mixed Practice',
    prompt: 'Complete the sentence: "The letter __________ yesterday."',
    options: [
      'was sent',
      'is sent',
      'sent',
      'was send'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV43', section: 'Passive Voice: Mixed Practice',
    prompt: 'Complete the sentence: "Arabic __________ in many countries."',
    options: [
      'is spoken',
      'speaks',
      'was spoken',
      'is speaking'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV44', section: 'Passive Voice: Mixed Practice',
    prompt: 'Choose the correct passive form: "They make cars in this factory."',
    options: [
      'Cars are made in this factory.',
      'Cars make in this factory.',
      'Cars were made in this factory.',
      'Cars are make in this factory.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV45', section: 'Passive Voice: Mixed Practice',
    prompt: 'Choose the active sentence for: "My room is cleaned every Friday."',
    options: [
      'Someone cleans my room every Friday.',
      'Someone cleaned my room every Friday.',
      'My room cleans someone every Friday.',
      'Someone is cleaning my room every Friday.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV46', section: 'Passive Voice: Mixed Practice',
    prompt: 'Choose the correct passive question: "Do they grow oranges here?"',
    options: [
      'Are oranges grown here?',
      'Do oranges grow here by them?',
      'Were oranges grown here?',
      'Are oranges grow here?'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV47', section: 'Passive Voice: Mixed Practice',
    prompt: 'Choose the correct passive question: "Who wrote this poem?"',
    options: [
      'Who was this poem written by?',
      'Who this poem was written by?',
      'Who is this poem written by?',
      'Who was this poem wrote by?'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV48', section: 'Passive Voice: Mixed Practice',
    prompt: 'Complete the sentence: "The report must __________ before Monday."',
    options: [
      'be finished',
      'finish',
      'be finish',
      'finished'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV49', section: 'Passive Voice: Mixed Practice',
    prompt: 'Complete the sentence: "The tickets __________ by my uncle last week."',
    options: [
      'were bought',
      'are bought',
      'bought',
      'were buy'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  },
  {
    id: 'PV50', section: 'Passive Voice: Mixed Practice',
    prompt: 'Which sentence is in the passive voice?',
    options: [
      'The meal was cooked by my mother.',
      'My mother cooked the meal.',
      'My mother is cooking the meal.',
      'My mother cooks dinner every day.'
    ],
    correctIndex: 0, timeLimit: STANDARD_TIME
  }
];

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
