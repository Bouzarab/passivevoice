import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';

const PORT = process.env.SMOKE_TEST_PORT || '3100';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 15_000;
const EVENT_TIMEOUT_MS = 8_000;

function fail(message) {
  throw new Error(message);
}

async function waitForHealth(server) {
  const start = Date.now();
  while (Date.now() - start < SERVER_READY_TIMEOUT_MS) {
    if (server.exitCode !== null) fail(`Server exited early with code ${server.exitCode}.`);
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.windowStatus?.state === 'open') return body;
      }
    } catch (_) {
      // Server is still booting.
    }
    await delay(250);
  }
  fail('Server did not become healthy in test-open mode.');
}

function waitForEvent(socket, eventName, timeoutMs = EVENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}.`));
    }, timeoutMs);

    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }

    socket.once(eventName, onEvent);
  });
}

function waitForTeacherPlayer(socket, studentName, timeoutMs = EVENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('teacher:state', onState);
      reject(new Error(`Timed out waiting for teacher state for ${studentName}.`));
    }, timeoutMs);

    function onState(state) {
      const player = Object.values(state.players || {}).find(item => item.name === studentName);
      if (player?.quizStatus === 'finished') {
        clearTimeout(timer);
        socket.off('teacher:state', onState);
        resolve({ state, player });
      }
    }

    socket.on('teacher:state', onState);
    socket.emit('teacher:join');
  });
}

function connectSocket() {
  return io(BASE_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: EVENT_TIMEOUT_MS
  });
}

async function main() {
  const server = spawn('node', ['server-1bac.js'], {
    env: {
      ...process.env,
      PORT,
      QUIZ_TEST_MODE: 'open',
      QUIZ_TEST_REMAINING_SECONDS: '1800'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  server.stdout.on('data', chunk => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', chunk => {
    serverOutput += chunk.toString();
  });

  const sockets = [];
  try {
    const health = await waitForHealth(server);

    const teacher = connectSocket();
    const student = connectSocket();
    sockets.push(teacher, student);

    teacher.emit('teacher:join');
    await waitForEvent(teacher, 'teacher:state');

    student.emit('student:join', {
      name: 'Smoke Test Student',
      number: '101',
      studentClass: '1BACSE4',
      translationOk: true
    });

    const joined = await waitForEvent(student, 'student:joined');
    if (joined.totalQuestions !== 10) fail(`Expected 10 questions, got ${joined.totalQuestions}.`);

    const seenQuestionIds = new Set();
    for (let i = 0; i < 10; i++) {
      const question = await waitForEvent(student, 'game:question');
      if (question.total !== 10) fail(`Question ${i + 1} reported total ${question.total}.`);
      if (question.number !== i + 1) fail(`Expected question number ${i + 1}, got ${question.number}.`);
      if (!Array.isArray(question.options) || question.options.length !== 4) {
        fail(`Question ${question.id} does not have exactly 4 options.`);
      }
      seenQuestionIds.add(question.id);

      student.emit('student:answer', {
        questionId: question.id,
        choiceIndex: 0,
        token: joined.token,
        translationOk: true
      });
      await waitForEvent(student, 'student:answerReceived');
    }

    const finished = await waitForEvent(student, 'game:finished');
    const studentResult = finished.leaderboard.find(player => player.id === joined.id);
    if (!studentResult) fail('Finished leaderboard did not include the test student.');
    if (studentResult.status !== 'active') fail(`Expected active status after finish, got ${studentResult.status}.`);
    if (studentResult.quizStatus !== 'finished') fail(`Expected finished quizStatus, got ${studentResult.quizStatus}.`);
    if (studentResult.score < 0 || studentResult.score > 5) fail(`Score out of range: ${studentResult.score}.`);

    const { player: teacherPlayer } = await waitForTeacherPlayer(teacher, 'Smoke Test Student');
    if (teacherPlayer.status !== 'active') fail(`Teacher state marked student as ${teacherPlayer.status}.`);
    if (teacherPlayer.quizStatus !== 'finished') {
      fail(`Teacher state expected finished quizStatus, got ${teacherPlayer.quizStatus}.`);
    }

    console.log(JSON.stringify({
      ok: true,
      health: health.windowStatus,
      questionsAnswered: seenQuestionIds.size,
      score: studentResult.score,
      teacherStatus: teacherPlayer.status,
      teacherQuizStatus: teacherPlayer.quizStatus
    }, null, 2));
  } finally {
    sockets.forEach(socket => socket.close());
    server.kill('SIGTERM');
    await delay(250);
    if (server.exitCode === null) server.kill('SIGKILL');
    if (process.env.SHOW_SERVER_OUTPUT === '1') {
      console.error(serverOutput);
    }
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
