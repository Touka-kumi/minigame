import { createHash, randomInt as cryptoRandomInt } from 'node:crypto';

export const ROUND_DURATION_MS = 150_000;
export const BETTING_LOCK_MS = 5_000;
export const MAX_BETS_PER_ROUND = 20;
export const SEGMENT_COUNT = 5;
export const SEGMENT_LENGTH = 12;
export const MIDDLE_RANGE = Object.freeze([22, 23]);
export const INITIAL_BALANCE = 10000;
export const MAX_BALANCE = 1_000_000_000;
export const MAX_RECHARGE = 100_000;

export const BET_AMOUNTS = Object.freeze([100, 200, 500, 1000, 2000, 5000, 10000]);
// 末位用于索引，索引 0 会取第 10 位，因此保留 11 位，
// 避免第 10 位恰好又是末位造成 0 被自取、概率偏大。
export const SEGMENT_DECIMAL_DIGITS = 11;

/**
 * multiplier 表示“命中后的返还总额倍数”（包含本金）。
 * 按五位数组合概率定价，整体保留约 3%–4% 的庄家优势。
 * 大/小/单/双：44% → 2.2×
 * 大单：20.508% → 4.7×；小单：23.492% → 4.1×
 * 和值：12% → 8.0×；猜数字：10% → 9.7×
 */
export const BET_TYPES = Object.freeze({
  大: { label: '大', multiplier: 2.2, family: 'size', desc: '和值 24–45' },
  小: { label: '小', multiplier: 2.2, family: 'size', desc: '和值 0–21' },
  单: { label: '单', multiplier: 2.2, family: 'parity', desc: '和值为单数' },
  双: { label: '双', multiplier: 2.2, family: 'parity', desc: '和值为双数' },
  大单: { label: '大单', multiplier: 4.7, family: 'combo', desc: '大 · 单' },
  小单: { label: '小单', multiplier: 4.1, family: 'combo', desc: '小 · 单' },
  和值: { label: '和值', multiplier: 8, family: 'middle', desc: '和值 22–23' },
  猜数字: { label: '猜数字', multiplier: 9.7, family: 'digit', desc: '猜中五位结果中对应位的数字' },
});

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function assertInteger(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${name} 必须是整数`);
  }
  return value;
}

export function getRoundSlot(timestamp) {
  assertInteger(timestamp, '时间');
  if (timestamp < 0) throw new ValidationError('时间不能为负数');
  return Math.floor(timestamp / ROUND_DURATION_MS);
}

export function getRoundWindow(slot) {
  assertInteger(slot, '期号');
  const startAt = slot * ROUND_DURATION_MS;
  const endAt = startAt + ROUND_DURATION_MS;
  return {
    id: slot,
    startAt,
    endAt,
    bettingEndsAt: endAt - BETTING_LOCK_MS,
    bettingLockMs: BETTING_LOCK_MS,
    durationMs: ROUND_DURATION_MS,
  };
}

/**
 * 下单数少于 20 时，加入 [20 - 下单数, 100] 的随机补偿量。
 * 空期允许 orderNo = 0，此时补偿区间为 [20, 100]。
 */
export function adjustOrderQuantity(orderNo, randomInt = cryptoRandomInt) {
  assertInteger(orderNo, '下单数');
  if (orderNo < 0) throw new ValidationError('下单数不能为负数');

  if (orderNo >= 20) {
    return {
      adjusted: false,
      orderNo,
      randomOffset: 0,
      range: null,
      effectiveQty: orderNo,
    };
  }

  const min = 20 - orderNo;
  const max = 100;
  const randomOffset = randomInt(min, max + 1);
  if (!Number.isInteger(randomOffset) || randomOffset < min || randomOffset > max) {
    throw new Error(`随机补偿量越界：${randomOffset}，应在 ${min}–${max}`);
  }

  return {
    adjusted: true,
    orderNo,
    randomOffset,
    range: [min, max],
    effectiveQty: orderNo + randomOffset,
  };
}

export function normalizeGuess(guess) {
  if (!guess || typeof guess !== 'object') {
    throw new ValidationError('猜数字需要选择位数和数字');
  }
  const position = Number(guess.position);
  const digit = Number(guess.digit);
  if (!Number.isInteger(position) || position < 1 || position > SEGMENT_COUNT) {
    throw new ValidationError('猜数字的位数必须是 1–5');
  }
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
    throw new ValidationError('猜数字的数字必须是 0–9');
  }
  return { position, digit };
}

export function validateBet(type, amount, balance, guess) {
  if (!Object.hasOwn(BET_TYPES, type)) throw new ValidationError('请选择有效玩法');
  assertInteger(amount, '投注金额');
  if (!BET_AMOUNTS.includes(amount)) throw new ValidationError('请选择有效投注金额');
  assertInteger(balance, '余额');
  if (amount > balance) throw new ValidationError('金币余额不足，请先充值');

  if (type === '猜数字') return normalizeGuess(guess);
  return null;
}

export function validateRecharge(amount) {
  assertInteger(amount, '充值金额');
  if (amount < 1 || amount > MAX_RECHARGE) {
    throw new ValidationError(`单次充值需在 1–${MAX_RECHARGE} 金币之间`);
  }
  return amount;
}

export function matchBet(type, outcome, guess) {
  if (type === '猜数字') {
    return Boolean(guess && outcome.pickedDigits?.[guess.position - 1] === guess.digit);
  }
  if (type === '和值') return outcome.size === '和';
  if (type === '大单') return outcome.size === '大' && outcome.parity === '单';
  if (type === '小单') return outcome.size === '小' && outcome.parity === '单';
  if (type === '大') return outcome.size === '大';
  if (type === '小') return outcome.size === '小';
  if (type === '单') return outcome.parity === '单' && outcome.size !== '和';
  if (type === '双') return outcome.parity === '双' && outcome.size !== '和';
  return false;
}

/**
 * 一注结算。命中返还总额 = 本金 × multiplier，未命中返还 0。
 */
export function settleBet(bet, outcome) {
  const type = bet?.type;
  if (!Object.hasOwn(BET_TYPES, type)) throw new ValidationError('未知玩法');
  const amount = bet.amount;
  assertInteger(amount, '投注金额');
  if (amount <= 0) throw new ValidationError('投注金额必须大于 0');

  const spec = BET_TYPES[type];
  const guess = type === '猜数字' ? normalizeGuess(bet) : null;
  const matched = matchBet(type, outcome, guess);
  const payout = matched ? Math.round(amount * spec.multiplier) : 0;

  return {
    status: matched ? 'win' : 'lose',
    matched,
    multiplier: spec.multiplier,
    payout,
    profit: payout - amount,
    guess,
  };
}

/**
 * 核心算法：
 * 1. 下单数、上一单毫秒时间、本期投入金币总数拼接成种子数字；
 * 2. SHA-256 => 64 位十六进制哈希；
 * 3. 去掉首尾各 2 位，取中间 60 位，拆成 5 段 × 12 位；
 * 4. 每段转成十进制，取末位作为 1-based 索引（0 视为第 10 位）；
 * 5. 5 个选中数字求和，24–45 大、0–21 小、22–23 和值。
 */
export function generateOutcome({
  orderNo,
  lastOrderAt,
  totalStake = 0,
  randomInt = cryptoRandomInt,
}) {
  assertInteger(orderNo, '下单数');
  assertInteger(lastOrderAt, '上一单时间');
  assertInteger(totalStake, '投入金币总数');
  if (lastOrderAt < 0) throw new ValidationError('上一单时间不能为负数');
  if (totalStake < 0) throw new ValidationError('投入金币总数不能为负数');

  const adjustment = adjustOrderQuantity(orderNo, randomInt);
  const seedNumber = `${adjustment.effectiveQty}${lastOrderAt}${totalStake}`;
  const hash = createHash('sha256').update(seedNumber, 'utf8').digest('hex');
  const middle60 = hash.slice(2, 62);

  const segments = [];
  for (let index = 0; index < SEGMENT_COUNT; index += 1) {
    const hex = middle60.slice(index * SEGMENT_LENGTH, (index + 1) * SEGMENT_LENGTH);
    // 48 位值不可能均匀覆盖完整的 15 位十进制范围。
    // 取低 11 位可得到近似均匀的 11 位数字串，避免前导补零导致 0/1/2 过采样；
    // 最后一位仍作索引，取第 1–10 位，不会取到自身。
    const decimal = (BigInt(`0x${hex}`) % 100_000_000_000n)
      .toString()
      .padStart(SEGMENT_DECIMAL_DIGITS, '0');
    const baseDigit = Number(decimal.at(-1));
    const takePosition = baseDigit === 0 ? 10 : baseDigit;
    const picked = Number(decimal[takePosition - 1]);

    segments.push({
      index: index + 1,
      hex,
      decimal,
      baseDigit,
      takePosition,
      picked,
    });
  }

  const pickedDigits = segments.map((segment) => segment.picked);
  const sum = pickedDigits.reduce((total, digit) => total + digit, 0);
  const size = sum >= 24 ? '大' : sum <= 21 ? '小' : '和';
  const parity = sum % 2 === 0 ? '双' : '单';
  const outcome = size === '和' ? '和值' : `${size}${parity}`;

  return {
    algorithmVersion: 'sha256-middle60-5seg-uniform11-round-v4-stake',
    seedNumber,
    seedInputs: {
      effectiveQty: adjustment.effectiveQty,
      lastOrderAt,
      totalStake,
    },
    seedTimeMs: lastOrderAt,
    seedTimeFractionMs: lastOrderAt % 1000,
    totalStake,
    effectiveQty: adjustment.effectiveQty,
    adjustment,
    hash,
    middle60,
    segments,
    pickedDigits,
    sum,
    midpoint: 22.5,
    middleRange: [...MIDDLE_RANGE],
    size,
    parity,
    outcome,
  };
}
