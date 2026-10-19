import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BET_AMOUNTS,
  BET_TYPES,
  BETTING_LOCK_MS,
  INITIAL_BALANCE,
  MAX_BALANCE,
  MAX_BETS_PER_ROUND,
  MAX_RECHARGE,
  ROUND_DURATION_MS,
  ValidationError,
  generateOutcome,
  getRoundSlot,
  getRoundWindow,
  settleBet,
  validateBet,
  validateRecharge,
} from './algorithm.js';

const SCHEMA_VERSION = 2;
const HISTORY_LIMIT = 150;
const ROUND_HISTORY_LIMIT = 100;
const UID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function normalizeUid(value) {
  const uid = String(value ?? 'demo').trim();
  if (!UID_PATTERN.test(uid)) {
    throw new ValidationError('同步码只能包含字母、数字、下划线或短横线（1–32 位）');
  }
  return uid;
}

function finiteInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) ? value : fallback;
}

function clampBalance(value) {
  return Math.max(0, Math.min(MAX_BALANCE, finiteInteger(value, INITIAL_BALANCE)));
}

function createPlayer(uid, now, balance = INITIAL_BALANCE) {
  return {
    uid,
    balance: clampBalance(balance),
    createdAt: now,
    updatedAt: now,
    history: [],
  };
}

function createRound(slot, now) {
  const window = getRoundWindow(slot);
  return {
    id: window.id,
    startAt: window.startAt,
    endAt: window.endAt,
    createdAt: now,
    bets: [],
    betCount: 0,
    totalStake: 0,
    lastBetAt: null,
  };
}

function createEmptyState(now) {
  const players = Object.create(null);
  players.demo = createPlayer('demo', now);
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    players,
    currentRound: createRound(getRoundSlot(now), now),
    roundHistory: [],
  };
}

function normalizePlayer(raw, uid, now) {
  if (!raw || typeof raw !== 'object') return createPlayer(uid, now);
  const player = createPlayer(uid, now, raw.balance);
  player.createdAt = finiteInteger(raw.createdAt, now);
  player.updatedAt = finiteInteger(raw.updatedAt, now);
  player.history = Array.isArray(raw.history)
    ? raw.history.filter((item) => item && typeof item === 'object').slice(0, HISTORY_LIMIT)
    : [];
  return player;
}

function normalizeBet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!UID_PATTERN.test(String(raw.uid || ''))) return null;
  if (!Object.hasOwn(BET_TYPES, raw.type)) return null;
  if (!BET_AMOUNTS.includes(raw.amount)) return null;
  if (!Number.isSafeInteger(raw.placedAt)) return null;

  let position = null;
  let digit = null;
  if (raw.type === '猜数字') {
    if (!Number.isInteger(raw.position) || raw.position < 1 || raw.position > 5) return null;
    if (!Number.isInteger(raw.digit) || raw.digit < 0 || raw.digit > 9) return null;
    position = raw.position;
    digit = raw.digit;
  }

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    uid: raw.uid,
    type: raw.type,
    amount: raw.amount,
    position,
    digit,
    placedAt: raw.placedAt,
  };
}

function normalizeCurrentRound(raw, now) {
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id < 0) {
    return createRound(getRoundSlot(now), now);
  }
  const window = getRoundWindow(raw.id);
  const bets = Array.isArray(raw.bets) ? raw.bets.map(normalizeBet).filter(Boolean) : [];
  let totalStake = 0;
  let lastBetAt = null;
  for (const bet of bets) {
    totalStake += bet.amount;
    if (lastBetAt === null || bet.placedAt > lastBetAt) lastBetAt = bet.placedAt;
  }
  return {
    id: window.id,
    startAt: window.startAt,
    endAt: window.endAt,
    createdAt: finiteInteger(raw.createdAt, now),
    bets,
    betCount: bets.length,
    totalStake,
    lastBetAt,
  };
}

function normalizeSettlement(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!UID_PATTERN.test(String(raw.uid || ''))) return null;
  if (!Object.hasOwn(BET_TYPES, raw.betType)) return null;
  if (!BET_AMOUNTS.includes(raw.amount)) return null;
  if (!['win', 'lose'].includes(raw.status)) return null;
  return {
    uid: raw.uid,
    betId: typeof raw.betId === 'string' ? raw.betId : '',
    betType: raw.betType,
    amount: raw.amount,
    position: Number.isInteger(raw.position) ? raw.position : null,
    digit: Number.isInteger(raw.digit) ? raw.digit : null,
    status: raw.status,
    matched: Boolean(raw.matched),
    multiplier: Number(raw.multiplier) || BET_TYPES[raw.betType].multiplier,
    payout: Math.max(0, finiteInteger(raw.payout, 0)),
    profit: finiteInteger(raw.profit, 0),
    balanceAfter: clampBalance(raw.balanceAfter),
  };
}

function normalizeLastRound(raw) {
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id < 0) return null;
  const result = raw.result;
  if (!result || !Array.isArray(result.pickedDigits) || result.pickedDigits.length !== 5) return null;
  if (!result.pickedDigits.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9)) {
    return null;
  }
  if (!Number.isSafeInteger(result.sum)) return null;
  if (!['大', '小', '和'].includes(result.size)) return null;
  if (!['单', '双'].includes(result.parity)) return null;
  if (!['大单', '大双', '小单', '小双', '和值'].includes(result.outcome)) return null;

  const window = getRoundWindow(raw.id);
  const settlements = Array.isArray(raw.settlements)
    ? raw.settlements.map(normalizeSettlement).filter(Boolean)
    : [];
  const lastBetAt = Number.isSafeInteger(raw.lastBetAt)
    ? raw.lastBetAt
    : finiteInteger(raw.betCount, 0) > 0 && Number.isSafeInteger(result.seedTimeMs)
      ? result.seedTimeMs
      : null;
  const segments = Array.isArray(result.segments)
    ? result.segments
        .filter(
          (segment) =>
            segment &&
            Number.isInteger(segment.index) &&
            typeof segment.hex === 'string' &&
            typeof segment.decimal === 'string' &&
            Number.isInteger(segment.baseDigit) &&
            Number.isInteger(segment.takePosition) &&
            Number.isInteger(segment.picked),
        )
        .map((segment) => ({
          index: segment.index,
          hex: segment.hex,
          decimal: segment.decimal,
          baseDigit: segment.baseDigit,
          takePosition: segment.takePosition,
          picked: segment.picked,
        }))
    : [];

  return {
    id: window.id,
    startAt: window.startAt,
    endAt: window.endAt,
    settledAt: finiteInteger(raw.settledAt, window.endAt),
    lastBetAt,
    result: {
      pickedDigits: result.pickedDigits,
      sum: result.sum,
      size: result.size,
      parity: result.parity,
      outcome: result.outcome,
      effectiveQty: finiteInteger(result.effectiveQty, 0),
      adjustment: result.adjustment && typeof result.adjustment === 'object' ? result.adjustment : null,
      hash: typeof result.hash === 'string' ? result.hash : '',
      middle60: typeof result.middle60 === 'string' ? result.middle60 : '',
      seedNumber: typeof result.seedNumber === 'string' ? result.seedNumber : '',
      seedTimeMs: finiteInteger(result.seedTimeMs, lastBetAt ?? window.startAt),
      totalStake: Math.max(0, finiteInteger(result.totalStake, finiteInteger(raw.totalStake, 0))),
      segments,
      algorithmVersion:
        typeof result.algorithmVersion === 'string' ? result.algorithmVersion : '',
      seedInputs:
        result.seedInputs && typeof result.seedInputs === 'object' ? result.seedInputs : null,
    },
    betCount: Math.max(0, finiteInteger(raw.betCount, settlements.length)),
    totalStake: Math.max(0, finiteInteger(raw.totalStake, 0)),
    settlements,
  };
}

function normalizeState(parsed, now) {
  if (!parsed || typeof parsed !== 'object' || !parsed.players || typeof parsed.players !== 'object') {
    throw new Error('数据文件结构无效');
  }

  const players = Object.create(null);
  for (const [uid, rawPlayer] of Object.entries(parsed.players)) {
    if (!UID_PATTERN.test(uid)) continue;
    players[uid] = normalizePlayer(rawPlayer, uid, now);
  }
  if (!players.demo) players.demo = createPlayer('demo', now);

  const historySource = Array.isArray(parsed.roundHistory) ? [...parsed.roundHistory] : [];
  if (historySource.length === 0 && parsed.lastRound) historySource.push(parsed.lastRound);
  const roundHistory = historySource
    .map(normalizeLastRound)
    .filter(Boolean)
    .slice(0, ROUND_HISTORY_LIMIT);

  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: finiteInteger(parsed.createdAt, now),
    updatedAt: finiteInteger(parsed.updatedAt, now),
    players,
    currentRound: normalizeCurrentRound(parsed.currentRound, now),
    roundHistory,
  };
}

function migrateLegacyState(parsed, now) {
  const players = Object.create(null);
  const oldPlayers = parsed && typeof parsed === 'object' && parsed.players && typeof parsed.players === 'object'
    ? parsed.players
    : {};

  for (const [uid, rawPlayer] of Object.entries(oldPlayers)) {
    if (!UID_PATTERN.test(uid)) continue;
    players[uid] = createPlayer(uid, now, rawPlayer?.balance);
  }
  if (!players.demo) players.demo = createPlayer('demo', now);

  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: finiteInteger(parsed?.createdAt, now),
    updatedAt: now,
    players,
    currentRound: createRound(getRoundSlot(now), now),
    roundHistory: [],
  };
}

export class WalletStore {
  #state = null;

  #queue = Promise.resolve();

  #now;

  constructor({ dataFile, now = () => Date.now() } = {}) {
    if (!dataFile) throw new Error('缺少数据文件路径');
    this.dataFile = path.resolve(dataFile);
    this.dataDir = path.dirname(this.dataFile);
    this.#now = now;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    const now = this.#now();

    try {
      const raw = await readFile(this.dataFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.#state = parsed?.schemaVersion === SCHEMA_VERSION
        ? normalizeState(parsed, now)
        : migrateLegacyState(parsed, now);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backupFile = `${this.dataFile}.corrupt-${Date.now()}`;
        try {
          await rename(this.dataFile, backupFile);
        } catch {
          // 无法备份时仍然初始化，避免服务无法启动。
        }
      }
      this.#state = createEmptyState(now);
    }

    this.#advanceRound(this.#state, now);
    await this.#persist();
    return this;
  }

  #getState() {
    if (!this.#state) throw new Error('数据存储尚未初始化');
    return this.#state;
  }

  #getPlayer(uid, now) {
    const state = this.#getState();
    if (!state.players[uid]) {
      state.players[uid] = createPlayer(uid, now);
    }
    return state.players[uid];
  }

  #mutate(operation) {
    const task = this.#queue.then(async () => {
      const state = this.#getState();
      try {
        const result = operation(state);
        state.updatedAt = this.#now();
        await this.#persist();
        return result;
      } catch (error) {
        // 操作可能已经完成到期结算，再因余额/参数校验失败。先落盘，避免内存与文件不一致。
        try {
          state.updatedAt = this.#now();
          await this.#persist();
        } catch {
          // 保留原始业务错误。
        }
        throw error;
      }
    });
    this.#queue = task.catch(() => {});
    return task;
  }

  async #persist() {
    const state = this.#getState();
    const tempFile = `${this.dataFile}.${process.pid}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(tempFile, payload, 'utf8');
    await rename(tempFile, this.dataFile);
  }

  #advanceRound(state, now) {
    const slot = getRoundSlot(now);
    const current = state.currentRound;

    if (!current) {
      state.currentRound = createRound(slot, now);
      return true;
    }

    if (current.id > slot) return false;
    if (current.id === slot) return false;

    this.#settleRound(state, current, now);
    state.currentRound = createRound(slot, now);
    return true;
  }

  #settleRound(state, round, now) {
    const lastOrderAt = round.lastBetAt ?? round.startAt;
    const outcome = generateOutcome({
      orderNo: round.betCount,
      lastOrderAt,
      totalStake: round.totalStake,
    });

    const settlements = [];
    for (const bet of round.bets) {
      const player = this.#getPlayer(bet.uid, now);
      const settlement = settleBet(
        {
          type: bet.type,
          amount: bet.amount,
          position: bet.position,
          digit: bet.digit,
        },
        outcome,
      );

      const before = player.balance;
      player.balance = Math.min(MAX_BALANCE, before + settlement.payout);
      const credited = player.balance - before;
      player.updatedAt = now;

      const record = {
        id: bet.id,
        roundId: round.id,
        betType: bet.type,
        amount: bet.amount,
        position: bet.position,
        digit: bet.digit,
        placedAt: bet.placedAt,
        settledAt: now,
        result: {
          pickedDigits: outcome.pickedDigits,
          sum: outcome.sum,
          size: outcome.size,
          parity: outcome.parity,
          outcome: outcome.outcome,
        },
        status: settlement.status,
        matched: settlement.matched,
        multiplier: settlement.multiplier,
        payout: credited,
        profit: credited - bet.amount,
        balanceAfter: player.balance,
      };

      player.history.unshift(record);
      player.history = player.history.slice(0, HISTORY_LIMIT);

      settlements.push({
        uid: bet.uid,
        betId: bet.id,
        betType: bet.type,
        amount: bet.amount,
        position: bet.position,
        digit: bet.digit,
        status: settlement.status,
        matched: settlement.matched,
        multiplier: settlement.multiplier,
        payout: credited,
        profit: credited - bet.amount,
        balanceAfter: player.balance,
      });
    }

    const roundRecord = {
      id: round.id,
      startAt: round.startAt,
      endAt: round.endAt,
      settledAt: now,
      lastBetAt: round.lastBetAt,
      result: {
        pickedDigits: outcome.pickedDigits,
        sum: outcome.sum,
        size: outcome.size,
        parity: outcome.parity,
        outcome: outcome.outcome,
        effectiveQty: outcome.effectiveQty,
        adjustment: outcome.adjustment,
        hash: outcome.hash,
        middle60: outcome.middle60,
        seedNumber: outcome.seedNumber,
        seedTimeMs: outcome.seedTimeMs,
        totalStake: outcome.totalStake,
        segments: outcome.segments,
        algorithmVersion: outcome.algorithmVersion,
        seedInputs: outcome.seedInputs,
      },
      betCount: round.betCount,
      totalStake: round.totalStake,
      settlements,
    };

    state.roundHistory.unshift(roundRecord);
    state.roundHistory = state.roundHistory.slice(0, ROUND_HISTORY_LIMIT);
  }

  #summarizeLastRound(lastRound, uid) {
    if (!lastRound) return null;
    const mine = lastRound.settlements.filter((item) => item.uid === uid);
    const stake = mine.reduce((total, item) => total + item.amount, 0);
    const payout = mine.reduce((total, item) => total + item.payout, 0);
    const profit = mine.reduce((total, item) => total + item.profit, 0);
    const wins = mine.filter((item) => item.status === 'win').length;

    return {
      id: lastRound.id,
      startAt: lastRound.startAt,
      endAt: lastRound.endAt,
      settledAt: lastRound.settledAt,
      result: {
        digits: lastRound.result.pickedDigits,
        sum: lastRound.result.sum,
        size: lastRound.result.size,
        parity: lastRound.result.parity,
        outcome: lastRound.result.outcome,
      },
      betCount: lastRound.betCount,
      totalStake: lastRound.totalStake,
      mine: {
        betCount: mine.length,
        stake,
        payout,
        profit,
        wins,
      },
    };
  }

  #historyRound(round, uid) {
    const mine = round.settlements.filter((item) => item.uid === uid);
    const stake = mine.reduce((total, item) => total + item.amount, 0);
    const payout = mine.reduce((total, item) => total + item.payout, 0);
    const profit = mine.reduce((total, item) => total + item.profit, 0);
    const wins = mine.filter((item) => item.status === 'win').length;

    return {
      id: round.id,
      startAt: round.startAt,
      endAt: round.endAt,
      settledAt: round.settledAt,
      lastBetAt: round.lastBetAt,
      betCount: round.betCount,
      totalStake: round.totalStake,
      result: {
        digits: round.result.pickedDigits,
        sum: round.result.sum,
        size: round.result.size,
        parity: round.result.parity,
        outcome: round.result.outcome,
      },
      trace: {
        algorithmVersion: round.result.algorithmVersion,
        seedNumber: round.result.seedNumber,
        seedTimeMs: round.result.seedTimeMs,
        seedInputs: round.result.seedInputs,
        totalStake: round.result.totalStake,
        effectiveQty: round.result.effectiveQty,
        adjustment: round.result.adjustment,
        hash: round.result.hash,
        middle60: round.result.middle60,
        segments: round.result.segments,
      },
      mine: {
        betCount: mine.length,
        stake,
        payout,
        profit,
        wins,
        items: mine.map((item) => ({
          betId: item.betId,
          betType: item.betType,
          amount: item.amount,
          position: item.position,
          digit: item.digit,
          status: item.status,
          matched: item.matched,
          multiplier: item.multiplier,
          payout: item.payout,
          profit: item.profit,
        })),
      },
    };
  }

  async getHistory(uidValue, limit = 20) {
    await this.tick();
    const uid = normalizeUid(uidValue);
    const state = this.#getState();
    this.#getPlayer(uid, this.#now());
    const safeLimit = Math.max(1, Math.min(ROUND_HISTORY_LIMIT, Number(limit) || 20));
    const trend = state.roundHistory
      .slice(0, ROUND_HISTORY_LIMIT)
      .map((round) => ({
        id: round.id,
        startAt: round.startAt,
        endAt: round.endAt,
        settledAt: round.settledAt,
        size: round.result.size,
        parity: round.result.parity,
        outcome: round.result.outcome,
      }))
      .reverse();

    return {
      rounds: state.roundHistory.slice(0, safeLimit).map((round) => this.#historyRound(round, uid)),
      trend,
      total: state.roundHistory.length,
    };
  }

  getPublicState(uidValue, now = this.#now()) {
    const uid = normalizeUid(uidValue);
    const state = this.#getState();
    const player = this.#getPlayer(uid, now);
    const round = state.currentRound;
    const mine = round.bets.filter((bet) => bet.uid === uid);
    const myStake = mine.reduce((total, bet) => total + bet.amount, 0);

    return {
      uid,
      balance: player.balance,
      serverTime: now,
      round: {
        id: round.id,
        startAt: round.startAt,
        endAt: round.endAt,
        bettingEndsAt: round.endAt - BETTING_LOCK_MS,
        bettingLockMs: BETTING_LOCK_MS,
        betCount: round.betCount,
        totalStake: round.totalStake,
        lastBetAt: round.lastBetAt,
        myBetCount: mine.length,
        myStake,
        myBetType: mine[0]?.type ?? null,
        maxBetsPerRound: MAX_BETS_PER_ROUND,
        myBetsRemaining: Math.max(0, MAX_BETS_PER_ROUND - mine.length),
      },
      lastRound: this.#summarizeLastRound(state.roundHistory[0], uid),
      config: {
        roundDurationMs: ROUND_DURATION_MS,
        bettingLockMs: BETTING_LOCK_MS,
        maxBetsPerRound: MAX_BETS_PER_ROUND,
        initialBalance: INITIAL_BALANCE,
        maxBalance: MAX_BALANCE,
        maxRecharge: MAX_RECHARGE,
        amounts: [...BET_AMOUNTS],
        middleRange: [22, 23],
        betTypes: Object.entries(BET_TYPES).map(([type, spec]) => ({
          type,
          label: spec.label,
          multiplier: spec.multiplier,
          family: spec.family,
          desc: spec.desc,
        })),
      },
    };
  }

  async tick() {
    const state = this.#getState();
    const slot = getRoundSlot(this.#now());
    const current = state.currentRound;

    if (current && current.id >= slot) return false;
    return this.#mutate((stateToUpdate) => this.#advanceRound(stateToUpdate, this.#now()));
  }

  async getState(uid) {
    await this.tick();
    return this.getPublicState(uid);
  }

  async recharge(uidValue, amount) {
    const uid = normalizeUid(uidValue);
    const safeAmount = validateRecharge(amount);

    return this.#mutate((state) => {
      const now = this.#now();
      this.#advanceRound(state, now);
      const player = this.#getPlayer(uid, now);
      const before = player.balance;
      player.balance = Math.min(MAX_BALANCE, player.balance + safeAmount);
      const credited = player.balance - before;
      player.updatedAt = now;

      return {
        credited,
        balance: player.balance,
        state: this.getPublicState(uid, now),
      };
    });
  }

  async placeBet(uidValue, { type, amount, position, digit }) {
    const uid = normalizeUid(uidValue);

    return this.#mutate((state) => {
      const now = this.#now();
      this.#advanceRound(state, now);
      const round = state.currentRound;

      if (now >= round.endAt - BETTING_LOCK_MS) {
        throw new ValidationError('本期已封盘，正在等待开奖');
      }

      const player = this.#getPlayer(uid, now);
      const guess = validateBet(type, amount, player.balance, { position, digit });
      const mine = round.bets.filter((bet) => bet.uid === uid);

      if (mine.length >= MAX_BETS_PER_ROUND) {
        throw new ValidationError(`本期最多投注 ${MAX_BETS_PER_ROUND} 笔`);
      }

      const existingType = mine[0]?.type ?? null;
      if (existingType && type !== existingType) {
        if (existingType === '猜数字') {
          throw new ValidationError('本期已选择猜数字，不能投注其他玩法');
        }
        throw new ValidationError(`本期已选择「${existingType}」，不能投注其他结果`);
      }

      player.balance -= amount;
      player.updatedAt = now;

      const bet = {
        id: randomUUID(),
        uid,
        type,
        amount,
        position: guess?.position ?? null,
        digit: guess?.digit ?? null,
        placedAt: now,
      };

      round.bets.push(bet);
      round.betCount = round.bets.length;
      round.totalStake += amount;
      round.lastBetAt = now;

      return {
        bet: {
          id: bet.id,
          roundId: round.id,
          type: bet.type,
          amount: bet.amount,
          position: bet.position,
          digit: bet.digit,
          placedAt: bet.placedAt,
        },
        state: this.getPublicState(uid, now),
      };
    });
  }
}
