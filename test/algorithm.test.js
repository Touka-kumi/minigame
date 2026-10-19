import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BET_AMOUNTS,
  BET_TYPES,
  BETTING_LOCK_MS,
  MAX_BETS_PER_ROUND,
  MIDDLE_RANGE,
  ROUND_DURATION_MS,
  SEGMENT_COUNT,
  adjustOrderQuantity,
  generateOutcome,
  getRoundSlot,
  getRoundWindow,
  matchBet,
  normalizeGuess,
  settleBet,
  validateBet,
  validateRecharge,
} from '../lib/algorithm.js';

const FIXED_TIME = 1_760_000_000_123;

test('周期固定为 150 秒，最后 5 秒停止接单，单期最多 20 笔', () => {
  assert.equal(ROUND_DURATION_MS, 150000);
  assert.equal(BETTING_LOCK_MS, 5000);
  assert.equal(MAX_BETS_PER_ROUND, 20);
  const slot = getRoundSlot(FIXED_TIME);
  const window = getRoundWindow(slot);
  assert.ok(FIXED_TIME >= window.startAt && FIXED_TIME < window.endAt);
  assert.equal(window.endAt - window.startAt, 150000);
  assert.equal(window.bettingEndsAt, window.endAt - 5000);
  assert.equal(window.bettingLockMs, 5000);
  assert.equal(getRoundSlot(window.endAt), slot + 1);
});

test('倍率按真实组合概率定价，并保留约 3%–4% 庄家优势', () => {
  assert.equal(BET_TYPES['大'].multiplier, 2.2);
  assert.equal(BET_TYPES['小'].multiplier, 2.2);
  assert.equal(BET_TYPES['单'].multiplier, 2.2);
  assert.equal(BET_TYPES['双'].multiplier, 2.2);
  assert.equal(BET_TYPES['大单'].multiplier, 4.7);
  assert.equal(BET_TYPES['小单'].multiplier, 4.1);
  assert.equal(BET_TYPES['和值'].multiplier, 8);
  assert.equal(BET_TYPES['猜数字'].multiplier, 9.7);
  assert.equal(BET_TYPES['大双'], undefined);
  assert.equal(BET_TYPES['小双'], undefined);

  assert.ok(Math.abs(2.2 * 0.44 - 0.968) < 1e-12);
  assert.ok(Math.abs(4.7 * 0.20508 - 0.963876) < 1e-12);
  assert.ok(Math.abs(4.1 * 0.23492 - 0.963172) < 1e-12);
  assert.ok(Math.abs(8 * 0.12 - 0.96) < 1e-12);
  assert.ok(Math.abs(9.7 * 0.1 - 0.97) < 1e-12);
});

test('下单数小于 20 时加入指定区间内的随机补偿，空期也适用', () => {
  let receivedMin;
  let receivedMax;
  const result = adjustOrderQuantity(3, (min, max) => {
    receivedMin = min;
    receivedMax = max;
    return min;
  });
  assert.equal(receivedMin, 17);
  assert.equal(receivedMax, 101);
  assert.equal(result.effectiveQty, 20);
  assert.deepEqual(result.range, [17, 100]);

  const emptyRound = adjustOrderQuantity(0, (min, max) => {
    assert.equal(min, 20);
    assert.equal(max, 101);
    return 20;
  });
  assert.equal(emptyRound.effectiveQty, 20);

  const capped = adjustOrderQuantity(20, () => {
    throw new Error('不应该调用随机源');
  });
  assert.equal(capped.adjusted, false);
  assert.equal(capped.effectiveQty, 20);
});

test('核心算法把总投入金币加入种子，并生成 64 位哈希与 5 段切片', () => {
  const outcome = generateOutcome({
    orderNo: 0,
    lastOrderAt: FIXED_TIME,
    totalStake: 12300,
    randomInt: (min) => min,
  });

  assert.equal(outcome.seedNumber, `20${FIXED_TIME}12300`);
  assert.deepEqual(outcome.seedInputs, {
    effectiveQty: 20,
    lastOrderAt: FIXED_TIME,
    totalStake: 12300,
  });
  assert.equal(outcome.totalStake, 12300);
  assert.equal(outcome.algorithmVersion, 'sha256-middle60-5seg-uniform11-round-v4-stake');
  assert.equal(outcome.hash.length, 64);
  assert.match(outcome.hash, /^[0-9a-f]{64}$/);
  assert.equal(outcome.middle60, outcome.hash.slice(2, 62));
  assert.equal(outcome.middle60.length, 60);
  assert.equal(outcome.segments.length, SEGMENT_COUNT);

  for (const segment of outcome.segments) {
    assert.equal(segment.hex.length, 12);
    assert.equal(segment.decimal.length, 11);
    assert.equal(segment.baseDigit, Number(segment.decimal.at(-1)));
    assert.equal(segment.takePosition, segment.baseDigit === 0 ? 10 : segment.baseDigit);
    assert.ok(segment.takePosition >= 1 && segment.takePosition <= 10);
    assert.equal(segment.picked, Number(segment.decimal[segment.takePosition - 1]));
    assert.ok(segment.picked >= 0 && segment.picked <= 9);
  }

  assert.equal(
    outcome.pickedDigits.reduce((total, digit) => total + digit, 0),
    outcome.sum,
  );
  assert.deepEqual(outcome.middleRange, [...MIDDLE_RANGE]);
  assert.equal(outcome.outcome, outcome.size === '和' ? '和值' : `${outcome.size}${outcome.parity}`);

  const differentStake = generateOutcome({
    orderNo: 0,
    lastOrderAt: FIXED_TIME,
    totalStake: 12400,
    randomInt: (min) => min,
  });
  assert.notEqual(differentStake.hash, outcome.hash);
  assert.notEqual(differentStake.seedNumber, outcome.seedNumber);
});

test('和值、大小、单双与组合玩法的命中判断正确', () => {
  const bigEven = { size: '大', parity: '双', outcome: '大双', pickedDigits: [1, 2, 3, 4, 5] };
  const bigOdd = { size: '大', parity: '单', outcome: '大单', pickedDigits: [1, 2, 3, 4, 5] };
  const smallOdd = { size: '小', parity: '单', outcome: '小单', pickedDigits: [1, 2, 3, 4, 5] };
  const middle = { size: '和', parity: '双', outcome: '和值', pickedDigits: [1, 2, 3, 4, 5] };

  assert.equal(matchBet('大', bigEven), true);
  assert.equal(matchBet('双', bigEven), true);
  assert.equal(matchBet('大单', bigEven), false);
  assert.equal(matchBet('大单', bigOdd), true);
  assert.equal(matchBet('小单', smallOdd), true);
  assert.equal(matchBet('和值', middle), true);
  assert.equal(matchBet('大', middle), false);
  assert.equal(matchBet('双', middle), false);
  assert.equal(matchBet('猜数字', bigOdd, { position: 3, digit: 3 }), true);
  assert.equal(matchBet('猜数字', bigOdd, { position: 2, digit: 3 }), false);
});

test('命中返还总额按真实概率倍率结算', () => {
  const bigEven = { size: '大', parity: '双', outcome: '大双', pickedDigits: [3, 7, 1, 0, 5] };
  const middle = { size: '和', parity: '双', outcome: '和值', pickedDigits: [3, 7, 1, 0, 5] };

  const big = settleBet({ type: '大', amount: 100 }, bigEven);
  assert.equal(big.status, 'win');
  assert.equal(big.payout, 220);
  assert.equal(big.profit, 120);

  const combo = settleBet({ type: '大单', amount: 100 }, bigEven);
  assert.equal(combo.status, 'lose');
  assert.equal(combo.payout, 0);
  assert.equal(combo.profit, -100);

  const middleBet = settleBet({ type: '和值', amount: 100 }, middle);
  assert.equal(middleBet.status, 'win');
  assert.equal(middleBet.payout, 800);
  assert.equal(middleBet.profit, 700);

  const guess = settleBet({ type: '猜数字', amount: 200, position: 2, digit: 7 }, bigEven);
  assert.equal(guess.status, 'win');
  assert.equal(guess.payout, 1940);
  assert.equal(guess.profit, 1740);
});

test('投注参数与猜数字范围会校验非法值', () => {
  assert.throws(() => validateBet('中', 100, 1000), /有效玩法/);
  assert.throws(() => validateBet('__proto__', 100, 1000), /有效玩法/);
  assert.throws(() => validateBet('大', 150, 1000), /有效投注金额/);
  assert.throws(() => validateBet('大', 100, 50), /余额不足/);
  assert.equal(validateBet('大', BET_AMOUNTS[0], 1000), null);
  assert.throws(
    () => generateOutcome({ orderNo: 20, lastOrderAt: FIXED_TIME, totalStake: -1 }),
    /投入金币总数/,
  );

  assert.deepEqual(validateBet('猜数字', 100, 1000, { position: 3, digit: 7 }), {
    position: 3,
    digit: 7,
  });
  assert.throws(() => validateBet('猜数字', 100, 1000), /位数和数字/);
  assert.throws(() => normalizeGuess({ position: 0, digit: 5 }), /位数/);
  assert.throws(() => normalizeGuess({ position: 1, digit: 10 }), /数字/);

  assert.throws(() => validateRecharge(0), /充值/);
  assert.throws(() => validateRecharge(100_001), /充值/);
  assert.equal(validateRecharge(1000), 1000);
});
