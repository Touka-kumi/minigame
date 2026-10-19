import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ROUND_DURATION_MS } from '../lib/algorithm.js';
import { WalletStore } from '../lib/store.js';

async function createTempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snow-bet-store-'));
  const dataFile = path.join(dir, 'wallet.json');
  let now = 1_760_000_000_000;
  const store = await new WalletStore({ dataFile, now: () => now }).init();
  return {
    dir,
    dataFile,
    store,
    get now() {
      return now;
    },
    setNow(value) {
      now = value;
    },
    advance(ms) {
      now += ms;
    },
  };
}

async function readSavedPlayers(dataFile) {
  const parsed = JSON.parse(await readFile(dataFile, 'utf8'));
  return parsed.players;
}

test('周期开始后可下注，跨期自动结算并持久化', async (t) => {
  const temp = await createTempStore();
  t.after(() => rm(temp.dir, { recursive: true, force: true }));

  const initial = temp.store.getPublicState('demo');
  assert.equal(initial.balance, 10000);
  assert.equal(initial.round.endAt - initial.round.startAt, ROUND_DURATION_MS);
  assert.equal(initial.round.bettingEndsAt, initial.round.endAt - 5000);
  assert.equal(initial.round.maxBetsPerRound, 20);
  assert.equal(initial.round.myBetCount, 0);
  assert.equal(initial.lastRound, null);

  await temp.store.recharge('demo', 5000);
  const first = await temp.store.placeBet('demo', { type: '大', amount: 100 });
  const second = await temp.store.placeBet('demo', { type: '大', amount: 200 });

  assert.equal(first.state.balance, 14900);
  assert.equal(second.state.balance, 14700);
  assert.equal(second.state.round.betCount, 2);
  assert.equal(second.state.round.myBetCount, 2);
  assert.equal(second.state.round.myStake, 300);
  assert.equal(second.state.round.myBetType, '大');

  const settledRoundId = second.state.round.id;
  temp.setNow(second.state.round.endAt + 1);
  const settled = await temp.store.getState('demo');

  assert.equal(settled.lastRound.id, settledRoundId);
  assert.equal(settled.lastRound.betCount, 2);
  assert.equal(settled.lastRound.mine.betCount, 2);
  assert.equal(settled.lastRound.mine.stake, 300);
  assert.equal(settled.lastRound.mine.payout, settled.balance - 14700);
  assert.equal(settled.lastRound.result.digits.length, 5);
  assert.equal(settled.lastRound.totalStake, 300);
  assert.equal(settled.round.id, settledRoundId + 1);
  assert.equal(settled.round.myBetCount, 0);

  const history = await temp.store.getHistory('demo', 10);
  assert.equal(history.total, 1);
  assert.equal(history.rounds[0].id, settledRoundId);
  assert.equal(history.rounds[0].totalStake, 300);
  assert.equal(history.rounds[0].trace.totalStake, 300);
  assert.equal(history.rounds[0].trace.seedInputs.totalStake, 300);
  assert.equal(history.rounds[0].trace.hash.length, 64);
  assert.equal(history.rounds[0].trace.middle60.length, 60);
  assert.equal(history.rounds[0].trace.segments.length, 5);
  assert.match(history.rounds[0].trace.seedNumber, /300$/);
  assert.equal(history.rounds[0].mine.betCount, 2);
  assert.equal(history.rounds[0].mine.items.length, 2);
  assert.equal(history.trend.length, 1);
  assert.equal(history.trend[0].id, settledRoundId);
  assert.ok(['大', '小', '和'].includes(history.trend[0].size));
  assert.ok(['单', '双'].includes(history.trend[0].parity));

  const saved = await readSavedPlayers(temp.dataFile);
  assert.equal(saved.demo.history.length, 2);
  assert.equal(saved.demo.balance, settled.balance);
  assert.ok(saved.demo.history.every((item) => ['win', 'lose'].includes(item.status)));

  const reloaded = await new WalletStore({ dataFile: temp.dataFile, now: () => temp.now }).init();
  const restored = reloaded.getPublicState('demo');
  assert.equal(restored.balance, settled.balance);
  assert.equal(restored.lastRound.id, settledRoundId);
  assert.deepEqual(restored.lastRound.result.digits, settled.lastRound.result.digits);
  const restoredHistory = await reloaded.getHistory('demo');
  assert.equal(restoredHistory.rounds[0].trace.seedNumber, history.rounds[0].trace.seedNumber);
  assert.equal(restoredHistory.rounds[0].trace.hash, history.rounds[0].trace.hash);
});

test('空期也会在 150 秒后生成开奖结果并进入下一期', async (t) => {
  const temp = await createTempStore();
  t.after(() => rm(temp.dir, { recursive: true, force: true }));

  const initial = temp.store.getPublicState('demo');
  temp.setNow(initial.round.endAt + 1);
  await temp.store.tick();
  const afterTick = await temp.store.getState('demo');

  assert.ok(afterTick.lastRound);
  assert.equal(afterTick.lastRound.betCount, 0);
  assert.equal(afterTick.lastRound.mine.betCount, 0);
  assert.equal(afterTick.lastRound.result.digits.length, 5);
  assert.equal(afterTick.lastRound.totalStake, 0);
  assert.equal(afterTick.round.id, initial.round.id + 1);
  assert.equal(afterTick.balance, 10000);

  const history = await temp.store.getHistory('demo');
  assert.equal(history.rounds[0].totalStake, 0);
  assert.equal(history.rounds[0].trace.seedInputs.totalStake, 0);
  assert.match(history.rounds[0].trace.seedNumber, /0$/);
  assert.equal(history.trend.length, 1);
});

test('走势数据按旧到新返回，最新一期排在最后', async (t) => {
  const temp = await createTempStore();
  t.after(() => rm(temp.dir, { recursive: true, force: true }));

  const initial = temp.store.getPublicState('demo');
  temp.setNow(initial.round.endAt + 1);
  await temp.store.tick();
  const secondRound = temp.store.getPublicState('demo').round;
  temp.setNow(secondRound.endAt + 1);
  await temp.store.tick();

  const history = await temp.store.getHistory('demo');
  assert.equal(history.trend.length, 2);
  assert.ok(history.trend[0].id < history.trend[1].id);
  assert.equal(history.trend[1].id, secondRound.id);
});

test('边界后的下单计入下一期，上一期同时完成结算', async (t) => {
  const temp = await createTempStore();
  t.after(() => rm(temp.dir, { recursive: true, force: true }));

  const first = await temp.store.placeBet('demo', { type: '小', amount: 500 });
  const firstRoundId = first.state.round.id;
  temp.setNow(first.state.round.endAt + 1000);
  const second = await temp.store.placeBet('demo', { type: '小', amount: 200 });

  assert.equal(second.state.lastRound.id, firstRoundId);
  assert.equal(second.state.round.id, firstRoundId + 1);
  assert.equal(second.state.round.myBetCount, 1);
  assert.equal(second.state.round.myStake, 200);
  assert.equal(second.state.lastRound.mine.betCount, 1);
});

test('同一期只能锁定一个普通结果，猜数字可更换位数和数字', async (t) => {
  const temp = await createTempStore();
  t.after(() => rm(temp.dir, { recursive: true, force: true }));

  const first = await temp.store.placeBet('demo', { type: '大', amount: 100 });
  await assert.rejects(
    temp.store.placeBet('demo', { type: '小', amount: 100 }),
    /不能投注其他结果/,
  );
  await assert.rejects(
    temp.store.placeBet('demo', { type: '猜数字', amount: 100, position: 1, digit: 3 }),
    /不能投注其他结果/,
  );
  const sameType = await temp.store.placeBet('demo', { type: '大', amount: 200 });
  assert.equal(sameType.state.round.myBetCount, 2);
  assert.equal(sameType.state.round.myBetType, '大');

  temp.setNow(first.state.round.endAt + 1);
  await temp.store.tick();
  const guessOne = await temp.store.placeBet('demo', {
    type: '猜数字',
    amount: 100,
    position: 1,
    digit: 1,
  });
  assert.equal(guessOne.state.round.myBetType, '猜数字');
  const guessTwo = await temp.store.placeBet('demo', {
    type: '猜数字',
    amount: 200,
    position: 2,
    digit: 2,
  });
  assert.equal(guessTwo.state.round.myBetCount, 2);
  await assert.rejects(
    temp.store.placeBet('demo', { type: '大', amount: 100 }),
    /已选择猜数字/,
  );
});

test('单期最多 20 笔，封盘前 5 秒拒绝下注，下一期重置', async (t) => {
  const temp = await createTempStore();
  t.after(() => rm(temp.dir, { recursive: true, force: true }));

  let last;
  for (let index = 0; index < 20; index += 1) {
    last = await temp.store.placeBet('demo', { type: '大', amount: 100 });
  }
  assert.equal(last.state.round.myBetCount, 20);
  assert.equal(last.state.round.myBetsRemaining, 0);
  await assert.rejects(
    temp.store.placeBet('demo', { type: '大', amount: 100 }),
    /最多投注 20 笔/,
  );

  const round = last.state.round;
  temp.setNow(round.bettingEndsAt);
  await assert.rejects(
    temp.store.placeBet('demo', { type: '大', amount: 100 }),
    /已封盘/,
  );

  temp.setNow(round.endAt + 1);
  await temp.store.tick();
  const next = temp.store.getPublicState('demo');
  assert.equal(next.round.myBetCount, 0);
  assert.equal(next.round.myBetType, null);
});

test('非法玩法、非法猜数字和余额不足都不会产生有效注单', async (t) => {
  const temp = await createTempStore();
  t.after(() => rm(temp.dir, { recursive: true, force: true }));

  await assert.rejects(
    temp.store.placeBet('demo', { type: '__proto__', amount: 100 }),
    /有效玩法/,
  );
  await assert.rejects(
    temp.store.placeBet('demo', { type: '猜数字', amount: 100, position: 0, digit: 3 }),
    /位数/,
  );
  await assert.rejects(
    temp.store.placeBet('demo', { type: '猜数字', amount: 100, position: 2, digit: 10 }),
    /数字/,
  );

  const bigBet = await temp.store.placeBet('demo', { type: '大', amount: 10000 });
  assert.equal(bigBet.state.balance, 0);
  assert.equal(bigBet.state.round.betCount, 1);

  await assert.rejects(temp.store.placeBet('demo', { type: '小', amount: 100 }), /余额不足/);
  const state = temp.store.getPublicState('demo');
  assert.equal(state.round.betCount, 1);
  assert.equal(state.balance, 0);
});

test('旧版数据会保留余额并迁移到周期制', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snow-bet-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'wallet.json');
  await writeFile(
    dataFile,
    JSON.stringify({
      schemaVersion: 1,
      players: { demo: { balance: 4321, history: [] } },
    }),
    'utf8',
  );

  const store = await new WalletStore({ dataFile, now: () => 1_760_000_000_000 }).init();
  const state = store.getPublicState('demo');
  assert.equal(state.balance, 4321);
  assert.equal(state.round.endAt - state.round.startAt, ROUND_DURATION_MS);
  assert.equal(state.lastRound, null);
});

test('上一版本的 lastRound 会迁移为可追溯的期次历史', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snow-bet-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'wallet.json');
  const now = 1_760_000_000_000;
  const slot = Math.floor(now / ROUND_DURATION_MS);
  const startAt = slot * ROUND_DURATION_MS;
  const endAt = startAt + ROUND_DURATION_MS;

  await writeFile(
    dataFile,
    JSON.stringify({
      schemaVersion: 2,
      players: { demo: { balance: 9900, history: [] } },
      currentRound: {
        id: slot,
        startAt,
        endAt,
        createdAt: startAt,
        bets: [],
        betCount: 0,
        totalStake: 0,
        lastBetAt: null,
      },
      lastRound: {
        id: slot - 1,
        startAt: startAt - ROUND_DURATION_MS,
        endAt: startAt,
        settledAt: startAt,
        betCount: 1,
        totalStake: 100,
        result: {
          pickedDigits: [1, 2, 3, 4, 5],
          sum: 15,
          size: '小',
          parity: '单',
          outcome: '小单',
          effectiveQty: 20,
          hash: 'a'.repeat(64),
          seedTimeMs: startAt - 1000,
        },
        settlements: [
          {
            uid: 'demo',
            betId: 'legacy-bet',
            betType: '大',
            amount: 100,
            status: 'lose',
            matched: false,
            multiplier: 1.8,
            payout: 0,
            profit: -100,
            balanceAfter: 9900,
          },
        ],
      },
    }),
    'utf8',
  );

  const store = await new WalletStore({ dataFile, now: () => now }).init();
  const history = await store.getHistory('demo');
  assert.equal(history.total, 1);
  assert.equal(history.rounds[0].id, slot - 1);
  assert.equal(history.rounds[0].lastBetAt, startAt - 1000);
  assert.equal(history.rounds[0].trace.hash, 'a'.repeat(64));
  assert.equal(history.rounds[0].mine.betCount, 1);
  assert.equal(history.rounds[0].mine.items[0].betId, 'legacy-bet');
  assert.equal(history.trend[0].outcome, '小单');
});

test('无效同步码不会影响账户数据', async (t) => {
  const temp = await createTempStore();
  t.after(() => rm(temp.dir, { recursive: true, force: true }));

  assert.throws(() => temp.store.getPublicState('../etc'), /同步码/);
  assert.throws(() => temp.store.getPublicState('a'.repeat(33)), /同步码/);
  assert.equal(temp.store.getPublicState('player_01').uid, 'player_01');
  assert.equal(temp.store.getPublicState('__proto__').balance, 10000);
});
