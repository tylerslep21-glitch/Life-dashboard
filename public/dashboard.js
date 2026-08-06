// ---- clock ----
function renderClock() {
  var el = document.getElementById('clock');
  var opts = { weekday: 'long', month: 'long', day: 'numeric' };
  el.textContent = new Date().toLocaleDateString(undefined, opts);
}
renderClock();
setInterval(renderClock, 60000);

// ---- theme: dark after sunset, light after sunrise, based on real location ----
var sunTimesCache = null; // {date: 'YYYY-MM-DD', sunrise: Date, sunset: Date}

function applyThemeFromSunTimes() {
  if (!sunTimesCache) return;
  var now = new Date();
  var isDark = now < sunTimesCache.sunrise || now > sunTimesCache.sunset;
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

function fetchSunTimes(lat, lng) {
  var todayStr = new Date().toISOString().slice(0, 10);
  if (sunTimesCache && sunTimesCache.date === todayStr) {
    applyThemeFromSunTimes();
    return;
  }
  fetch('https://api.sunrise-sunset.org/json?lat=' + lat + '&lng=' + lng + '&formatted=0')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.status !== 'OK') return;
      sunTimesCache = {
        date: todayStr,
        sunrise: new Date(data.results.sunrise),
        sunset: new Date(data.results.sunset),
      };
      applyThemeFromSunTimes();
    })
    .catch(function () { /* leave theme on OS default if this fails */ });
}

// Cache the granted coordinates so returning visits reuse them instead of
// prompting for location again every load.
var GEO_STORAGE_KEY = 'lifeDashboardGeo';

function getStoredGeo() {
  try {
    var raw = localStorage.getItem(GEO_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function storeGeo(lat, lng) {
  try {
    localStorage.setItem(GEO_STORAGE_KEY, JSON.stringify({ lat: lat, lng: lng }));
  } catch (err) { /* localStorage unavailable - just skip caching */ }
}

function watchSunTimes(lat, lng) {
  fetchSunTimes(lat, lng);
  // Re-check every 10 min so an open page actually flips at the real moment,
  // and re-fetch once the calendar date rolls over to a new day's times.
  setInterval(function () { fetchSunTimes(lat, lng); }, 10 * 60 * 1000);
}

function initSunTheme() {
  var stored = getStoredGeo();
  if (stored) {
    watchSunTimes(stored.lat, stored.lng);
    return;
  }
  if (!navigator.geolocation) return; // falls back to prefers-color-scheme media query
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      storeGeo(lat, lng);
      watchSunTimes(lat, lng);
    },
    function () { /* permission denied or unavailable - leave theme on OS default */ }
  );
}
initSunTheme();

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
// For calendar-day-only values (YYYY-MM-DD, or a Date built from UTC math with no
// real time-of-day) - rendering these in the viewer's local timezone can shift the
// displayed day backward for negative UTC offsets. Force UTC so the date always
// matches the underlying calendar date, not a local-time reinterpretation of it.
function fmtDateOnly(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
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
  // cache: 'no-store' - the API doesn't send its own Cache-Control, so
  // without this a browser (iOS/PWA especially) can serve a stale cached
  // response for something like /api/finance/history even after a hard
  // reload of the page itself pulls fresh JS.
  var res = await fetch(url, { cache: 'no-store' });
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

var currentSubscriptions = [];

function nextRenewal(purchaseDate, cadence) {
  if (!purchaseDate) return null;
  var d = new Date(purchaseDate); // API returns a full ISO timestamp already
  if (isNaN(d.getTime())) return null;
  var now = new Date();
  var guard = 0;
  while (d <= now && guard < 1000) {
    if (cadence === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    guard++;
  }
  return d;
}

async function loadSubscriptions() {
  try {
    currentSubscriptions = await getJSON('/api/subscriptions');
    renderSubscriptionsList();
  } catch (err) {
    document.getElementById('subscriptions-list').innerHTML = '<li>Failed to load</li>';
  }
}

var RENEWAL_WARNING_DAYS = 3;

// Whole calendar days until `renewal` (local midnight to local midnight, not
// a raw ms/86400000 divide - that would round a renewal later *today* down
// to 0 correctly but could round one that's actually tomorrow morning down
// to 0 too, depending on what time it is right now).
function daysUntil(renewal) {
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var target = new Date(renewal); target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function renderSubscriptionsList() {
  var subs = currentSubscriptions;
  var list = document.getElementById('subscriptions-list');
  if (!subs.length) {
    list.innerHTML = '<li>No subscriptions logged yet</li>';
    return;
  }
  var totalMonthly = 0;
  var rows = subs.map(function (s) {
    var monthly = s.cadence === 'yearly' ? Number(s.amount) / 12 : Number(s.amount);
    totalMonthly += monthly;
    var renewal = nextRenewal(s.purchase_date, s.cadence);
    var renewalStr = '';
    if (renewal) {
      var days = daysUntil(renewal);
      var soon = days <= RENEWAL_WARNING_DAYS;
      var dayLabel = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : 'in ' + days + ' days';
      var dateLabel = renewal.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      renewalStr = ' &middot; <span' + (soon ? ' class="renewing-soon"' : '') + '>renews ' + dateLabel + (soon ? ' (' + dayLabel + ')' : '') + '</span>';
    }
    var label = (s.cadence === 'yearly' ? fmtDollar(s.amount, { cents: true }) + '/yr' : fmtDollar(s.amount, { cents: true }) + '/mo') + renewalStr;
    return '<li><span>' + s.name + '</span><span class="amt">' + label + '</span></li>';
  });
  rows.push('<li><strong>Total</strong><span class="amt"><strong>' + fmtDollar(totalMonthly, { cents: true }) + '/mo</strong></span></li>');
  list.innerHTML = rows.join('');
}

function renderSubscriptionsManageList() {
  var el = document.getElementById('subscriptions-manage-list');
  if (!currentSubscriptions.length) {
    el.innerHTML = '<p style="font-size:0.85rem;color:var(--muted);">No subscriptions yet.</p>';
    return;
  }
  el.innerHTML = currentSubscriptions.map(function (s) {
    var period = s.cadence === 'yearly' ? '/yr' : '/mo';
    return (
      '<div class="sub-row" data-id="' + s.id + '">' +
        '<span class="sub-name">' + s.name + ' &mdash; ' + fmtDollar(s.amount, { cents: true }) + period + '</span>' +
        '<button type="button" class="sub-remove" data-id="' + s.id + '" aria-label="Delete">&times;</button>' +
      '</div>'
    );
  }).join('');
  el.querySelectorAll('.sub-remove').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      await fetch('/api/subscriptions/' + btn.dataset.id, { method: 'DELETE' });
      await loadSubscriptions();
      renderSubscriptionsManageList();
    });
  });
}

var subOverlay = document.getElementById('subscriptions-modal-overlay');
document.getElementById('open-subscriptions-form').addEventListener('click', function () {
  document.getElementById('subscription-form-status').textContent = '';
  renderSubscriptionsManageList();
  subOverlay.classList.add('open');
});
document.getElementById('cancel-subscription-form').addEventListener('click', function () {
  subOverlay.classList.remove('open');
});
subOverlay.addEventListener('click', function (e) {
  if (e.target === subOverlay) subOverlay.classList.remove('open');
});

document.getElementById('subscription-add-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('subscription-form-status');
  var name = document.getElementById('sub-name-input').value.trim();
  var amount = parseFloat(document.getElementById('sub-amount-input').value);
  var cadence = document.getElementById('sub-cadence-input').value;
  var purchaseDate = document.getElementById('sub-purchase-date-input').value || null;

  try {
    var res = await fetch('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, amount: amount, cadence: cadence, purchase_date: purchaseDate }),
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    statusEl.textContent = 'Added.';
    statusEl.className = 'form-status ok';
    document.getElementById('subscription-add-form').reset();
    await loadSubscriptions();
    renderSubscriptionsManageList();
  } catch (err) {
    statusEl.textContent = 'Failed to add: ' + err.message;
    statusEl.className = 'form-status error';
  }
});

var latestFinance = null;   // still used by the "Add financial info" form to prefill
var latestRobinhood = [];   // drives the standalone Agentic/Individual widgets

// ---- week navigation state ----
function mondayOf(date) {
  // Uses the LOCAL calendar date (not getUTC*) to decide what "today" is -
  // otherwise anyone west of Greenwich rolls into next week's bucket hours
  // before their own local midnight (e.g. 8pm Eastern is already the next
  // UTC day), making next week's data appear to "start" a day early.
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var day = d.getUTCDay();
  var diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}
function isoDate(d) { return d.toISOString().slice(0, 10); }

// Mirrors weekStart() in routes/finance.js exactly (pure UTC, no local-date
// adjustment) - used wherever we need to bucket an already-stored logged_at
// into the same week the server would, e.g. deduping /history entries for
// the bank chart below. mondayOf() above deliberately disagrees with this
// near the UTC week boundary (that's its whole point, for "what week is
// today" from the viewer's own clock) - reusing it here caused a corrected
// entry and the stale one it was meant to replace to land in different
// chart buckets even though the server correctly treats them as the same
// week, so the correction never actually overwrote the old point.
function utcMondayOf(date) {
  var d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  var day = d.getUTCDay();
  var diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

var currentWeekStart = mondayOf(new Date());
var earliestWeekStart = null; // fetched once at boot
var selectedWeekStart = currentWeekStart;
var currentWeekData = null; // the aggregated /api/finance/week response for selectedWeekStart

async function loadFinanceAndRobinhood() {
  try {
    latestFinance = await getJSON('/api/finance/latest');
  } catch (err) { latestFinance = null; }
  try {
    latestRobinhood = await getJSON('/api/robinhood/latest');
  } catch (err) { latestRobinhood = []; }
  try {
    var earliest = await getJSON('/api/finance/earliest-week');
    earliestWeekStart = earliest ? new Date(earliest.week_of + 'T00:00:00Z') : currentWeekStart;
  } catch (err) { earliestWeekStart = currentWeekStart; }

  renderBankWidget();
  renderRobinhoodWidgets();
  await loadWeekView();
}

async function loadWeekView() {
  var weekOfStr = isoDate(selectedWeekStart);
  var weekLabelEl = document.getElementById('week-label');
  weekLabelEl.textContent = 'Week of ' + selectedWeekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  document.getElementById('week-prev').disabled = earliestWeekStart && selectedWeekStart <= earliestWeekStart;
  document.getElementById('week-next').disabled = selectedWeekStart >= currentWeekStart;

  var weekData, robinhoodAsOf;
  try {
    weekData = await getJSON('/api/finance/week?date=' + weekOfStr);
  } catch (err) {
    weekData = { bank_balance: null, cards: [], income: 0, transactions: [], entry_count: 0 };
  }
  currentWeekData = weekData;
  try {
    var weekEnd = new Date(selectedWeekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    if (weekEnd > new Date()) weekEnd = new Date();
    robinhoodAsOf = await getJSON('/api/robinhood/as-of?date=' + isoDate(weekEnd));
  } catch (err) {
    robinhoodAsOf = [];
  }

  renderNetWorthAndSpending(weekData, robinhoodAsOf);
  renderStatusRow(weekData);
}

function renderNetWorthAndSpending(weekData, robinhoodAsOf) {
  var hasData = weekData.entry_count > 0;
  var bank = hasData ? Number(weekData.bank_balance) : 0;
  var cards = hasData ? weekData.cards || [] : [];
  var robinhoodTotal = robinhoodAsOf.reduce(function (sum, r) { return sum + Number(r.value); }, 0);
  var liabilities = cards.reduce(function (sum, c) { return sum + Number(c.balance); }, 0);
  var netWorth = bank + robinhoodTotal - liabilities;

  document.getElementById('stat-net-worth').textContent = hasData || robinhoodAsOf.length ? fmtDollar(netWorth, { cents: true }) : 'No data this week';

  var spent = (weekData.transactions || []).reduce(function (s, t) { return s + Number(t.amount); }, 0);
  var income = Number(weekData.income) || 0;
  document.getElementById('stat-spent').textContent = fmtDollar(spent, { cents: true });
  document.getElementById('stat-income').textContent = fmtDollar(income, { cents: true });

  var networthRows = [];
  if (hasData) networthRows.push({ label: 'Bank', value: bank });
  if (robinhoodTotal > 0 || robinhoodAsOf.length) networthRows.push({ label: 'Investments', value: robinhoodTotal });
  cards.forEach(function (c) { networthRows.push({ label: c.label, value: -Number(c.balance) }); });
  renderBars('networth-bars', networthRows, { signed: true, cents: true });

  var byCategory = {};
  (weekData.transactions || []).forEach(function (t) {
    byCategory[t.category] = (byCategory[t.category] || 0) + Number(t.amount);
  });
  var spendingRows = Object.keys(byCategory).map(function (cat) { return { label: cat, value: byCategory[cat] }; });
  var palette = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
  renderBars('spending-bars', spendingRows, { colors: palette, cents: true });
}

document.getElementById('week-prev').addEventListener('click', function () {
  var d = new Date(selectedWeekStart);
  d.setUTCDate(d.getUTCDate() - 7);
  selectedWeekStart = d;
  loadWeekView();
});
document.getElementById('week-next').addEventListener('click', function () {
  var d = new Date(selectedWeekStart);
  d.setUTCDate(d.getUTCDate() + 7);
  selectedWeekStart = d;
  loadWeekView();
});

async function renderBankWidget() {
  try {
    var history = await getJSON('/api/finance/history?limit=52');
    // Backfilling/correcting a past week adds another row for that week
    // rather than overwriting it - flows like transactions still need to
    // accumulate across entries within a week (see the finance-form submit
    // handler). For this point-in-time balance chart though, collapse down
    // to one point per week (the latest entry wins) so a correction updates
    // that week's point instead of showing up as an extra blip next to it.
    var latestPerWeek = {};
    history.forEach(function (h) {
      var wk = isoDate(utcMondayOf(new Date(h.logged_at)));
      if (!latestPerWeek[wk] || new Date(h.logged_at) > new Date(latestPerWeek[wk].logged_at)) {
        latestPerWeek[wk] = h;
      }
    });
    var weeklyHistory = Object.keys(latestPerWeek).sort().map(function (wk) { return latestPerWeek[wk]; });
    var series = weeklyHistory.map(function (h) { return Number(h.bank_balance); });
    var dates = weeklyHistory.map(function (h) { return fmtDate(h.logged_at); });
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
    var dates = history.map(function (h) { return fmtDateOnly(h.date); });
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

// ---- line chart (ported from the artifact) ----
function renderLine(id, series, dates, xTicks) {
  var el = document.getElementById(id);
  if (!el) return;
  if (!series.length) { el.innerHTML = ''; return; }

  // Reconstructed history can pad the front with 0 before the account/data
  // actually existed (e.g. less than a year of real history) - trim that
  // leading run so the chart starts at the first real point instead of a
  // flat line dragging up from 0.
  var firstReal = series.findIndex(function (v) { return v !== 0; });
  if (firstReal > 0) {
    series = series.slice(firstReal);
    dates = dates.slice(firstReal);
  }
  if (!series.length) { el.innerHTML = ''; return; }

  var W = 300, H = 90, pad = 4;
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

function renderStatusRow(weekData) {
  var row = document.getElementById('status-row');
  var hasData = weekData && weekData.entry_count > 0;
  var count = hasData
    ? weekData.entry_count + ' ' + (weekData.entry_count === 1 ? 'entry' : 'entries') + ' logged this week'
    : 'No entries logged this week';
  row.innerHTML = '<span class="dot ' + (hasData ? 'ready' : '') + '"></span> ' + count;
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

var TRANSACTION_CATEGORIES = [
  'Subscriptions', 'Gas', 'Travel', 'Online Retail', 'Retail', 'Groceries',
  'Personal Transfers', 'Dining', 'Home/Car', 'Entertainment', 'Health/Medical',
  'Utilities', 'Gift', 'Other',
];

function categorySelectHTML(selected) {
  return TRANSACTION_CATEGORIES.map(function (c) {
    return '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + '</option>';
  }).join('');
}

function addTransactionRow(category, amount) {
  var row = document.createElement('div');
  row.className = 'repeat-row transaction-row';
  row.innerHTML =
    '<select class="txn-category">' + categorySelectHTML(category) + '</select>' +
    '<input type="number" step="0.01" placeholder="Amount" class="txn-amount" value="' + (amount != null ? amount : '') + '">' +
    '<button type="button" class="remove-row">&times;</button>';
  row.querySelector('.remove-row').addEventListener('click', function () { row.remove(); });
  transactionsRows.appendChild(row);
}

document.getElementById('add-card-row').addEventListener('click', function () { addCardRow(); });
document.getElementById('add-transaction-row').addEventListener('click', function () { addTransactionRow(); });

function isCurrentWeekSelected() { return isoDate(selectedWeekStart) === isoDate(currentWeekStart); }

document.getElementById('open-finance-form').addEventListener('click', function () {
  cardsRows.innerHTML = '';
  transactionsRows.innerHTML = '';
  document.getElementById('finance-form-status').textContent = '';

  var isCurrent = isCurrentWeekSelected();
  document.getElementById('finance-form-title').textContent = isCurrent
    ? 'Add financial info'
    : 'Add financial info — Week of ' + selectedWeekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // Prefill bank/cards from the selected week's own entry if it has one
  // (fixing/adding to that week specifically); otherwise fall back to the
  // most recent known values as a starting point.
  var base = (currentWeekData && currentWeekData.entry_count > 0) ? currentWeekData : latestFinance;
  if (base) {
    document.getElementById('bank-balance-input').value = base.bank_balance;
    (base.cards || []).forEach(function (c) { addCardRow(c.label, c.balance); });
  } else {
    addCardRow();
  }
  if (!base || !(base.cards || []).length) addCardRow();
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

  var payload = { bank_balance: bankBalance, cards: cards, income: income, transactions: transactions };
  if (!isCurrentWeekSelected()) {
    var loggedAt;
    if (currentWeekData && currentWeekData.entry_count > 0 && currentWeekData.logged_at) {
      // This week already has an entry - land 1s after its logged_at rather
      // than at a fixed mid-week stamp. /api/finance/week picks whichever
      // entry has the latest logged_at as "current" for point-in-time fields
      // (bank_balance, cards); a fixed Wednesday stamp could sort *before*
      // an existing entry logged later in the week, silently losing a
      // correction to the older figure instead of overwriting it.
      loggedAt = new Date(currentWeekData.logged_at);
      loggedAt.setUTCSeconds(loggedAt.getUTCSeconds() + 1);
    } else {
      // No entry yet this week - stamp it mid-week so it lands in that
      // week's bucket regardless of what day it is today.
      loggedAt = new Date(selectedWeekStart);
      loggedAt.setUTCDate(loggedAt.getUTCDate() + 3);
    }
    payload.logged_at = loggedAt.toISOString();
  }

  try {
    var res = await fetch('/api/finance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

// ---- edit/delete transactions for the selected week ----
var txnOverlay = document.getElementById('transactions-modal-overlay');

async function renderTransactionsManageList() {
  var el = document.getElementById('transactions-manage-list');
  document.getElementById('transactions-modal-title').textContent =
    'Transactions — Week of ' + selectedWeekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  var entries;
  try {
    entries = await getJSON('/api/finance/entries-in-week?date=' + isoDate(selectedWeekStart));
  } catch (err) {
    el.innerHTML = '<p style="font-size:0.85rem;color:var(--muted);">Failed to load.</p>';
    return;
  }
  var anyTxn = entries.some(function (e) { return (e.transactions || []).length; });
  if (!anyTxn) {
    el.innerHTML = '<p style="font-size:0.85rem;color:var(--muted);">No transactions logged this week.</p>';
    return;
  }
  el.innerHTML = entries.flatMap(function (entry) {
    return (entry.transactions || []).map(function (t, idx) {
      return (
        '<div class="repeat-row transaction-row" data-entry-id="' + entry.id + '" data-idx="' + idx + '">' +
          '<select class="txn-category">' + categorySelectHTML(t.category) + '</select>' +
          '<input type="number" step="0.01" class="txn-amount" value="' + t.amount + '">' +
          '<button type="button" class="remove-row">&times;</button>' +
        '</div>'
      );
    });
  }).join('');

  el.querySelectorAll('.transaction-row').forEach(function (row) {
    var entryId = row.dataset.entryId;
    var idx = Number(row.dataset.idx);
    var entry = entries.find(function (e) { return String(e.id) === entryId; });

    function saveRow() {
      var updated = entry.transactions.slice();
      updated[idx] = {
        category: row.querySelector('.txn-category').value,
        amount: parseFloat(row.querySelector('.txn-amount').value) || 0,
      };
      return fetch('/api/finance/' + entryId + '/transactions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: updated }),
      });
    }

    row.querySelector('.txn-category').addEventListener('change', async function () {
      await saveRow();
      await loadWeekView();
    });
    row.querySelector('.txn-amount').addEventListener('change', async function () {
      await saveRow();
      await loadWeekView();
    });
    row.querySelector('.remove-row').addEventListener('click', async function () {
      var updated = entry.transactions.slice();
      updated.splice(idx, 1);
      await fetch('/api/finance/' + entryId + '/transactions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: updated }),
      });
      await loadWeekView();
      renderTransactionsManageList();
    });
  });
}

document.getElementById('open-transactions-form').addEventListener('click', function () {
  document.getElementById('transactions-form-status').textContent = '';
  renderTransactionsManageList();
  txnOverlay.classList.add('open');
});
document.getElementById('cancel-transactions-form').addEventListener('click', function () {
  txnOverlay.classList.remove('open');
});
txnOverlay.addEventListener('click', function (e) {
  if (e.target === txnOverlay) txnOverlay.classList.remove('open');
});

// ---- Exams / Big Projects ----
var currentExams = [];

async function loadExams() {
  try {
    currentExams = await getJSON('/api/exams');
    renderExamsList();
  } catch (err) {
    document.getElementById('exams-list').innerHTML = '<li>Failed to load</li>';
  }
}

function daysUntil(dateStr) {
  var target = new Date(dateStr);
  var now = new Date();
  var startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  var startOfTarget = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  return Math.round((startOfTarget - startOfToday) / (1000 * 60 * 60 * 24));
}

function renderExamsList() {
  var list = document.getElementById('exams-list');
  var upcoming = currentExams.filter(function (e) { return daysUntil(e.event_date) >= 0; });
  if (!upcoming.length) {
    list.innerHTML = '<div class="empty-state">Nothing upcoming</div>';
    return;
  }
  list.innerHTML = upcoming.map(function (e) {
    var d = daysUntil(e.event_date);
    var when = d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d + ' days';
    return (
      '<li class="event-item">' +
        '<span class="event-date">' + fmtDateOnly(e.event_date) + '</span>' +
        '<span class="event-title">' + e.name + (e.course ? ' &middot; ' + e.course : '') + '</span>' +
        '<span style="margin-left:auto;font-size:0.7rem;color:var(--muted);">' + when + '</span>' +
      '</li>'
    );
  }).join('');
}

function renderExamsManageList() {
  var el = document.getElementById('exams-manage-list');
  if (!currentExams.length) {
    el.innerHTML = '<p style="font-size:0.85rem;color:var(--muted);">No exams/projects yet.</p>';
    return;
  }
  el.innerHTML = currentExams.map(function (e) {
    return (
      '<div class="sub-row" data-id="' + e.id + '">' +
        '<span class="sub-name">' + e.name + (e.course ? ' &mdash; ' + e.course : '') + ' &middot; ' + fmtDateOnly(e.event_date) + '</span>' +
        '<button type="button" class="sub-remove" data-id="' + e.id + '" aria-label="Delete">&times;</button>' +
      '</div>'
    );
  }).join('');
  el.querySelectorAll('.sub-remove').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      await fetch('/api/exams/' + btn.dataset.id, { method: 'DELETE' });
      await loadExams();
      renderExamsManageList();
    });
  });
}

var examsOverlay = document.getElementById('exams-modal-overlay');
document.getElementById('open-exams-form').addEventListener('click', function () {
  document.getElementById('exam-form-status').textContent = '';
  renderExamsManageList();
  examsOverlay.classList.add('open');
});
document.getElementById('cancel-exam-form').addEventListener('click', function () {
  examsOverlay.classList.remove('open');
});
examsOverlay.addEventListener('click', function (e) { if (e.target === examsOverlay) examsOverlay.classList.remove('open'); });

document.getElementById('exam-add-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('exam-form-status');
  var name = document.getElementById('exam-name-input').value.trim();
  var date = document.getElementById('exam-date-input').value;
  var course = document.getElementById('exam-course-input').value.trim();
  try {
    var res = await fetch('/api/exams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, event_date: date, course: course || null }),
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    statusEl.textContent = 'Added.';
    statusEl.className = 'form-status ok';
    document.getElementById('exam-add-form').reset();
    await loadExams();
    renderExamsManageList();
  } catch (err) {
    statusEl.textContent = 'Failed to add: ' + err.message;
    statusEl.className = 'form-status error';
  }
});

// ---- Countdowns ----
var currentCountdowns = [];

async function loadCountdowns() {
  try {
    currentCountdowns = await getJSON('/api/countdowns');
    renderCountdownsList();
  } catch (err) {
    document.getElementById('countdown-primary-name').textContent = 'Failed to load';
  }
}

function whenLabel(d) {
  return d === 0 ? 'Today' : d === 1 ? '1 day' : d + ' days';
}

function renderCountdownsList() {
  var photoEl = document.getElementById('countdown-photo');
  var nameEl = document.getElementById('countdown-primary-name');
  var daysEl = document.getElementById('countdown-primary-days');
  var secondaryEl = document.getElementById('countdown-secondary');

  var upcoming = currentCountdowns
    .filter(function (c) { return daysUntil(c.target_date) >= 0; })
    .sort(function (a, b) { return daysUntil(a.target_date) - daysUntil(b.target_date); })
    .slice(0, 2);

  if (!upcoming.length) {
    photoEl.className = 'countdown-photo';
    photoEl.style.backgroundImage = '';
    nameEl.textContent = 'Nothing upcoming';
    daysEl.textContent = '';
    secondaryEl.style.display = 'none';
    return;
  }

  var primary = upcoming[0];
  if (primary.image_url) {
    photoEl.className = 'countdown-photo has-photo';
    photoEl.style.backgroundImage = 'url("' + primary.image_url + '")';
  } else {
    photoEl.className = 'countdown-photo';
    photoEl.style.backgroundImage = '';
  }
  nameEl.textContent = primary.name;
  daysEl.textContent = whenLabel(daysUntil(primary.target_date));

  if (upcoming[1]) {
    secondaryEl.style.display = 'flex';
    secondaryEl.innerHTML =
      '<span>' + upcoming[1].name + '</span>' +
      '<span class="amt">' + whenLabel(daysUntil(upcoming[1].target_date)) + '</span>';
  } else {
    secondaryEl.style.display = 'none';
  }
}

function renderCountdownsManageList() {
  var el = document.getElementById('countdowns-manage-list');
  if (!currentCountdowns.length) {
    el.innerHTML = '<p style="font-size:0.85rem;color:var(--muted);">No countdowns yet.</p>';
    return;
  }
  el.innerHTML = currentCountdowns.map(function (c) {
    return (
      '<div class="sub-row" data-id="' + c.id + '">' +
        '<span class="sub-name">' + c.name + ' &mdash; ' + fmtDateOnly(c.target_date) + '</span>' +
        '<button type="button" class="sub-remove" data-id="' + c.id + '" aria-label="Delete">&times;</button>' +
      '</div>'
    );
  }).join('');
  el.querySelectorAll('.sub-remove').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      await fetch('/api/countdowns/' + btn.dataset.id, { method: 'DELETE' });
      await loadCountdowns();
      renderCountdownsManageList();
    });
  });
}

var countdownsOverlay = document.getElementById('countdowns-modal-overlay');
document.getElementById('open-countdowns-form').addEventListener('click', function () {
  document.getElementById('countdown-form-status').textContent = '';
  renderCountdownsManageList();
  countdownsOverlay.classList.add('open');
});
document.getElementById('cancel-countdown-form').addEventListener('click', function () {
  countdownsOverlay.classList.remove('open');
});
countdownsOverlay.addEventListener('click', function (e) { if (e.target === countdownsOverlay) countdownsOverlay.classList.remove('open'); });

function readFileAsDataURL(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

document.getElementById('countdown-add-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('countdown-form-status');
  var name = document.getElementById('countdown-name-input').value.trim();
  var date = document.getElementById('countdown-date-input').value;
  var urlInput = document.getElementById('countdown-image-url-input').value.trim();
  var fileInput = document.getElementById('countdown-image-file-input');
  var imageUrl = urlInput || null;

  if (fileInput.files && fileInput.files[0]) {
    var file = fileInput.files[0];
    if (file.size > 4 * 1024 * 1024) {
      statusEl.textContent = 'Photo is too large (max 4MB).';
      statusEl.className = 'form-status error';
      return;
    }
    try {
      imageUrl = await readFileAsDataURL(file);
    } catch (err) {
      statusEl.textContent = 'Failed to read photo file.';
      statusEl.className = 'form-status error';
      return;
    }
  }

  try {
    var res = await fetch('/api/countdowns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, target_date: date, image_url: imageUrl }),
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    statusEl.textContent = 'Added.';
    statusEl.className = 'form-status ok';
    document.getElementById('countdown-add-form').reset();
    await loadCountdowns();
    renderCountdownsManageList();
  } catch (err) {
    statusEl.textContent = 'Failed to add: ' + err.message;
    statusEl.className = 'form-status error';
  }
});

// ---- AI Agent Tracker (read-only display - pushed by an external scheduled agent) ----
async function loadAgentTracker() {
  var list = document.getElementById('agent-tracker-list');
  try {
    var agents = await getJSON('/api/agent-tracker?recurring=true');
    if (!agents.length) {
      list.innerHTML = '<li>No agents reporting yet</li>';
      return;
    }
    list.innerHTML = agents.map(function (a) {
      var statusLower = (a.status_summary || '').toLowerCase();
      var pillColor = statusLower.indexOf('error') !== -1 ? 'var(--critical)'
        : statusLower.indexOf('paused') !== -1 ? 'var(--muted)'
        : 'var(--good)';
      var lastRun = new Date(a.last_run_at).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      return (
        '<li style="display:block;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span style="font-weight:600;">' + a.agent_name + '</span>' +
            '<span class="pill" style="background:' + pillColor + ';">' + a.status_summary + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--muted);margin-top:0.2rem;">' +
            '<span>' + (a.action_taken || '&mdash;') + '</span>' +
            '<span>' + lastRun + '</span>' +
          '</div>' +
        '</li>'
      );
    }).join('');
  } catch (err) {
    list.innerHTML = '<li>Failed to load</li>';
  }
}

// ---- To-Do list (drag to reorder, check off, disappears an hour after checking) ----
var currentTodos = [];
var draggedTodoId = null;

async function loadTodos() {
  try {
    currentTodos = await getJSON('/api/todos');
    renderTodosList();
  } catch (err) {
    document.getElementById('todo-list').innerHTML = '<li>Failed to load</li>';
  }
}

function renderTodosList() {
  var list = document.getElementById('todo-list');
  if (!currentTodos.length) {
    list.innerHTML = '<li style="color:var(--muted);font-size:0.85rem;padding:0.4rem;">Nothing on the list</li>';
    return;
  }
  list.innerHTML = currentTodos.map(function (t) {
    var checked = !!t.checked_at;
    return (
      '<li class="todo-row' + (checked ? ' checked' : '') + '" draggable="true" data-id="' + t.id + '">' +
        '<span class="todo-drag-handle">&#9776;</span>' +
        '<input type="checkbox" class="todo-checkbox"' + (checked ? ' checked' : '') + '>' +
        '<span class="todo-text">' + t.text + '</span>' +
      '</li>'
    );
  }).join('');

  list.querySelectorAll('.todo-checkbox').forEach(function (cb) {
    cb.addEventListener('change', async function () {
      var row = cb.closest('.todo-row');
      var id = row.dataset.id;
      row.classList.toggle('checked', cb.checked);
      await fetch('/api/todos/' + id + '/check', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: cb.checked }),
      });
    });
  });

  list.querySelectorAll('.todo-row').forEach(function (row) {
    row.addEventListener('dragstart', function () {
      draggedTodoId = row.dataset.id;
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
    });
    row.addEventListener('dragover', function (e) {
      e.preventDefault();
      var dragging = list.querySelector('.dragging');
      if (!dragging || dragging === row) return;
      var rect = row.getBoundingClientRect();
      var before = (e.clientY - rect.top) < rect.height / 2;
      list.insertBefore(dragging, before ? row : row.nextSibling);
    });
    row.addEventListener('drop', async function (e) {
      e.preventDefault();
      var order = Array.from(list.querySelectorAll('.todo-row')).map(function (r) { return Number(r.dataset.id); });
      await fetch('/api/todos/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: order }),
      });
    });
  });
}

var todoOverlay = document.getElementById('todo-modal-overlay');
document.getElementById('open-todo-form').addEventListener('click', function () {
  document.getElementById('todo-form-status').textContent = '';
  document.getElementById('todo-text-input').value = '';
  todoOverlay.classList.add('open');
});
document.getElementById('cancel-todo-form').addEventListener('click', function () {
  todoOverlay.classList.remove('open');
});
todoOverlay.addEventListener('click', function (e) { if (e.target === todoOverlay) todoOverlay.classList.remove('open'); });

document.getElementById('todo-add-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('todo-form-status');
  var text = document.getElementById('todo-text-input').value.trim();
  try {
    var res = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    await loadTodos();
    todoOverlay.classList.remove('open');
  } catch (err) {
    statusEl.textContent = 'Failed to add: ' + err.message;
    statusEl.className = 'form-status error';
  }
});

// Periodically reload so checked-off items actually disappear an hour later
// without requiring a manual page refresh.
setInterval(loadTodos, 5 * 60 * 1000);

// ---- News/stocks ticker ----
// Driven by JS (requestAnimationFrame) rather than a CSS @keyframes animation -
// CSS animations on a transform inside a position:sticky ancestor are unstable
// on iOS Safari (confirmed: glitches in and out rather than scrolling smoothly).
var tickerAnimId = null;
var TICKER_CYCLE_SECONDS = 220; // full loop duration, matches the old CSS pace

function startTickerScroll(track) {
  if (tickerAnimId) cancelAnimationFrame(tickerAnimId);
  var oneCopyWidth = track.scrollWidth / 2;
  if (!oneCopyWidth) return;
  var pxPerMs = oneCopyWidth / (TICKER_CYCLE_SECONDS * 1000);
  var offset = 0;
  var lastTs = null;

  function step(ts) {
    if (lastTs !== null) {
      offset = (offset + pxPerMs * (ts - lastTs)) % oneCopyWidth;
      track.style.transform = 'translateX(-' + offset + 'px)';
    }
    lastTs = ts;
    tickerAnimId = requestAnimationFrame(step);
  }
  tickerAnimId = requestAnimationFrame(step);
}

async function loadTicker() {
  var track = document.getElementById('ticker-track');
  try {
    var data = await getJSON('/api/ticker');
    var pieces = [];

    function tickerTag(link) {
      return link ? '<a class="ticker-item" href="' + link + '" target="_blank" rel="noopener">' : '<span class="ticker-item">';
    }
    function tickerClose(link) {
      return link ? '</a>' : '</span>';
    }

    data.indices.forEach(function (idx) {
      var up = idx.changePct >= 0;
      pieces.push(
        tickerTag(idx.link) +
          '<span class="ticker-index-name">' + idx.label + '</span>' +
          '<span>' + fmtDollar(idx.price, { cents: true }) + '</span>' +
          '<span class="' + (up ? 'ticker-index-up' : 'ticker-index-down') + '">' +
            (up ? '&#9650; ' : '&#9660; ') + Math.abs(idx.changePct).toFixed(2) + '%' +
          '</span>' +
        tickerClose(idx.link)
      );
    });

    data.headlines.forEach(function (h) {
      pieces.push(
        tickerTag(h.link) + '<span class="ticker-source">' + h.source + '</span><span>' + h.text + '</span>' + tickerClose(h.link)
      );
    });

    if (!pieces.length) {
      track.innerHTML = '<span class="ticker-loading">No headlines available right now</span>';
      return;
    }

    // Duplicate once so the scroll loop is seamless regardless of content length.
    track.innerHTML = pieces.join('') + pieces.join('');
    startTickerScroll(track);
  } catch (err) {
    track.innerHTML = '<span class="ticker-loading">Ticker failed to load</span>';
  }
}

// ---- sign-in settings (Touch ID / Face ID management) ----
var signinOverlay = document.getElementById('signin-modal-overlay');
var webauthnStatusEl = document.getElementById('webauthn-status');

async function renderWebauthnCredentialsList() {
  var listEl = document.getElementById('webauthn-credentials-list');
  listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">Loading&hellip;</p>';
  try {
    var res = await fetch('/api/auth/webauthn/credentials');
    var creds = await res.json();
    if (!creds.length) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No devices registered yet.</p>';
      return;
    }
    listEl.innerHTML = creds.map(function (c) {
      return (
        '<div class="breakdown-row" data-id="' + c.id + '" style="display:flex;align-items:center;justify-content:space-between;padding:0.4rem 0;">' +
          '<span>' + c.device_label + '</span>' +
          '<button type="button" class="icon-btn remove-webauthn-btn" data-id="' + c.id + '" aria-label="Remove">&times;</button>' +
        '</div>'
      );
    }).join('');
    listEl.querySelectorAll('.remove-webauthn-btn').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        await fetch('/api/auth/webauthn/credentials/' + btn.dataset.id, { method: 'DELETE' });
        renderWebauthnCredentialsList();
      });
    });
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">Could not load.</p>';
  }
}

document.getElementById('open-signin-settings').addEventListener('click', function () {
  webauthnStatusEl.textContent = '';
  renderWebauthnCredentialsList();
  signinOverlay.classList.add('open');
});
document.getElementById('cancel-signin-form').addEventListener('click', function () {
  signinOverlay.classList.remove('open');
});
signinOverlay.addEventListener('click', function (e) {
  if (e.target === signinOverlay) signinOverlay.classList.remove('open');
});

document.getElementById('add-webauthn-device-btn').addEventListener('click', async function () {
  if (!webauthnSupported()) {
    webauthnStatusEl.textContent = 'This browser does not support Touch ID / Face ID sign-in.';
    webauthnStatusEl.className = 'form-status error';
    return;
  }
  webauthnStatusEl.textContent = 'Follow the prompt from your browser or device&hellip;';
  webauthnStatusEl.className = 'form-status';
  try {
    var label = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'Device';
    await registerTouchId(label);
    webauthnStatusEl.textContent = 'Device added.';
    webauthnStatusEl.className = 'form-status ok';
    renderWebauthnCredentialsList();
  } catch (err) {
    webauthnStatusEl.textContent = 'Could not add device: ' + err.message;
    webauthnStatusEl.className = 'form-status error';
  }
});

document.getElementById('signout-btn').addEventListener('click', async function () {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

// ---- shared idle tracking (used by auto-reload below and auto-scroll further down) ----
var ACTIVITY_IDLE_MS = 60 * 1000;
var lastActivityTs = Date.now();
['mousemove', 'mousedown', 'wheel', 'touchstart', 'keydown'].forEach(function (evt) {
  window.addEventListener(evt, function () { lastActivityTs = Date.now(); }, { passive: true });
});

// ---- auto-reload for an always-on desk display ----
// A full page reload (not a soft re-fetch) so every widget - calendar, ticker,
// finance, everything - genuinely starts fresh, not just the ones with their
// own setInterval above. Skipped while someone's actually using it, so an
// in-progress tap/scroll doesn't get yanked out from under them.
setInterval(function () {
  if (Date.now() - lastActivityTs < ACTIVITY_IDLE_MS) return;
  location.reload();
}, 6 * 60 * 1000);

// ---- idle auto-scroll for an always-on desk display ----
// After a stretch with no interaction, the page creeps down on its own so a
// wall-mounted display never looks frozen, looping seamlessly instead of
// visibly resetting - same idea as the horizontal ticker: an inert visual
// duplicate of .shell sits right below the real one (with a gap for
// breathing room at the seam) and the two get moved together with
// wraparound modulo math, so the wrap always lands on a content repeat.
//
// Unlike the ticker though, this moves the whole page, so window.scrollTo
// every frame was tried first and was choppy on iPad even after trimming
// forced layout reads - native scroll updates are apparently just heavier
// than compositor work there. So instead: .shell + its clone get wrapped in
// a plain div, scrollY is frozen once at the top of that wrapper for the
// whole idle-scroll session, and the *wrapper* gets translateY'd - the same
// JS-driven-transform technique startTickerScroll uses, which is GPU
// composited and doesn't touch layout at all. Native scrolling is completely
// unaffected outside of idle sessions - the wrapper only exists while armed.
var AUTO_SCROLL_PX_PER_SEC = 42;
var AUTO_SCROLL_GAP = '3rem'; // breathing room at the seam between repeats

var shellEl = document.querySelector('.shell');
var autoScrollWrapper = null;
var autoScrollArmed = false;
var autoScrollPeriod = 0;  // px of translation = exactly one repeat of the content
var autoScrollY = 0;       // position within [0, autoScrollPeriod)
var autoScrollLastTs = null;

function disarmAutoScroll() {
  if (autoScrollWrapper) {
    // Hand back to native scrolling at the equivalent visual spot, so
    // interrupting mid-loop doesn't cause a jump.
    var targetY = (window.scrollY) + autoScrollY;
    autoScrollWrapper.parentNode.insertBefore(shellEl, autoScrollWrapper);
    autoScrollWrapper.parentNode.removeChild(autoScrollWrapper);
    autoScrollWrapper = null;
    window.scrollTo(0, targetY);
  }
  autoScrollArmed = false;
  autoScrollY = 0;
}

['mousemove', 'mousedown', 'wheel', 'touchstart', 'keydown'].forEach(function (evt) {
  window.addEventListener(evt, disarmAutoScroll, { passive: true });
});

function armAutoScroll(ts) {
  autoScrollWrapper = document.createElement('div');
  shellEl.parentNode.insertBefore(autoScrollWrapper, shellEl);
  autoScrollWrapper.appendChild(shellEl);

  var clone = shellEl.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  clone.removeAttribute('id');
  clone.style.marginTop = AUTO_SCROLL_GAP;
  clone.style.pointerEvents = 'none';
  clone.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
  // cloneNode copies whatever .revealed state the real cards had at this
  // instant - any not yet revealed would otherwise stay invisible in the
  // clone forever, since nothing ever observes these copies. It's a
  // decorative repeat, not worth animating - just show it complete.
  clone.querySelectorAll('.module').forEach(function (el) { el.classList.add('revealed'); });
  autoScrollWrapper.appendChild(clone);

  autoScrollWrapper.style.willChange = 'transform';
  autoScrollPeriod = clone.getBoundingClientRect().top - shellEl.getBoundingClientRect().top;
  autoScrollY = 0;
  autoScrollLastTs = ts;
  autoScrollArmed = true;
}

function autoScrollStep(ts) {
  requestAnimationFrame(autoScrollStep);

  if (Date.now() - lastActivityTs < ACTIVITY_IDLE_MS) {
    autoScrollLastTs = null;
    return;
  }

  if (!autoScrollArmed) {
    armAutoScroll(ts);
    return;
  }
  if (autoScrollPeriod <= 0) return; // page too short to need scrolling

  var dt = ts - autoScrollLastTs;
  autoScrollLastTs = ts;
  autoScrollY = (autoScrollY + AUTO_SCROLL_PX_PER_SEC * dt / 1000) % autoScrollPeriod;
  autoScrollWrapper.style.transform = 'translateY(-' + autoScrollY + 'px)';
}
requestAnimationFrame(autoScrollStep);

// ---- subtle reveal-on-scroll for module cards ----
// Fades/lifts each card in the first time it scrolls into view, then leaves
// it alone (one-time per element, not re-triggered on later loop cycles).
// Anything already visible on load is marked revealed immediately so there's
// no flash-then-fade on first paint.
var revealObserver = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('revealed');
    revealObserver.unobserve(entry.target);
  });
}, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.module').forEach(function (el) {
  var rect = el.getBoundingClientRect();
  if (rect.top < window.innerHeight && rect.bottom > 0) {
    el.classList.add('revealed');
  } else {
    revealObserver.observe(el);
  }
});

// ---- boot ----
loadTicker();
loadCalendar();
loadSubscriptions();
loadExams();
loadCountdowns();
loadAgentTracker();
loadTodos();
loadFinanceAndRobinhood();
