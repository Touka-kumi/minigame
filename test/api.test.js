import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ROUND_DURATION_MS } from '../lib/algorithm.js';
import { createAppServer } from '../server.js';

async function startTestServer(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snow-bet-api-'));
  const dataFile = path.join(dir, 'wallet.json');
  let now = 1_760_000_000_000;
  const { server, stopTicker } = await createAppServer({
    dataFile,
    now: () => now,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await stopTicker();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await rm(dir, { recursive: true, force: true });
  });

  return {
    base,
    setNow(value) {
      now = value;
    },
  };
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

function postJson(url, payload) {
  return jsonRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('状态、充值、下单、周期结算与猜数字接口闭环', async (t) => {
  const { base, setNow } = await startTestServer(t);

  const health = await jsonRequest(`${base}/api/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const initial = await jsonRequest(`${base}/api/state?uid=demo`);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.state.balance, 10000);
  assert.equal(initial.body.state.round.endAt - initial.body.state.round.startAt, ROUND_DURATION_MS);
  assert.equal(initial.body.state.round.bettingEndsAt, initial.body.state.round.endAt - 5000);
  assert.equal(initial.body.state.round.maxBetsPerRound, 20);
  assert.equal(initial.body.state.lastRound, null);
  assert.equal(initial.body.state.config.betTypes.length, 8);

  const recharge = await postJson(`${base}/api/recharge?uid=demo`, { amount: 5000 });
  assert.equal(recharge.response.status, 200);
  assert.equal(recharge.body.credited, 5000);
  assert.equal(recharge.body.state.balance, 15000);

  const guessOne = await postJson(`${base}/api/bet?uid=demo`, {
    type: '猜数字',
    amount: 100,
    position: 1,
    digit: 3,
  });
  assert.equal(guessOne.response.status, 200);
  assert.equal(guessOne.body.state.balance, 14900);
  assert.equal(guessOne.body.state.round.myBetCount, 1);
  assert.equal(guessOne.body.state.round.myBetType, '猜数字');

  const guessTwo = await postJson(`${base}/api/bet?uid=demo`, {
    type: '猜数字',
    amount: 200,
    position: 2,
    digit: 7,
  });
  assert.equal(guessTwo.response.status, 200);
  assert.equal(guessTwo.body.state.balance, 14700);
  assert.equal(guessTwo.body.state.round.betCount, 2);

  const settledRoundId = guessTwo.body.state.round.id;
  setNow(guessTwo.body.state.round.endAt + 1);

  const settled = await jsonRequest(`${base}/api/state?uid=demo`);
  assert.equal(settled.body.state.lastRound.id, settledRoundId);
  assert.equal(settled.body.state.lastRound.betCount, 2);
  assert.equal(settled.body.state.lastRound.mine.betCount, 2);
  assert.equal(settled.body.state.lastRound.result.digits.length, 5);
  assert.equal(settled.body.state.round.id, settledRoundId + 1);
  assert.equal(settled.body.state.balance, 14700 + settled.body.state.lastRound.mine.payout);

  const history = await jsonRequest(`${base}/api/history?uid=demo&limit=10`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.total, 1);
  assert.equal(history.body.rounds[0].id, settledRoundId);
  assert.equal(history.body.rounds[0].totalStake, 300);
  assert.match(history.body.rounds[0].trace.seedNumber, /300$/);
  assert.equal(history.body.rounds[0].trace.hash.length, 64);
  assert.equal(history.body.rounds[0].trace.middle60.length, 60);
  assert.equal(history.body.rounds[0].trace.segments.length, 5);
  assert.equal(history.body.rounds[0].mine.betCount, 2);
  assert.equal(history.body.trend.length, 1);
  assert.equal(history.body.trend[0].id, settledRoundId);
  assert.ok(['大', '小', '和'].includes(history.body.trend[0].size));

  const badGuess = await postJson(`${base}/api/bet?uid=demo`, {
    type: '猜数字',
    amount: 100,
    position: 6,
    digit: 3,
  });
  assert.equal(badGuess.response.status, 400);

  const badAmount = await postJson(`${base}/api/bet?uid=demo`, { type: '大', amount: 150 });
  assert.equal(badAmount.response.status, 400);
});

test('非法玩法、同步码和未知接口返回 4xx', async (t) => {
  const { base } = await startTestServer(t);

  const badType = await postJson(`${base}/api/bet?uid=demo`, { type: '__proto__', amount: 100 });
  assert.equal(badType.response.status, 400);

  const first = await postJson(`${base}/api/bet?uid=demo`, { type: '大', amount: 100 });
  assert.equal(first.response.status, 200);
  const mixed = await postJson(`${base}/api/bet?uid=demo`, { type: '小', amount: 100 });
  assert.equal(mixed.response.status, 400);
  assert.match(mixed.body.error, /不能投注其他结果/);

  const badUid = await jsonRequest(`${base}/api/state?uid=${encodeURIComponent('../etc')}`);
  assert.equal(badUid.response.status, 400);

  const missing = await jsonRequest(`${base}/api/not-there?uid=demo`);
  assert.equal(missing.response.status, 404);
});

test('开奖前 5 秒封盘并提示等待开奖', async (t) => {
  const { base, setNow } = await startTestServer(t);
  const initial = await jsonRequest(`${base}/api/state?uid=demo`);
  const round = initial.body.state.round;

  setNow(round.bettingEndsAt);
  const locked = await postJson(`${base}/api/bet?uid=demo`, { type: '大', amount: 100 });
  assert.equal(locked.response.status, 400);
  assert.match(locked.body.error, /等待开奖/);

  setNow(round.endAt + 1);
  const next = await jsonRequest(`${base}/api/state?uid=demo`);
  assert.equal(next.body.state.lastRound.id, round.id);
  assert.equal(next.body.state.round.id, round.id + 1);
});

test('静态首页与安全响应头可访问', async (t) => {
  const { base } = await startTestServer(t);

  const response = await fetch(`${base}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /雪境 · 周期测试/);
  assert.match(html, /猜数字/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
