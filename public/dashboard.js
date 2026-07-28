// ---- clock ----
function renderClock() {
  var el = document.getElementById('clock');
  var opts = { weekday: 'long', month: 'long', day: 'numeric' };
  el.textContent = new Date().toLocaleDateString(undefined, opts);
}
renderClock();
setInterval(renderClock, 60000);

// ---- helpers ----
function fmtDollar(v, opts) {
  opts = opts || {};
  var n = Number(v) || 0;
  return '$' + n.toLocaleString(undefined, {
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}
function fmtDate(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---- line chart (ported from the artifact) ----
function renderLine(id, series, dates, xTicks) {
  var el = document.getElementById(id);
  if (!el) return;
  var W = 300, H = 90, pad = 4;
  if (!series.length) { el.innerHTML = ''; return; }
  var dataMin = Math.min.apply(null, series);
  var dataMax = Math.max.apply(null, series);
  if (dataMin === dataMax) { dataMin -= 1; dataMax += 1; }
  var span = dataMax - dataMin;
  var min = dataMin - span * 0.08, max = dataMax + span * 0.08;
  var n = series.length;
  var x = function (i) { return n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2); };
  var y = function (v) { return pad + (1 - (v - min) / (max - min)) * (H - pad * 2); };
  var floorY = H;

  var first = series[0], last = series[n - 1];
  var color = last < first ? 'var(--critical)' : (last > first ? 'var(--good)' : 'var(--muted)');

  var pathD = series.map(function (v, i) {
    return (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(v).toFixed(1);
  }).join(' ');

  var areaD = pathD + ' L' + x(n - 1).toFixed(1) + ',' + floorY + ' L' + x(0).toFixed(1) + ',' + floorY + ' Z';
  var lastX = x(n - 1), lastY = y(last);

  var gridLines = [dataMax, (dataMax + dataMin) / 2, dataMin].map(function (v) {
    var gy = y(v).toFixed(1);
    return '<line class="line-grid" x1="' + pad + '" y1="' + gy + '" x2="' + (W - pad) + '" y2="' + gy + '"/>';
  }).join('');

  el.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      gridLines +
      '<path class="line-area" d="' + areaD + '" fill="' + color + '" opacity="0.12"/>' +
      '<path class="line-path" d="' + pathD + '" stroke="' + color + '"/>' +
      '<circle class="line-end" cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="4" fill="' + color + '"/>' +
    '</svg>';

  var suffix = id.replace('spark-', '');
  var yEl = document.getElementById('yaxis-' + suffix);
  if (yEl) {
    yEl.innerHTML = n === 1
      ? '<span></span><span>' + fmtDollar(series[0]) + '</span><span></span>'
      : '<span>' + fmtDollar(dataMax) + '</span><span>' + fmtDollar((dataMax + dataMin) / 2) + '</span><span>' + fmtDollar(dataMin) + '</span>';
  }
  var xEl = document.getElementById('xaxis-' + suffix);
  if (xEl) {
    if (n === 1) {
      xEl.innerHTML = '<span style="margin: 0 auto;">' + dates[0] + '</span>';
    } else {
      var tickCount = Math.min(xTicks || 3, n);
      var html = '';
      for (var t = 0; t < tickCount; t++) {
        var idx = t === tickCount - 1 ? n - 1 : Math.round(t * (n - 1) / (tickCount - 1));
        html += '<span>' + dates[idx] + '</span>';
      }
      xEl.innerHTML = html;
    }
  }
}

// ---- bar chart (ported from the artifact) ----
function renderBars(containerId, rows, opts) {
  opts = opts || {};
  var el = document.getElementById(containerId);
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="empty-state">No data yet</div>'; return; }
  var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.value); }));
  if (max === 0) max = 1;
  el.innerHTML = rows.map(function (r) {
    var pct = Math.max((Math.abs(r.value) / max) * 100, r.value === 0 ? 0.6 : 2);
    var cls = opts.signed ? (r.value < 0 ? 'liability' : 'asset') : '';
    var bg = opts.colors ? ('background: ' + opts.colors[rows.indexOf(r) % opts.colors.length] + ';') : '';
    var label = (r.value < 0 ? '&minus;' : '') + fmtDollar(Math.abs(r.value), { cents: opts.cents });
    return (
      '<div class="bar-row">' +
        '<span class="bar-row-label">' + r.label + '</span>' +
        '<div class="bar-track"><div class="bar-fill ' + cls + '" style="width: ' + pct + '%; ' + bg + '">' +
          '<span' + (r.value === 0 ? ' style="padding-left:0.4rem;color:var(--muted);"' : '') + '>' + label + '</span>' +
        '</div></div>' +
      '</div>'
    );
  }).join('');
}

// ---- data loading ----
async function getJSON(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error(url + ' -> ' + res.status);
  return res.json();
}

async function loadCalendar() {
  try {
    var data = await getJSON('/api/calendar');
    var stamp = document.getElementById('calendar-sync-stamp');
    stamp.textContent = 'Synced ' + new Date(data.fetched_at).toLocaleString();

    var windowEnd = Date.now() + 10 * 24 * 60 * 60 * 1000; // next 10 days
    var all = []
      .concat((data.canvas.events || []).map(function (e) { return Object.assign({}, e, { source: 'Canvas' }); }))
      .concat((data.personal.events || []).map(function (e) { return Object.assign({}, e, { source: 'Personal' }); }))
      .filter(function (e) { return new Date(e.start).getTime() <= windowEnd; })
      .sort(function (a, b) { return new Date(a.start) - new Date(b.start); })
      .slice(0, 15); // whichever limit (10 days or 15 items) hits first

    var list = document.getElementById('calendar-events');
    var emptyWrap = document.getElementById('calendar-empty-states');
    emptyWrap.innerHTML = '';

    if (all.length === 0) {
      list.innerHTML = '';
      emptyWrap.innerHTML = '<div class="empty-state">Nothing scheduled on either calendar</div>';
    } else {
      list.innerHTML = all.map(function (e) {
        var d = new Date(e.start);
        var time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return (
          '<li class="event-item">' +
            '<span class="event-date">' + fmtDate(e.start) + '</span>' +
            '<span class="event-title">' + e.title + '</span>' +
            '<span style="margin-left:auto;font-size:0.7rem;color:var(--muted);">' + time + ' &middot; ' + e.source + '</span>' +
          '</li>'
        );
      }).join('');
    }

    if (data.canvas.error) emptyWrap.innerHTML += '<div class="empty-state">Canvas: ' + data.canvas.error + '</div>';
    if (data.personal.error) emptyWrap.innerHTML += '<div class="empty-state">Personal: ' + data.personal.error + '</div>';
  } catch (err) {
    document.getElementById('calendar-sync-stamp').textContent = 'Sync failed: ' + err.message;
  }
}

async function loadSubscriptions() {
  try {
    var subs = await getJSON('/api/subscriptions');
    var list = document.getElementById('subscriptions-list');
    if (!subs.length) {
      list.innerHTML = '<li>No subscriptions logged yet</li>';
      return;
    }
    var totalMonthly = 0;
    var rows = subs.map(function (s) {
      var monthly = s.cadence === 'yearly' ? Number(s.amount) / 12 : Number(s.amount);
      totalMonthly += monthly;
      var label = s.cadence === 'yearly' ? fmtDollar(s.amount, { cents: true }) + '/yr' : fmtDollar(s.amount, { cents: true }) + '/mo';
      return '<li><span>' + s.name + '</span><span class="amt">' + label + '</span></li>';
    });
    rows.push('<li><strong>Total</strong><span class="amt"><strong>' + fmtDollar(totalMonthly, { cents: true }) + '/mo</strong></span></li>');
    list.innerHTML = rows.join('');
  } catch (err) {
    document.getElementById('subscriptions-list').innerHTML = '<li>Failed to load</li>';
  }
}

var latestFinance = null;
var latestRobinhood = [];

async function loadFinanceAndRobinhood() {
  try {
    latestFinance = await getJSON('/api/finance/latest');
  } catch (err) { latestFinance = null; }
  try {
    latestRobinhood = await getJSON('/api/robinhood/latest');
  } catch (err) { latestRobinhood = []; }

  renderNetWorthAndSpending();
  renderBankWidget();
  renderRobinhoodWidgets();
  renderStatusRow();
}

function renderNetWorthAndSpending() {
  var bank = latestFinance ? Number(latestFinance.bank_balance) : 0;
  var cards = latestFinance ? latestFinance.cards || [] : [];
  var robinhoodTotal = latestRobinhood.reduce(function (sum, r) { return sum + Number(r.total_value); }, 0);
  var liabilities = cards.reduce(function (sum, c) { return sum + Number(c.balance); }, 0);
  var netWorth = bank + robinhoodTotal - liabilities;

  document.getElementById('stat-net-worth').textContent = fmtDollar(netWorth, { cents: true });

  var spent = 0, income = 0;
  if (latestFinance) {
    spent = (latestFinance.transactions || []).reduce(function (s, t) { return s + Number(t.amount); }, 0);
    income = Number(latestFinance.income) || 0;
  }
  document.getElementById('stat-spent').textContent = fmtDollar(spent, { cents: true });
  document.getElementById('stat-income').textContent = fmtDollar(income, { cents: true });

  var networthRows = [];
  networthRows.push({ label: 'Bank', value: bank });
  if (robinhoodTotal > 0 || latestRobinhood.length) networthRows.push({ label: 'Investments', value: robinhoodTotal });
  cards.forEach(function (c) { networthRows.push({ label: c.label, value: -Number(c.balance) }); });
  renderBars('networth-bars', networthRows, { signed: true, cents: true });

  var byCategory = {};
  if (latestFinance) {
    (latestFinance.transactions || []).forEach(function (t) {
      byCategory[t.category] = (byCategory[t.category] || 0) + Number(t.amount);
    });
  }
  var spendingRows = Object.keys(byCategory).map(function (cat) { return { label: cat, value: byCategory[cat] }; });
  var palette = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
  renderBars('spending-bars', spendingRows, { colors: palette, cents: true });
}

async function renderBankWidget() {
  try {
    var history = await getJSON('/api/finance/history?limit=52');
    var series = history.map(function (h) { return Number(h.bank_balance); });
    var dates = history.map(function (h) { return fmtDate(h.logged_at); });
    var total = series.length ? series[series.length - 1] : 0;
    document.getElementById('bank-total').textContent = fmtDollar(total, { cents: true });
    var badge = document.getElementById('bank-badge');
    if (series.length < 2) {
      badge.textContent = series.length + ' of ~52 weeks logged';
      badge.style.background = 'var(--muted)';
    } else {
      var pct = ((series[series.length - 1] - series[0]) / series[0]) * 100;
      badge.textContent = (pct >= 0 ? '↑ ' : '↓ ') + Math.abs(pct).toFixed(2) + '% · 1yr';
      badge.style.background = pct >= 0 ? 'var(--good)' : 'var(--critical)';
    }
    renderLine('spark-bank', series, dates, 5);
  } catch (err) {
    document.getElementById('bank-total').textContent = 'n/a';
  }
}

function renderRobinhoodWidgets() {
  ['agentic', 'individual'].forEach(function (key) {
    var snap = latestRobinhood.find(function (r) { return r.account_label.toLowerCase() === key; });
    var totalEl = document.getElementById(key + '-total');
    var badgeEl = document.getElementById(key + '-badge');
    if (!snap) {
      totalEl.textContent = 'No data yet';
      badgeEl.textContent = 'awaiting first push';
      badgeEl.style.background = 'var(--muted)';
      return;
    }
    totalEl.textContent = fmtDollar(snap.total_value, { cents: true });
    var history = snap.history || [];
    var series = history.map(function (h) { return Number(h.value); });
    var dates = history.map(function (h) { return fmtDate(h.date); });
    if (series.length >= 2) {
      var pct = ((series[series.length - 1] - series[0]) / series[0]) * 100;
      badgeEl.textContent = (pct >= 0 ? '↑ ' : '↓ ') + Math.abs(pct).toFixed(2) + '% · 30d';
      badgeEl.style.background = pct >= 0 ? 'var(--good)' : 'var(--critical)';
    } else {
      badgeEl.textContent = 'first snapshot';
      badgeEl.style.background = 'var(--muted)';
    }
    renderLine('spark-' + key, series, dates, 5);
  });
}

function renderStatusRow() {
  var row = document.getElementById('status-row');
  var count = latestFinance ? '≥ 1 week logged' : 'No weeks logged yet';
  row.innerHTML = '<span class="dot ' + (latestFinance ? 'ready' : '') + '"></span> ' + count;
}

// ---- "Add financial info" form ----
var overlay = document.getElementById('finance-modal-overlay');
var form = document.getElementById('finance-form');
var cardsRows = document.getElementById('cards-rows');
var transactionsRows = document.getElementById('transactions-rows');

function addCardRow(label, balance) {
  var row = document.createElement('div');
  row.className = 'repeat-row card-row';
  row.innerHTML =
    '<input type="text" placeholder="Label (e.g. CFP)" class="card-label" value="' + (label || '') + '">' +
    '<input type="number" step="0.01" placeholder="Balance" class="card-balance" value="' + (balance != null ? balance : '') + '">' +
    '<button type="button" class="remove-row">&times;</button>';
  row.querySelector('.remove-row').addEventListener('click', function () { row.remove(); });
  cardsRows.appendChild(row);
}

function addTransactionRow(category, amount) {
  var row = document.createElement('div');
  row.className = 'repeat-row transaction-row';
  row.innerHTML =
    '<input type="text" placeholder="Category" class="txn-category" value="' + (category || '') + '">' +
    '<input type="number" step="0.01" placeholder="Amount" class="txn-amount" value="' + (amount != null ? amount : '') + '">' +
    '<button type="button" class="remove-row">&times;</button>';
  row.querySelector('.remove-row').addEventListener('click', function () { row.remove(); });
  transactionsRows.appendChild(row);
}

document.getElementById('add-card-row').addEventListener('click', function () { addCardRow(); });
document.getElementById('add-transaction-row').addEventListener('click', function () { addTransactionRow(); });

document.getElementById('open-finance-form').addEventListener('click', function () {
  cardsRows.innerHTML = '';
  transactionsRows.innerHTML = '';
  document.getElementById('finance-form-status').textContent = '';
  if (latestFinance) {
    document.getElementById('bank-balance-input').value = latestFinance.bank_balance;
    (latestFinance.cards || []).forEach(function (c) { addCardRow(c.label, c.balance); });
  } else {
    addCardRow();
  }
  if (!latestFinance || !(latestFinance.cards || []).length) addCardRow();
  addTransactionRow();
  overlay.classList.add('open');
});

document.getElementById('cancel-finance-form').addEventListener('click', function () {
  overlay.classList.remove('open');
});
overlay.addEventListener('click', function (e) {
  if (e.target === overlay) overlay.classList.remove('open');
});

form.addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('finance-form-status');
  statusEl.textContent = '';
  statusEl.className = 'form-status';

  var bankBalance = parseFloat(document.getElementById('bank-balance-input').value);
  var income = parseFloat(document.getElementById('income-input').value) || 0;

  var cards = Array.from(cardsRows.querySelectorAll('.card-row')).map(function (row) {
    return {
      label: row.querySelector('.card-label').value.trim(),
      balance: parseFloat(row.querySelector('.card-balance').value) || 0,
    };
  }).filter(function (c) { return c.label; });

  var transactions = Array.from(transactionsRows.querySelectorAll('.transaction-row')).map(function (row) {
    return {
      category: row.querySelector('.txn-category').value.trim(),
      amount: parseFloat(row.querySelector('.txn-amount').value) || 0,
    };
  }).filter(function (t) { return t.category; });

  try {
    var res = await fetch('/api/finance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bank_balance: bankBalance, cards: cards, income: income, transactions: transactions }),
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    statusEl.textContent = 'Saved.';
    statusEl.className = 'form-status ok';
    await loadFinanceAndRobinhood();
    setTimeout(function () { overlay.classList.remove('open'); }, 600);
  } catch (err) {
    statusEl.textContent = 'Failed to save: ' + err.message;
    statusEl.className = 'form-status error';
  }
});

// ---- boot ----
loadCalendar();
loadSubscriptions();
loadFinanceAndRobinhood();
