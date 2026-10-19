(() => {
  'use strict';

  const BET_AMOUNTS = [100, 200, 500, 1000, 2000, 5000, 10000];
  const DEFAULT_BETTING_LOCK_MS = 5000;
  const DEFAULT_MAX_BETS = 20;
  const UID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
  const numberFormatter = new Intl.NumberFormat('zh-CN');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const dom = {
    snow: $('#snowfall'),
    rechargeButton: $('#rechargeButton'),
    historyButton: $('#historyButton'),
    balanceButton: $('#balanceButton'),
    balanceValue: $('#balanceValue'),
    balanceDelta: $('#balanceDelta'),
    roundLabel: $('#roundLabel'),
    countdown: $('#countdown'),
    progressBar: $('#progressBar'),
    statusDot: $('#statusDot'),
    roundStatus: $('#roundStatus'),
    roundBetCount: $('#roundBetCount'),
    myRoundInfo: $('#myRoundInfo'),
    drawArea: $('#drawArea'),
    resultLabel: $('#resultLabel'),
    resultOutcome: $('#resultOutcome'),
    resultDigits: $('#resultDigits'),
    resultSum: $('#resultSum'),
    resultMine: $('#resultMine'),
    selectedAmountLabel: $('#selectedAmountLabel'),
    amountGrid: $('#amountGrid'),
    amountButtons: $$('.amount-button'),
    betGrid: $('#betGrid'),
    betButtons: $$('.bet-button'),
    digitBetButton: $('#digitBetButton'),
    rechargeModal: $('#rechargeModal'),
    rechargeGrid: $('#rechargeGrid'),
    rechargeOptions: $$('.recharge-option'),
    customRechargeForm: $('#customRechargeForm'),
    customRechargeInput: $('#customRechargeInput'),
    customSubmit: $('.custom-submit'),
    modalBalance: $('#modalBalance'),
    guessModal: $('#guessModal'),
    historyModal: $('#historyModal'),
    historyList: $('#historyList'),
    historyRefresh: $('#historyRefresh'),
    trendPanel: $('#trendPanel'),
    trendGrid: $('#trendGrid'),
    trendToggle: $('#trendToggle'),
    trendToggleLabel: $('#trendToggleLabel'),
    positionGrid: $('#positionGrid'),
    positionButtons: $$('.position-button'),
    digitGrid: $('#digitGrid'),
    digitButtons: $$('.digit-choice'),
    guessSummary: $('#guessSummary'),
    guessAmount: $('#guessAmount'),
    guessConfirm: $('#guessConfirm'),
    toastStack: $('#toastStack'),
    appShell: $('.app-shell'),
  };

  const model = {
    uid: 'demo',
    state: null,
    selectedAmount: 100,
    placing: false,
    recharging: false,
    refreshing: false,
    initialized: false,
    connectionError: false,
    serverOffset: 0,
    displayedBalance: null,
    balanceFrame: null,
    balanceDeltaTimer: null,
    activeModal: null,
    modalReturnFocus: null,
    guessPosition: 1,
    guessDigit: null,
    historyFetching: false,
    trendExpanded: false,
    trendCount: 0,
    closeRefreshScheduled: false,
    tickTimer: null,
    pollTimer: null,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? numberFormatter.format(number) : '0';
  }

  function signed(value) {
    const number = Number(value) || 0;
    return `${number > 0 ? '+' : ''}${formatNumber(number)}`;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function formatRoundId(id) {
    return String(Number(id) || 0).slice(-6).padStart(6, '0');
  }

  function formatDateTime(timestamp, withMilliseconds = false) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    const base = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
      date.getMinutes(),
    )}:${pad(date.getSeconds())}`;
    return withMilliseconds
      ? `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`
      : base;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function resolveUid() {
    const raw = new URLSearchParams(window.location.search).get('uid') || 'demo';
    const uid = raw.trim();
    return UID_PATTERN.test(uid) ? uid : 'demo';
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    const separator = path.includes('?') ? '&' : '?';

    try {
      const response = await fetch(`${path}${separator}uid=${encodeURIComponent(model.uid)}`, {
        ...options,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `请求失败（${response.status}）`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查服务是否正在运行');
      if (error instanceof TypeError) throw new Error('无法连接服务器，请确认后端已启动');
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function setBalance(value, { animate = false, flash = null } = {}) {
    const next = Math.max(0, Math.round(Number(value) || 0));
    const previous = model.displayedBalance;

    if (model.balanceFrame) {
      window.cancelAnimationFrame(model.balanceFrame);
      model.balanceFrame = null;
    }

    model.displayedBalance = next;
    dom.modalBalance.textContent = formatNumber(next);

    if (animate && previous !== null && previous !== next && !reduceMotion) {
      const from = previous;
      const startedAt = performance.now();
      const duration = 380;
      const tick = (now) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - (1 - progress) ** 3;
        dom.balanceValue.textContent = formatNumber(Math.round(from + (next - from) * eased));
        if (progress < 1) {
          model.balanceFrame = window.requestAnimationFrame(tick);
        } else {
          model.balanceFrame = null;
          dom.balanceValue.textContent = formatNumber(next);
        }
      };
      dom.balanceValue.textContent = formatNumber(from);
      model.balanceFrame = window.requestAnimationFrame(tick);
    } else {
      dom.balanceValue.textContent = formatNumber(next);
    }

    if (flash) flashBalanceDelta(flash);
  }

  function flashBalanceDelta(delta) {
    const value = Number(delta);
    if (!value) return;
    if (model.balanceDeltaTimer) window.clearTimeout(model.balanceDeltaTimer);
    dom.balanceDelta.textContent = signed(value);
    dom.balanceDelta.classList.remove('is-visible', 'positive', 'negative');
    void dom.balanceDelta.offsetWidth;
    dom.balanceDelta.classList.add('is-visible', value > 0 ? 'positive' : 'negative');
    model.balanceDeltaTimer = window.setTimeout(() => {
      dom.balanceDelta.classList.remove('is-visible');
      model.balanceDeltaTimer = null;
    }, 1150);
  }

  function setSelectedAmount(amount) {
    const numeric = Number(amount);
    if (!BET_AMOUNTS.includes(numeric)) return;
    model.selectedAmount = numeric;
    for (const button of dom.amountButtons) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.amount) === numeric));
    }
    dom.selectedAmountLabel.textContent = `${formatNumber(numeric)} 金币`;
    dom.guessAmount.textContent = `${formatNumber(numeric)} 金币`;
    updateBetAvailability();
  }

  function bettingEndsAt() {
    if (!model.state) return null;
    const round = model.state.round;
    if (Number.isFinite(Number(round.bettingEndsAt))) return Number(round.bettingEndsAt);
    const lockMs = Number(model.state.config?.bettingLockMs) || DEFAULT_BETTING_LOCK_MS;
    return Number(round.endAt) - lockMs;
  }

  function remainingMs() {
    const endsAt = bettingEndsAt();
    if (endsAt === null) return null;
    return endsAt - (Date.now() + model.serverOffset);
  }

  function roundClosed() {
    const remaining = remainingMs();
    return remaining !== null && remaining <= 0;
  }

  function maxBetsPerRound() {
    return Number(model.state?.round?.maxBetsPerRound) || DEFAULT_MAX_BETS;
  }

  function updateBetAvailability() {
    const round = model.state?.round;
    const atLimit = Boolean(round && round.myBetCount >= maxBetsPerRound());
    const selectedType = round?.myBetType || null;
    const unavailable =
      !model.state || model.placing || model.recharging || roundClosed() || atLimit;

    for (const button of dom.betButtons) {
      const blockedByType = Boolean(selectedType && button.dataset.type !== selectedType);
      button.disabled = unavailable || blockedByType;
    }

    const guessBlocked = Boolean(selectedType && selectedType !== '猜数字');
    dom.guessConfirm.disabled =
      unavailable ||
      guessBlocked ||
      model.guessDigit === null ||
      !model.state;
  }

  function setRoundChrome(stateName, text) {
    dom.roundStatus.textContent = text;
    dom.statusDot.className = 'status-dot';
    if (stateName === 'urgent') dom.statusDot.classList.add('is-urgent');
    if (stateName === 'closed') dom.statusDot.classList.add('is-closed');
  }

  function updateCountdown() {
    if (!model.state) return;
    const round = model.state.round;
    const endsAt = bettingEndsAt();
    const now = Date.now() + model.serverOffset;
    const total = Math.max(1, endsAt - Number(round.startAt));
    const remaining = endsAt - now;

    if (remaining <= 0) {
      const drawRemaining = Math.max(0, Math.ceil((Number(round.endAt) - now) / 1000));
      dom.countdown.textContent = '等待开奖';
      dom.countdown.classList.add('is-closed');
      dom.countdown.classList.remove('is-urgent');
      dom.progressBar.style.width = '0%';
      dom.roundLabel.textContent = `第 ${formatRoundId(round.id)} 期 · 已封盘`;
      setRoundChrome(
        model.connectionError ? 'urgent' : 'closed',
        model.connectionError
          ? '连接中断'
          : drawRemaining > 0
            ? `等待开奖 · ${drawRemaining}s`
            : '等待开奖',
      );
      updateBetAvailability();
      if (model.activeModal === dom.guessModal) {
        closeModal();
        toast('本期已封盘', '正在等待开奖，请稍候。', 'info', 3000);
      }
      if (!model.closeRefreshScheduled) {
        model.closeRefreshScheduled = true;
        const delay = Math.max(250, Math.min(6000, Number(round.endAt) - now + 350));
        window.setTimeout(() => refreshState(), delay);
      }
      return;
    }

    model.closeRefreshScheduled = false;
    dom.roundLabel.textContent = `第 ${formatRoundId(round.id)} 期 · 距封盘`;
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    dom.countdown.textContent = `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
    dom.countdown.classList.remove('is-closed');

    const urgent = remaining <= 15000;
    dom.countdown.classList.toggle('is-urgent', urgent);
    dom.progressBar.style.width = `${Math.max(0, Math.min(100, (remaining / total) * 100))}%`;

    if (model.connectionError) {
      setRoundChrome('urgent', '连接中断');
    } else {
      setRoundChrome(urgent ? 'urgent' : 'open', urgent ? '即将封盘' : '投注中');
    }
    updateBetAvailability();
  }

  function renderRound() {
    if (!model.state) return;
    const round = model.state.round;
    dom.roundLabel.textContent = `第 ${formatRoundId(round.id)} 期`;
    dom.roundBetCount.textContent = `本轮 ${formatNumber(round.betCount)} 注`;
    const maxBets = Number(round.maxBetsPerRound) || DEFAULT_MAX_BETS;
    const betTypeText = round.myBetType ? ` · 已选 ${round.myBetType}` : '';
    const limitText = round.myBetCount >= maxBets ? ' · 已达上限' : '';
    dom.myRoundInfo.textContent =
      round.myBetCount > 0
        ? `我的 ${formatNumber(round.myBetCount)}/${maxBets} 注${betTypeText} · ${formatNumber(
            round.myStake,
          )} 金币${limitText}`
        : `我的 0/${maxBets} 注`;
    dom.selectedAmountLabel.textContent = `${formatNumber(model.selectedAmount)} 金币`;
    dom.guessAmount.textContent = `${formatNumber(model.selectedAmount)} 金币`;
    dom.modalBalance.textContent = formatNumber(model.state.balance);
    updateCountdown();
  }

  function renderLastRound(lastRound, { animate = false } = {}) {
    const digitNodes = $$('.digit b', dom.resultDigits);

    if (!lastRound) {
      dom.resultLabel.textContent = '上期开奖';
      dom.resultOutcome.textContent = '等待开奖';
      dom.resultOutcome.classList.remove('is-win');
      for (const node of digitNodes) node.textContent = '—';
      dom.resultSum.textContent = '和值 —';
      dom.resultMine.textContent = '等待本期结算';
      dom.resultMine.classList.remove('is-profit', 'is-loss');
      return;
    }

    const result = lastRound.result;
    const mine = lastRound.mine || { betCount: 0, wins: 0, profit: 0 };
    dom.resultLabel.textContent = `上期 · 第 ${formatRoundId(lastRound.id)} 期`;
    dom.resultOutcome.textContent = result.outcome;
    dom.resultOutcome.classList.toggle('is-win', mine.wins > 0);
    dom.resultSum.textContent = `和值 ${result.sum} · ${result.parity}`;

    result.digits.forEach((digit, index) => {
      if (digitNodes[index]) digitNodes[index].textContent = digit;
    });

    if (mine.betCount > 0) {
      dom.resultMine.textContent = `你 ${formatNumber(mine.betCount)} 注 · 命中 ${formatNumber(
        mine.wins,
      )} · ${signed(mine.profit)}`;
      dom.resultMine.classList.toggle('is-profit', mine.profit > 0);
      dom.resultMine.classList.toggle('is-loss', mine.profit < 0);
    } else {
      dom.resultMine.textContent = '本期未参与';
      dom.resultMine.classList.remove('is-profit', 'is-loss');
    }

    if (animate && !reduceMotion) {
      dom.resultDigits.classList.remove('is-popping');
      void dom.resultDigits.offsetWidth;
      dom.resultDigits.classList.add('is-popping');
      window.setTimeout(() => dom.resultDigits.classList.remove('is-popping'), 900);
    }
  }

  function settlementToast(lastRound) {
    const mine = lastRound?.mine;
    if (!mine || mine.betCount <= 0) return;
    if (mine.wins > 0) {
      toast(
        `本期命中 ${formatNumber(mine.wins)} 注`,
        `返还 ${formatNumber(mine.payout)} 金币，净收益 ${signed(mine.profit)}。`,
        'win',
        4800,
      );
    } else {
      toast(
        `本期未命中`,
        `本期 ${formatNumber(mine.betCount)} 注，净收益 ${signed(mine.profit)}。`,
        'error',
        4200,
      );
    }
  }

  function historyStat(label, value) {
    const wrap = el('div', 'history-stat');
    wrap.append(el('span', '', label), el('b', '', value));
    return wrap;
  }

  function calcStep(label, ...children) {
    const step = el('div', 'calc-step');
    step.append(el('span', 'calc-label', label), ...children);
    return step;
  }

  function buildHashCode(hash, middle60) {
    const code = el('code', 'calc-code');
    if (!hash) {
      code.textContent = '旧记录没有保存完整哈希';
      return code;
    }
    const middle = middle60 || hash.slice(2, 62);
    code.append(document.createTextNode(hash.slice(0, 2)));
    code.append(el('mark', '', hash.slice(2, 62)));
    code.append(document.createTextNode(hash.slice(62)));
    code.title = `中间 60 位：${middle}`;
    return code;
  }

  function buildHistoryRound(round, index) {
    const trace = round.trace || {};
    const result = round.result || {};
    const mine = round.mine || { betCount: 0, wins: 0, profit: 0, items: [] };
    const item = el('article', 'history-round');

    const head = el('div', 'history-round-head');
    const title = el('div', 'history-round-title');
    title.append(el('b', '', `第 ${formatRoundId(round.id)} 期`));
    const timeRange = `${formatTime(round.startAt)} – ${formatTime(round.endAt)}`;
    const timeNode = el('span', '', timeRange);
    timeNode.title = `${formatDateTime(round.startAt, true)} → ${formatDateTime(round.endAt, true)}`;
    title.append(timeNode);
    const resultWrap = el('div', 'history-round-result');
    resultWrap.append(
      el('strong', '', result.outcome || '—'),
      el('span', '', `和值 ${result.sum ?? '—'} · ${result.parity || '—'}`),
    );
    head.append(title, resultWrap);

    const summary = el('div', 'history-summary');
    summary.append(
      historyStat('投入金币总数', formatNumber(round.totalStake)),
      historyStat('注单数量', formatNumber(round.betCount)),
      historyStat('最后一单', round.lastBetAt ? formatDateTime(round.lastBetAt, true) : '空期'),
      historyStat('结算时间', formatDateTime(round.settledAt, true)),
    );

    const digits = el('div', 'history-mini-digits');
    for (const digit of result.digits || []) digits.append(el('span', '', digit));

    const mineLine = el('div', 'history-mine');
    if (mine.betCount > 0) {
      mineLine.textContent = `我的 ${formatNumber(mine.betCount)} 注 · 投入 ${formatNumber(
        mine.stake,
      )} · 命中 ${formatNumber(mine.wins)} · 净收益 ${signed(mine.profit)}`;
      mineLine.classList.toggle('is-profit', mine.profit > 0);
      mineLine.classList.toggle('is-loss', mine.profit < 0);
    } else {
      mineLine.textContent = '本期未参与';
    }

    const details = el('details', 'calc-details');
    details.open = index === 0;
    details.append(el('summary', '', '查看完整计算过程'));
    const body = el('div', 'calc-body');

    const adjustment = trace.adjustment;
    const adjustedText = !adjustment
      ? '该期没有保存进位补偿数据。'
      : adjustment.adjusted
        ? `下单数 ${adjustment.orderNo} 小于 20，从 ${adjustment.range?.[0]}–${adjustment.range?.[1]} 随机补偿 +${adjustment.randomOffset}，进位数量为 ${trace.effectiveQty}。`
        : `下单数 ${adjustment.orderNo ?? round.betCount} 已达到 20，无需随机补偿，进位数量为 ${trace.effectiveQty}。`;
    body.append(
      calcStep(
        'STEP 01 · 投入与注单',
        document.createTextNode(
          `本期投入金币总数 ${formatNumber(round.totalStake)}，共 ${formatNumber(
            round.betCount,
          )} 注。`,
        ),
        document.createElement('br'),
        document.createTextNode(adjustedText),
      ),
    );

    body.append(
      calcStep(
        'STEP 02 · 时间相关数',
        document.createTextNode(
          round.lastBetAt
            ? `最后一单毫秒：${trace.seedTimeMs ?? round.lastBetAt}。`
            : `本期没有注单，使用期号开始毫秒：${trace.seedTimeMs ?? round.startAt}。`,
        ),
        document.createElement('br'),
        document.createTextNode(
          `毫秒时间尾数：${String(trace.seedTimeMs ?? round.lastBetAt ?? round.startAt).slice(-3)}。`,
        ),
      ),
    );

    const seedStep = calcStep('STEP 03 · 种子数字');
    seedStep.append(
      document.createTextNode(
        `种子数字 = 将进位数量 ${trace.seedInputs?.effectiveQty ?? trace.effectiveQty ?? '—'}、最后一单毫秒 ${
          trace.seedInputs?.lastOrderAt ?? trace.seedTimeMs ?? '—'
        }、投入金币总数 ${trace.seedInputs?.totalStake ?? round.totalStake} 依次拼接。`,
      ),
    );
    seedStep.append(el('code', 'calc-code', trace.seedNumber || '旧记录未保存种子数字'));
    body.append(seedStep);

    const hashStep = calcStep('STEP 04 · SHA-256 哈希（64 位）');
    hashStep.append(
      document.createTextNode('高亮部分为去掉首尾各 2 位后的中间 60 位，用于拆成 5 段。'),
      buildHashCode(trace.hash, trace.middle60),
    );
    body.append(hashStep);

    const segmentStep = calcStep('STEP 05 · 五段取数');
    segmentStep.append(
      document.createTextNode('每段 48 位值转十进制后取低 11 位，末位作为索引并取第 1–10 位，避免前导补零和末位自取造成数字偏差。'),
    );
    const segmentGrid = el('div', 'calc-segments');
    const segments = Array.isArray(trace.segments) ? trace.segments : [];
    if (segments.length === 0) {
      segmentStep.append(document.createTextNode('旧记录没有保存五段十进制数据。'));
    } else {
      for (const segment of segments) {
        const card = el('div', 'calc-segment');
        card.append(
          el('span', '', `段 ${segment.index} · 末位 ${segment.baseDigit} → 第 ${segment.takePosition} 位`),
          el('code', '', segment.decimal),
          el('b', '', segment.picked),
        );
        segmentGrid.append(card);
      }
      segmentStep.append(segmentGrid);
    }
    body.append(segmentStep);

    const picked = Array.isArray(result.digits) ? result.digits : [];
    body.append(
      calcStep(
        'STEP 06 · 求和判定',
        document.createTextNode(
          `${picked.join(' + ') || '—'} = ${result.sum ?? '—'}，判定为 ${result.outcome || '—'}。`,
        ),
      ),
    );

    const betsStep = calcStep('STEP 07 · 我的投注');
    const betList = el('div', 'calc-bets');
    const mineItems = Array.isArray(mine.items) ? mine.items : [];
    if (mineItems.length === 0) {
      betList.append(el('span', 'calc-bet', '本期未参与'));
    } else {
      for (const bet of mineItems) {
        const guess = bet.betType === '猜数字' ? `（第 ${bet.position} 位=${bet.digit}）` : '';
        const text =
          bet.status === 'win'
            ? `${bet.betType}${guess} ${formatNumber(bet.amount)} · 命中 +${formatNumber(bet.profit)}`
            : `${bet.betType}${guess} ${formatNumber(bet.amount)} · 未中 ${signed(bet.profit)}`;
        betList.append(el('span', `calc-bet ${bet.status}`, text));
      }
    }
    betsStep.append(betList);
    body.append(betsStep);

    details.append(body);
    item.append(head, summary, digits, mineLine, details);
    return item;
  }

  function setTrendExpanded(expanded) {
    model.trendExpanded = Boolean(expanded);
    dom.trendPanel.classList.toggle('is-expanded', model.trendExpanded);
    dom.trendToggle.setAttribute('aria-expanded', String(model.trendExpanded));
    dom.trendToggleLabel.textContent = model.trendExpanded
      ? '收起走势'
      : `展开${model.trendCount || 100}期`;
    window.requestAnimationFrame(() => {
      if (model.trendExpanded) {
        dom.trendGrid.scrollTop = 0;
      } else {
        dom.trendGrid.scrollTop = dom.trendGrid.scrollHeight;
      }
    });
  }

  function renderTrend(trend) {
    if (!Array.isArray(trend) || trend.length === 0) {
      model.trendCount = 0;
      model.trendExpanded = false;
      dom.trendPanel.classList.remove('is-expanded');
      dom.trendToggle.setAttribute('aria-expanded', 'false');
      dom.trendToggle.disabled = true;
      dom.trendToggleLabel.textContent = '暂无走势';
      dom.trendGrid.replaceChildren(el('div', 'trend-loading', '暂无已结算期次'));
      return;
    }

    model.trendCount = trend.length;
    dom.trendToggle.disabled = false;
    dom.trendToggleLabel.textContent = model.trendExpanded
      ? '收起走势'
      : `展开${trend.length}期`;

    const sizeClass = { 大: 'size-big', 小: 'size-small', 和: 'size-middle' };
    const parityClass = { 单: 'parity-odd', 双: 'parity-even' };
    const fragment = document.createDocumentFragment();

    trend.forEach((item, index) => {
      const cell = el(
        'div',
        `trend-cell ${sizeClass[item.size] || 'size-middle'} ${parityClass[item.parity] || 'parity-even'}`,
      );
      cell.title = `第 ${formatRoundId(item.id)} 期 · ${item.outcome} · ${formatDateTime(
        item.settledAt,
        true,
      )}`;
      if (index === trend.length - 1) cell.classList.add('is-latest');
      cell.append(el('b', '', item.size || '—'), el('small', '', item.parity || '—'));
      fragment.append(cell);
    });

    dom.trendGrid.replaceChildren(fragment);
    if (model.trendExpanded) {
      dom.trendGrid.scrollTop = 0;
    } else {
      dom.trendGrid.scrollTop = dom.trendGrid.scrollHeight;
    }
  }

  function renderHistory(rounds) {
    if (!Array.isArray(rounds) || rounds.length === 0) {
      const empty = el('div', 'history-empty');
      empty.append(el('span', '', '❅'), el('p', '', '暂无历史期次。完成第一期开奖后即可追溯。'));
      dom.historyList.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    rounds.forEach((round, index) => {
      fragment.append(buildHistoryRound(round, index));
    });
    dom.historyList.replaceChildren(fragment);
  }

  async function fetchHistory() {
    if (model.historyFetching) return;
    model.historyFetching = true;
    dom.historyRefresh.disabled = true;
    dom.historyList.replaceChildren(el('div', 'history-loading', '正在读取历史订单…'));
    dom.trendToggle.disabled = true;
    dom.trendToggleLabel.textContent = '读取中…';
    dom.trendGrid.replaceChildren(el('div', 'trend-loading', '正在读取近100期走势…'));

    try {
      const data = await api('/api/history?limit=20');
      renderTrend(data.trend);
      renderHistory(data.rounds);
    } catch (error) {
      const failed = el('div', 'history-empty');
      failed.append(el('span', '', '!'), el('p', '', error.message));
      dom.historyList.replaceChildren(failed);
      model.trendExpanded = false;
      model.trendCount = 0;
      dom.trendPanel.classList.remove('is-expanded');
      dom.trendToggle.setAttribute('aria-expanded', 'false');
      dom.trendToggle.disabled = true;
      dom.trendToggleLabel.textContent = '暂无走势';
      dom.trendGrid.replaceChildren(el('div', 'trend-loading', '走势加载失败'));
      toast('历史加载失败', error.message, 'error');
    } finally {
      model.historyFetching = false;
      dom.historyRefresh.disabled = false;
    }
  }

  function openHistory() {
    openModal(dom.historyModal, dom.historyButton);
    fetchHistory();
  }

  function applyState(next, { initial = false, skipFlash = false } = {}) {
    if (!next) return;
    const previous = model.state;
    const previousBalance = previous ? previous.balance : null;
    const previousRoundId = previous?.lastRound?.id ?? null;
    const nextRoundId = next.lastRound?.id ?? null;
    const isNewSettlement = Boolean(next.lastRound) && nextRoundId !== previousRoundId;

    model.state = next;
    model.serverOffset = Number(next.serverTime) - Date.now();
    model.connectionError = false;

    const diff = previousBalance === null ? 0 : next.balance - previousBalance;
    setBalance(next.balance, { animate: previousBalance !== null, flash: skipFlash ? null : diff });

    renderRound();
    if (isNewSettlement || initial) {
      renderLastRound(next.lastRound, { animate: isNewSettlement && !initial });
    }
    dom.modalBalance.textContent = formatNumber(next.balance);

    if (isNewSettlement && !initial) {
      settlementToast(next.lastRound);
    }

    if (initial) {
      model.initialized = true;
    }

    updateBetAvailability();
  }

  async function refreshState() {
    if (model.refreshing || model.placing || model.recharging) return;
    model.refreshing = true;

    try {
      const data = await api('/api/state');
      if (model.placing || model.recharging) return;
      applyState(data.state, { initial: !model.initialized });
    } catch {
      model.connectionError = true;
      setRoundChrome('urgent', '连接中断');
    } finally {
      model.refreshing = false;
    }
  }

  async function placeBet(type, guess = null) {
    if (model.placing || !model.state) return false;
    if (roundClosed()) {
      toast('本期已封盘', '正在等待开奖，请稍候。', 'error');
      refreshState();
      return false;
    }

    const currentRound = model.state.round;
    if (currentRound.myBetCount >= maxBetsPerRound()) {
      toast('已达投注上限', `本期最多投注 ${maxBetsPerRound()} 笔。`, 'error');
      return false;
    }
    if (currentRound.myBetType && currentRound.myBetType !== type) {
      toast(
        '本期已锁定玩法',
        `已选择「${currentRound.myBetType}」，本期内不能改投其他结果。`,
        'error',
      );
      return false;
    }

    const amount = model.selectedAmount;
    if (amount > model.state.balance) {
      toast('余额不足', '请先点击充值补充金币。', 'error');
      openRecharge();
      return false;
    }

    const snapshot = model.state;
    model.placing = true;
    updateBetAvailability();
    setBalance(snapshot.balance - amount, { flash: -amount });

    try {
      const payload = { type, amount };
      if (guess) {
        payload.position = guess.position;
        payload.digit = guess.digit;
      }

      const data = await api('/api/bet', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      applyState(data.state, { skipFlash: true });
      const label = type === '猜数字' ? `猜数字 · 第 ${guess.position} 位 = ${guess.digit}` : type;
      toast('已下单', `${label} · ${formatNumber(amount)} 金币，等待本期开奖。`, 'success', 2600);
      return true;
    } catch (error) {
      setBalance(snapshot.balance);
      toast('下单失败', error.message, 'error');
      window.setTimeout(() => refreshState(), 120);
      return false;
    } finally {
      model.placing = false;
      updateBetAvailability();
    }
  }

  async function recharge(amount) {
    if (model.recharging) return;
    const numeric = Number(amount);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 100000) {
      toast('金额无效', '充值金额需为 1–100000 的整数。', 'error');
      return;
    }

    model.recharging = true;
    dom.rechargeOptions.forEach((button) => {
      button.disabled = true;
    });
    dom.customSubmit.disabled = true;
    updateBetAvailability();

    try {
      const data = await api('/api/recharge', {
        method: 'POST',
        body: JSON.stringify({ amount: numeric }),
      });
      applyState(data.state, { skipFlash: true });
      flashBalanceDelta(data.credited);
      dom.customRechargeInput.value = '';
      toast('充值成功', `+${formatNumber(data.credited)} 金币已到账。`, 'success', 3000);
    } catch (error) {
      toast('充值失败', error.message, 'error');
      window.setTimeout(() => refreshState(), 120);
    } finally {
      model.recharging = false;
      dom.rechargeOptions.forEach((button) => {
        button.disabled = false;
      });
      dom.customSubmit.disabled = false;
      updateBetAvailability();
    }
  }

  function toast(title, message, type = 'info', duration = 3200) {
    while (dom.toastStack.children.length >= 4) {
      dom.toastStack.firstElementChild?.remove();
    }

    const icons = { success: '✓', error: '!', win: '✦', info: '❄' };
    const node = el('div', `toast ${type}`);
    const icon = el('span', 'toast-icon', icons[type] || '❄');
    const copy = el('div', 'toast-copy');
    copy.append(el('strong', '', title));
    if (message) copy.append(document.createTextNode(message));
    node.append(icon, copy);
    dom.toastStack.append(node);

    window.setTimeout(() => {
      node.classList.add('is-leaving');
      window.setTimeout(() => node.remove(), 260);
    }, duration);
  }

  function focusableModalElements() {
    if (!model.activeModal) return [];
    return $$('button:not([disabled]), input:not([disabled])', model.activeModal).filter(
      (node) => node.offsetParent !== null,
    );
  }

  function openModal(element, opener) {
    if (!element || model.activeModal === element) return;
    if (model.activeModal) closeModal();
    model.activeModal = element;
    model.modalReturnFocus = opener || document.activeElement;
    element.classList.add('is-open');
    element.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    dom.appShell.inert = true;
    window.setTimeout(() => {
      if (model.activeModal === element) $('.modal-close', element)?.focus();
    }, 30);
  }

  function closeModal() {
    const element = model.activeModal;
    if (!element) return;
    model.activeModal = null;
    element.classList.remove('is-open');
    element.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    dom.appShell.inert = false;

    if (
      model.modalReturnFocus instanceof HTMLElement &&
      model.modalReturnFocus.isConnected &&
      !model.modalReturnFocus.disabled
    ) {
      model.modalReturnFocus.focus();
    }
  }

  function openRecharge() {
    if (!model.state) {
      toast('正在连接', '请等待期号数据加载完成。', 'error');
      return;
    }
    const opener = model.activeModal === dom.guessModal ? dom.digitBetButton : document.activeElement;
    openModal(dom.rechargeModal, opener);
  }

  function openGuess() {
    if (!model.state) return;
    if (roundClosed()) {
      toast('本期已封盘', '正在等待开奖，请稍候。', 'error');
      return;
    }
    const round = model.state.round;
    if (round.myBetCount >= maxBetsPerRound()) {
      toast('已达投注上限', `本期最多投注 ${maxBetsPerRound()} 笔。`, 'error');
      return;
    }
    if (round.myBetType && round.myBetType !== '猜数字') {
      toast(
        '本期已锁定玩法',
        `已选择「${round.myBetType}」，本期内不能改投猜数字。`,
        'error',
      );
      return;
    }
    if (model.selectedAmount > model.state.balance) {
      toast('余额不足', '请先点击充值补充金币。', 'error');
      openRecharge();
      return;
    }

    model.guessPosition = 1;
    model.guessDigit = null;
    renderGuessSelection();
    openModal(dom.guessModal, dom.digitBetButton);
  }

  function renderGuessSelection() {
    for (const button of dom.positionButtons) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.position) === model.guessPosition));
    }
    for (const button of dom.digitButtons) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.digit) === model.guessDigit));
    }

    const positionText = `第 ${model.guessPosition} 位`;
    dom.guessSummary.textContent =
      model.guessDigit === null ? `${positionText} · 尚未选择数字` : `${positionText} · 数字 ${model.guessDigit}`;
    dom.guessAmount.textContent = `${formatNumber(model.selectedAmount)} 金币`;
    const round = model.state?.round;
    const atLimit = Boolean(round && round.myBetCount >= maxBetsPerRound());
    const lockedType = Boolean(round?.myBetType && round.myBetType !== '猜数字');
    dom.guessConfirm.disabled =
      model.placing ||
      model.guessDigit === null ||
      roundClosed() ||
      !model.state ||
      atLimit ||
      lockedType;
  }

  function bindEvents() {
    for (const button of dom.amountButtons) {
      button.addEventListener('click', () => setSelectedAmount(button.dataset.amount));
    }
    for (const button of dom.betButtons) {
      button.addEventListener('click', () => {
        if (button.dataset.type === '猜数字') {
          openGuess();
          return;
        }
        placeBet(button.dataset.type);
      });
    }

    dom.rechargeButton.addEventListener('click', openRecharge);
    dom.historyButton.addEventListener('click', openHistory);
    dom.balanceButton.addEventListener('click', openRecharge);
    dom.historyRefresh.addEventListener('click', fetchHistory);
    dom.trendToggle.addEventListener('click', () => {
      setTrendExpanded(!model.trendExpanded);
    });

    dom.rechargeOptions.forEach((button) => {
      button.addEventListener('click', () => recharge(Number(button.dataset.recharge)));
    });

    dom.customRechargeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = Number(dom.customRechargeInput.value);
      if (!Number.isInteger(value) || value < 1 || value > 100000) {
        toast('金额无效', '请输入 1–100000 之间的整数金币。', 'error');
        return;
      }
      recharge(value);
    });

    for (const button of dom.positionButtons) {
      button.addEventListener('click', () => {
        model.guessPosition = Number(button.dataset.position);
        renderGuessSelection();
      });
    }
    for (const button of dom.digitButtons) {
      button.addEventListener('click', () => {
        model.guessDigit = Number(button.dataset.digit);
        renderGuessSelection();
      });
    }

    dom.guessConfirm.addEventListener('click', async () => {
      if (model.guessDigit === null) return;
      const success = await placeBet('猜数字', {
        position: model.guessPosition,
        digit: model.guessDigit,
      });
      if (success) closeModal();
    });

    for (const modal of [dom.rechargeModal, dom.guessModal, dom.historyModal]) {
      modal.addEventListener('click', (event) => {
        if (event.target.closest('[data-close-modal]')) closeModal();
      });
    }

    document.addEventListener('keydown', (event) => {
      if (!model.activeModal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableModalElements();
      if (focusable.length === 0) return;
      if (!model.activeModal.contains(document.activeElement)) {
        event.preventDefault();
        focusable[0].focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshState();
    });
  }

  class Snowfall {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.width = 0;
      this.height = 0;
      this.flakes = [];
      this.frame = null;
      this.lastTime = 0;
      this.running = false;
      this.onResize = this.resize.bind(this);
      this.tick = this.tick.bind(this);
    }

    start() {
      if (!this.ctx) return;
      this.resize();
      if (reduceMotion) {
        this.draw(0);
        window.addEventListener('resize', this.onResize, { passive: true });
        return;
      }
      this.running = true;
      window.addEventListener('resize', this.onResize, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.running = false;
          if (this.frame) window.cancelAnimationFrame(this.frame);
          this.frame = null;
        } else if (!this.running) {
          this.running = true;
          this.lastTime = performance.now();
          this.frame = window.requestAnimationFrame(this.tick);
        }
      });
      this.frame = window.requestAnimationFrame(this.tick);
    }

    resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = Math.floor(this.width * ratio);
      this.canvas.height = Math.floor(this.height * ratio);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      const target = Math.max(46, Math.min(140, Math.floor((this.width * this.height) / 14500)));
      this.flakes = Array.from({ length: target }, () => this.createFlake(true));
      if (reduceMotion) this.draw(0);
    }

    createFlake(initial = false) {
      const depth = Math.random();
      return {
        x: Math.random() * this.width,
        y: initial ? Math.random() * this.height : -12,
        radius: 0.7 + depth * 2.4,
        speed: 0.2 + depth * 0.62,
        drift: -0.08 + Math.random() * 0.16,
        sway: 0.12 + Math.random() * 0.34,
        phase: Math.random() * Math.PI * 2,
        phaseSpeed: 0.0004 + Math.random() * 0.001,
        alpha: 0.16 + depth * 0.46,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.004,
      };
    }

    draw(delta) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.lineCap = 'round';

      for (const flake of this.flakes) {
        flake.y += flake.speed * delta;
        flake.x += (flake.drift + Math.sin(flake.phase) * flake.sway) * delta;
        flake.phase += flake.phaseSpeed * delta * 16;
        flake.rotation += flake.spin * delta;

        if (flake.y > this.height + 18) {
          flake.y = -15;
          flake.x = Math.random() * this.width;
        }
        if (flake.x < -20) flake.x = this.width + 15;
        if (flake.x > this.width + 20) flake.x = -15;

        ctx.save();
        ctx.translate(flake.x, flake.y);
        ctx.rotate(flake.rotation);
        ctx.globalAlpha = flake.alpha;

        if (flake.radius > 1.55) {
          ctx.strokeStyle = 'rgba(226, 215, 255, 0.85)';
          ctx.lineWidth = 0.62;
          const arm = flake.radius * 2.9;
          for (let i = 0; i < 3; i += 1) {
            ctx.rotate(Math.PI / 3);
            ctx.beginPath();
            ctx.moveTo(-arm, 0);
            ctx.lineTo(arm, 0);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(arm * 0.55, 0);
            ctx.lineTo(arm * 0.28, -arm * 0.24);
            ctx.moveTo(arm * 0.55, 0);
            ctx.lineTo(arm * 0.28, arm * 0.24);
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = 'rgba(237, 230, 255, 0.95)';
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(0.55, flake.radius), 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }
    }

    tick(time) {
      if (!this.running) return;
      const delta = this.lastTime ? Math.min(2.2, (time - this.lastTime) / 16.67) : 1;
      this.lastTime = time;
      this.draw(delta);
      this.frame = window.requestAnimationFrame(this.tick);
    }
  }

  function startTimers() {
    model.tickTimer = window.setInterval(updateCountdown, 200);
    model.pollTimer = window.setInterval(() => {
      if (!document.hidden) refreshState();
    }, 1200);
  }

  function boot() {
    model.uid = resolveUid();
    setSelectedAmount(100);
    bindEvents();
    startTimers();

    const snowfall = new Snowfall(dom.snow);
    snowfall.start();

    refreshState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
