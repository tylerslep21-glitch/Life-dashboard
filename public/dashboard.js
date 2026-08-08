// ---- client-side error reporting (feeds the admin-only Errors widget) ----
// Armed first, before anything else runs, so it catches as much as possible.
// Capped per page load so a tight error loop can't flood error_log or spam
// network requests - 20 is plenty to diagnose a real problem from.
var clientErrorReportCount = 0;
var CLIENT_ERROR_REPORT_MAX = 20;
function reportClientError(message, stack) {
  if (clientErrorReportCount >= CLIENT_ERROR_REPORT_MAX) return;
  clientErrorReportCount++;
  fetch('/api/errors/client', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message).slice(0, 2000), stack: stack ? String(stack).slice(0, 8000) : null, url: window.location.href }),
  }).catch(function () { /* nothing further to do if reporting itself fails */ });
}
window.addEventListener('error', function (e) {
  reportClientError(e.message, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', function (e) {
  var reason = e.reason;
  reportClientError(reason && reason.message ? reason.message : String(reason), reason && reason.stack);
});

// ---- seasonal theme + retro style picker ----
// Applied first, before anything else runs, so a saved preference doesn't
// flash the default theme for a moment before switching over.
//
// Two independent bits of state (see retro.css for the full rationale):
// data-season ALWAYS applies the picked theme's color palette, retro on or
// off - that's what makes a "normal" (non-pixel-art) version of every theme
// exist. data-retro is a plain boolean that layers the 8-bit structural
// styling (pixel font, chunky shadows, scanlines, tiled pattern) on top when
// present. Toggling retro off never loses which season is selected, and
// switching seasons never forces retro on.
var RETRO_ENABLED_KEY = 'lifeDashboardRetroOn';
var RETRO_THEME_KEY = 'lifeDashboardRetroTheme';
var retroToggle = document.getElementById('toggle-retro');
var retroSelect = document.getElementById('retro-theme-select');

// This account's saved custom themes (up to 3, server-side per-user - see
// /api/me's custom_themes and routes/me.js). Populated once /api/me resolves
// in loadWidgetLayout() below; empty until then.
var customThemes = [];
var activeThemeValue = null; // mirrors retroSelect.value: 'default' | a season name | 'custom:<id>'

function findCustomTheme(id) {
  return customThemes.find(function (t) { return t.id === id; });
}

// Applies any theme value: a built-in season name, 'default', or 'custom:<id>'.
// Built-ins are palettes baked into retro.css (data-season="..."); custom
// themes have arbitrary user-picked colors, so they're applied as inline CSS
// custom properties instead - those always win over retro.css's attribute
// selectors, which is why data-season is removed first (a leftover seasonal
// palette must not fight a custom one for the same variables).
function applyTheme(value) {
  var root = document.documentElement;
  if (typeof value === 'string' && value.indexOf('custom:') === 0) {
    var theme = findCustomTheme(value.slice(7));
    if (theme) {
      root.removeAttribute('data-season');
      // All 4 colors set inline, unconditionally - deliberately NOT gated on
      // data-theme (day/night). A custom theme is exactly the colors the
      // user picked, always; --paper-raised specifically is what widget/
      // card backgrounds use, and without setting it here it would keep
      // flipping between the day/night stylesheet values underneath.
      root.style.setProperty('--accent', theme.main);
      root.style.setProperty('--ink', theme.secondary1);
      root.style.setProperty('--paper', theme.secondary2);
      root.style.setProperty('--paper-raised', theme.widgetBg || theme.secondary2);
      root.setAttribute('data-bg-pattern', theme.pattern || 'none');
      if (theme.pattern === 'image' && theme.image) {
        root.style.setProperty('--custom-bg-image', 'url("' + theme.image + '")');
      } else {
        root.style.removeProperty('--custom-bg-image');
      }
      return;
    }
    // Referenced theme no longer exists (e.g. deleted from another device
    // before this one caught up) - fall through to plain Default below.
    value = 'default';
  }
  root.style.removeProperty('--accent');
  root.style.removeProperty('--ink');
  root.style.removeProperty('--paper');
  root.style.removeProperty('--paper-raised');
  root.style.removeProperty('--custom-bg-image');
  root.removeAttribute('data-bg-pattern');
  if (value === 'default') {
    root.removeAttribute('data-season');
  } else {
    root.setAttribute('data-season', value);
  }
}

var retroEnabled = localStorage.getItem(RETRO_ENABLED_KEY) === 'true';
activeThemeValue = localStorage.getItem(RETRO_THEME_KEY) || 'default';
retroSelect.value = activeThemeValue;
applyTheme(activeThemeValue);
if (retroEnabled) {
  document.documentElement.setAttribute('data-retro', 'on');
}

retroToggle.addEventListener('click', function () {
  retroEnabled = !retroEnabled;
  localStorage.setItem(RETRO_ENABLED_KEY, retroEnabled ? 'true' : 'false');
  if (retroEnabled) {
    document.documentElement.setAttribute('data-retro', 'on');
  } else {
    document.documentElement.removeAttribute('data-retro');
  }
  renderChristmasLights();
});

retroSelect.addEventListener('change', function () {
  activeThemeValue = retroSelect.value;
  applyTheme(activeThemeValue);
  localStorage.setItem(RETRO_THEME_KEY, activeThemeValue);
  renderChristmasLights();
});

// ---- inline SVG icon set (replaces emoji throughout the UI, except the
// seasonal theme picker's own <option> emojis above - those are decorative
// theme identifiers a native <select> can't render real icons for anyway). ----
var ICONS = {
  warning: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/></svg>',
  'weather-clear': '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M4.5 12H2M22 12h-2.5M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>',
  'weather-partly-cloudy': '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 2.5v1.3M8 12.2v1.3M2.5 8h1.3M12.9 3.1l-.9.9M3.1 12.9l.9-.9"/><path d="M9 20a4 4 0 1 1 .4-8 5.5 5.5 0 0 1 10.4 2A3.5 3.5 0 0 1 19 20Z"/></svg>',
  'weather-cloudy': '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 19a4 4 0 1 1 .4-8 5.5 5.5 0 0 1 10.4 2A3.5 3.5 0 0 1 16.5 19Z"/></svg>',
  'weather-fog': '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 9h11M4 13h16M4 17h13"/></svg>',
  'weather-rain': '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 14.5a4 4 0 1 1 .4-8 5.5 5.5 0 0 1 10.4 2 3.5 3.5 0 0 1-.8 6.9"/><path d="M8 17.5 7 20M12 17.5l-1 2.5M16 17.5l-1 2.5"/></svg>',
  'weather-snow': '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 14.5a4 4 0 1 1 .4-8 5.5 5.5 0 0 1 10.4 2 3.5 3.5 0 0 1-.8 6.9"/><path d="M8 18v.01M12 18v.01M16 18v.01M8 21v.01M12 21v.01M16 21v.01"/></svg>',
  'weather-thunderstorm': '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 13.5a4 4 0 1 1 .4-8 5.5 5.5 0 0 1 10.4 2 3.5 3.5 0 0 1-.8 6.9"/><path d="M13 14l-3 5h3l-2 4"/></svg>',
  'weather-unknown': '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14.8V5a2 2 0 1 1 4 0v9.8a3.5 3.5 0 1 1-4 0Z"/></svg>',
};

// Moon-phase icon: rather than 8 separate hand-drawn glyphs, this draws the
// correct crescent/gibbous shape for any illumination fraction directly -
// a fixed edge arc (which side is lit depends on waxing vs waning) plus a
// "terminator" arc whose horizontal radius is R*cos(phase angle), the
// standard construction for this shape (0 -> new moon, 0.25 -> quarter,
// 0.5 -> full).
function moonPhaseIcon(fraction) {
  var R = 9, cx = 12, cy = 12;
  var angle = fraction * 2 * Math.PI;
  var rx = Math.abs(R * Math.cos(angle));
  var waxing = fraction < 0.5;
  var gibbous = fraction > 0.25 && fraction < 0.75;
  var edgeSweep = waxing ? 1 : 0;
  var termSweep = gibbous ? (waxing ? 0 : 1) : (waxing ? 1 : 0);
  var d = 'M ' + cx + ' ' + (cy - R) +
    ' A ' + R + ' ' + R + ' 0 0 ' + edgeSweep + ' ' + cx + ' ' + (cy + R) +
    ' A ' + rx + ' ' + R + ' 0 0 ' + termSweep + ' ' + cx + ' ' + (cy - R) + ' Z';
  return (
    '<svg class="icon" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      '<path d="' + d + '" fill="currentColor"/>' +
    '</svg>'
  );
}

// ---- custom themes management modal ----
var customThemesOverlay = document.getElementById('custom-themes-modal-overlay');
var customThemeForm = document.getElementById('custom-theme-form');
var customThemeStatus = document.getElementById('custom-theme-status');
var editingThemeId = null; // null while creating a new theme, an id while editing one

function renderCustomThemesList() {
  var listEl = document.getElementById('custom-themes-list');
  var addBtn = document.getElementById('add-custom-theme-btn');
  if (!customThemes.length) {
    listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No custom themes yet.</p>';
  } else {
    listEl.innerHTML = customThemes.map(function (t) {
      return (
        '<div class="custom-theme-row" data-id="' + t.id + '">' +
          '<span>' +
            '<span class="custom-theme-swatches">' +
              '<span class="custom-theme-swatch" style="background:' + t.main + ';"></span>' +
              '<span class="custom-theme-swatch" style="background:' + t.secondary1 + ';"></span>' +
              '<span class="custom-theme-swatch" style="background:' + t.secondary2 + ';"></span>' +
              '<span class="custom-theme-swatch" style="background:' + (t.widgetBg || t.secondary2) + ';"></span>' +
            '</span>' +
            t.name +
          '</span>' +
          '<span class="custom-theme-actions">' +
            '<button type="button" class="btn btn-outline-only edit-custom-theme-btn" data-id="' + t.id + '">Edit</button>' +
            '<button type="button" class="btn btn-outline-only delete-custom-theme-btn" data-id="' + t.id + '">Delete</button>' +
          '</span>' +
        '</div>'
      );
    }).join('');
  }
  addBtn.style.display = customThemes.length >= 3 ? 'none' : '';

  listEl.querySelectorAll('.edit-custom-theme-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { openCustomThemeForm(btn.dataset.id); });
  });
  listEl.querySelectorAll('.delete-custom-theme-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { deleteCustomTheme(btn.dataset.id); });
  });
}

document.getElementById('custom-theme-pattern-input').addEventListener('change', function () {
  document.getElementById('custom-theme-image-field').style.display = this.value === 'image' ? 'block' : 'none';
});

function openCustomThemeForm(id) {
  editingThemeId = id || null;
  var theme = id ? findCustomTheme(id) : null;
  document.getElementById('custom-theme-name-input').value = theme ? theme.name : '';
  document.getElementById('custom-theme-main-input').value = theme ? theme.main : '#E8672E';
  document.getElementById('custom-theme-secondary1-input').value = theme ? theme.secondary1 : '#4A2E3D';
  document.getElementById('custom-theme-secondary2-input').value = theme ? theme.secondary2 : '#FFFBF3';
  document.getElementById('custom-theme-widget-bg-input').value = theme ? (theme.widgetBg || theme.secondary2) : '#FFFFFF';
  var pattern = theme ? (theme.pattern || 'none') : 'none';
  document.getElementById('custom-theme-pattern-input').value = pattern;
  document.getElementById('custom-theme-image-input').value = ''; // a file input can't be prefilled
  document.getElementById('custom-theme-image-field').style.display = pattern === 'image' ? 'block' : 'none';
  document.getElementById('custom-theme-image-current').textContent =
    theme && theme.image ? 'An image is already saved - choose a new file to replace it.' : '';
  customThemeStatus.textContent = '';
  customThemeForm.style.display = 'block';
}

function closeCustomThemeForm() {
  customThemeForm.style.display = 'none';
  editingThemeId = null;
}

async function persistCustomThemes() {
  var res = await fetch('/api/me/custom-themes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_themes: customThemes }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Could not save theme');
}

var BUILTIN_THEME_VALUES = ['default', 'tropical', 'christmas', 'summer', 'winter', 'spring', 'autumn'];

function populateThemeSelectOptions() {
  Array.from(retroSelect.querySelectorAll('option[data-custom]')).forEach(function (o) { o.remove(); });
  customThemes.forEach(function (t) {
    var opt = document.createElement('option');
    opt.value = 'custom:' + t.id;
    // A native <select><option> can't render real icons, only text - so
    // custom theme names show plain, unlike everywhere else in the UI.
    opt.textContent = t.name;
    opt.setAttribute('data-custom', 'true');
    retroSelect.appendChild(opt);
  });
  // Re-sync the visible selection now that custom options actually exist -
  // at boot, activeThemeValue may have been a custom:<id> the <select>
  // didn't have an <option> for yet.
  if (BUILTIN_THEME_VALUES.indexOf(activeThemeValue) !== -1 || customThemes.some(function (t) { return 'custom:' + t.id === activeThemeValue; })) {
    retroSelect.value = activeThemeValue;
  }
}

document.getElementById('open-custom-themes').addEventListener('click', function () {
  closeCustomThemeForm();
  renderCustomThemesList();
  customThemesOverlay.classList.add('open');
});
document.getElementById('cancel-custom-themes').addEventListener('click', function () {
  customThemesOverlay.classList.remove('open');
});
customThemesOverlay.addEventListener('click', function (e) {
  if (e.target === customThemesOverlay) customThemesOverlay.classList.remove('open');
});
document.getElementById('add-custom-theme-btn').addEventListener('click', function () {
  openCustomThemeForm(null);
});
document.getElementById('cancel-custom-theme-form').addEventListener('click', function () {
  closeCustomThemeForm();
});

customThemeForm.addEventListener('submit', async function (e) {
  e.preventDefault();
  var name = document.getElementById('custom-theme-name-input').value.trim();
  if (!name) return;
  var pattern = document.getElementById('custom-theme-pattern-input').value;

  // Background image: reuse whatever was already saved unless a new file was
  // picked (a file input can't be prefilled, so "leave it alone" is the
  // default when editing rather than "clear it").
  var existingTheme = editingThemeId ? findCustomTheme(editingThemeId) : null;
  var image = existingTheme ? existingTheme.image : null;
  if (pattern === 'image') {
    var fileInput = document.getElementById('custom-theme-image-input');
    if (fileInput.files && fileInput.files[0]) {
      var file = fileInput.files[0];
      if (file.size > 1 * 1024 * 1024) {
        customThemeStatus.textContent = 'Image is too large (max 1MB).';
        customThemeStatus.className = 'form-status error';
        return;
      }
      try {
        image = await readFileAsDataURL(file);
      } catch (err) {
        customThemeStatus.textContent = 'Failed to read image file.';
        customThemeStatus.className = 'form-status error';
        return;
      }
    }
    if (!image) {
      customThemeStatus.textContent = 'Choose an image to use as the background pattern.';
      customThemeStatus.className = 'form-status error';
      return;
    }
  } else {
    image = null;
  }

  var themeData = {
    id: editingThemeId || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name: name,
    main: document.getElementById('custom-theme-main-input').value,
    secondary1: document.getElementById('custom-theme-secondary1-input').value,
    secondary2: document.getElementById('custom-theme-secondary2-input').value,
    widgetBg: document.getElementById('custom-theme-widget-bg-input').value,
    pattern: pattern,
    image: image,
  };
  if (editingThemeId) {
    customThemes = customThemes.map(function (t) { return t.id === editingThemeId ? themeData : t; });
  } else {
    if (customThemes.length >= 3) return;
    customThemes.push(themeData);
  }
  try {
    await persistCustomThemes();
    populateThemeSelectOptions();
    if (activeThemeValue === 'custom:' + themeData.id) applyTheme(activeThemeValue);
    closeCustomThemeForm();
    renderCustomThemesList();
  } catch (err) {
    customThemeStatus.textContent = err.message;
    customThemeStatus.className = 'form-status error';
  }
});

async function deleteCustomTheme(id) {
  var wasActive = activeThemeValue === 'custom:' + id;
  var previous = customThemes;
  customThemes = customThemes.filter(function (t) { return t.id !== id; });
  try {
    await persistCustomThemes();
  } catch (err) {
    customThemes = previous; // best-effort rollback if the request failed
    customThemeStatus.textContent = err.message;
    customThemeStatus.className = 'form-status error';
    return;
  }
  populateThemeSelectOptions();
  if (wasActive) {
    activeThemeValue = 'default';
    retroSelect.value = 'default';
    localStorage.setItem(RETRO_THEME_KEY, 'default');
    applyTheme('default');
  }
  renderCustomThemesList();
}

// A CSS background-image can't do this: it either stretches to fill the
// card (bulb spacing scales with card width - not "consistent") or tiles at
// a fixed size (consistent spacing, but a bulb almost never lands exactly
// on the far edge for an arbitrary card width). Measuring each card's real
// width and computing bulb count/spacing in JS is the only way to get both
// - a bulb at both corners, spaced close to a fixed target rather than
// stretched or squeezed to fit.
var LIGHTS_TARGET_SPACING = 65;
var lightsGradientCounter = 0;

function buildLightsSvg(width, colors) {
  var n = Math.max(2, Math.round(width / LIGHTS_TARGET_SPACING) + 1);
  var spacing = width / (n - 1);
  var xs = [];
  for (var i = 0; i < n; i++) xs.push(i * spacing);

  // The wire is attached (high, y=8) exactly at each bulb's x-position, and
  // sags DOWN (y=16) at the midpoints between them - a real hung cable, not
  // an upward arc. Each bulb then drops from that attachment point via a
  // short visible stem, so it clearly hangs below the wire rather than
  // sitting on it.
  var path = 'M' + xs[0].toFixed(1) + ',8';
  for (i = 0; i < n - 1; i++) {
    var mid = (xs[i] + xs[i + 1]) / 2;
    path += ' Q' + mid.toFixed(1) + ',16 ' + xs[i + 1].toFixed(1) + ',8';
  }

  var gradId = 'lights-glow-' + (lightsGradientCounter++);
  var stops = colors.glowStops.map(function (s) {
    return '<stop offset="' + s[0] + '%" stop-color="' + colors.glow + '" stop-opacity="' + s[1] + '"/>';
  }).join('');
  var bulbs = xs.map(function (x) {
    return '<g transform="translate(' + x.toFixed(1) + ',0)">' +
      '<line x1="0" y1="8" x2="0" y2="14" stroke="' + colors.wire + '" stroke-width="1.2"/>' +
      '<circle cy="21" r="' + colors.glowRadius + '" fill="url(#' + gradId + ')"/>' +
      '<rect x="-1.5" y="14" width="3" height="3" fill="' + colors.cap + '"/>' +
      '<ellipse cy="20" rx="3.6" ry="4.4" fill="' + colors.bulb + '"/>' +
    '</g>';
  }).join('');

  // overflow:visible - an SVG clips anything outside its own width/height by
  // default, and the glow (radius up to 14) extends well past the viewBox on
  // every side: past the top/bottom since it's centered close to the edges
  // of a 26px-tall box, and past the left/right at the very first and last
  // bulb specifically, since those sit exactly at x=0 and x=width.
  return '<svg class="christmas-lights" xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="26" ' +
    'viewBox="0 0 ' + width.toFixed(1) + ' 26" style="position:absolute;top:-10px;left:0;overflow:visible;pointer-events:none;">' +
    '<defs><radialGradient id="' + gradId + '" cx="50%" cy="50%" r="50%">' + stops + '</radialGradient></defs>' +
    '<path d="' + path + '" stroke="' + colors.wire + '" stroke-width="1.6" fill="none"/>' +
    bulbs +
  '</svg>';
}

var LIGHTS_COLORS_DAY = {
  wire: '#3D2818', glow: '#FFF3D6', glowStops: [[0, 0.85], [45, 0.3], [100, 0]],
  glowRadius: 11, bulb: '#FFF3D6', cap: '#6B5D4F',
};
var LIGHTS_COLORS_NIGHT = {
  wire: '#8A7A5A', glow: '#FFF8E8', glowStops: [[0, 1.0], [50, 0.5], [100, 0]],
  glowRadius: 14, bulb: '#FFFAE8', cap: '#C9B896',
};

function renderChristmasLights() {
  document.querySelectorAll('.christmas-lights').forEach(function (el) { el.remove(); });
  var active = document.documentElement.hasAttribute('data-retro') &&
    document.documentElement.getAttribute('data-season') === 'christmas';
  if (!active) return;

  var colors = document.documentElement.getAttribute('data-theme') === 'dark' ? LIGHTS_COLORS_NIGHT : LIGHTS_COLORS_DAY;
  document.querySelectorAll('.module').forEach(function (module) {
    var width = module.getBoundingClientRect().width;
    if (!width) return;
    module.style.position = 'relative';
    module.style.overflow = 'visible';
    module.insertAdjacentHTML('afterbegin', buildLightsSvg(width, colors));
  });
}

var lightsResizeTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(lightsResizeTimer);
  lightsResizeTimer = setTimeout(renderChristmasLights, 200);
});

// ---- clock ----
function renderClock() {
  var el = document.getElementById('clock');
  var opts = { weekday: 'long', month: 'long', day: 'numeric' };
  el.textContent = new Date().toLocaleDateString(undefined, opts);
}
renderClock();
setInterval(renderClock, 60000);

// ---- theme: dark after sunset, light after sunrise, based on real location -
// unless overridden to always Day or always Night from Sign-in settings. ----
var THEME_MODE_KEY = 'lifeDashboardThemeMode';
var themeMode = localStorage.getItem(THEME_MODE_KEY) || 'auto';
var sunTimesCache = null; // {date: 'YYYY-MM-DD', sunrise: Date, sunset: Date}

// Applies a Day/Night mode choice immediately and persists it. 'auto' resumes
// real sunrise/sunset tracking - either from an already-fetched cache, or by
// (re)starting geolocation-based tracking if this is the first time auto has
// run this session (e.g. switching back to Auto after a stretch on Day/Night).
function applyThemeMode(mode) {
  themeMode = mode;
  localStorage.setItem(THEME_MODE_KEY, mode);
  if (mode === 'day') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (mode === 'night') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (sunTimesCache) {
    applyThemeFromSunTimes();
  } else {
    document.documentElement.removeAttribute('data-theme'); // OS preference until geolocation resolves
    initSunTheme();
  }
  renderChristmasLights(); // bulb color palette depends on data-theme
}

function applyThemeFromSunTimes() {
  // The sun-times watcher's setInterval keeps running in the background
  // regardless of mode (there's no clean way to pause it once armed) - this
  // guard is what actually stops it from fighting a forced Day/Night choice.
  if (themeMode !== 'auto') return;
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
if (themeMode === 'day') {
  document.documentElement.setAttribute('data-theme', 'light');
} else if (themeMode === 'night') {
  document.documentElement.setAttribute('data-theme', 'dark');
} else {
  initSunTheme();
}

var themeModeSelect = document.getElementById('theme-mode-select');
themeModeSelect.value = themeMode;
themeModeSelect.addEventListener('change', function () {
  applyThemeMode(themeModeSelect.value);
});

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

// Populated by loadCalendar() below - kept around so the "Calendars" manage
// modal doesn't need its own separate fetch just to list what's connected.
var currentCalendarSources = [];

async function loadCalendar() {
  try {
    var data = await getJSON('/api/calendar');
    currentCalendarSources = data.sources || [];
    var stamp = document.getElementById('calendar-sync-stamp');
    stamp.textContent = 'Synced ' + new Date(data.fetched_at).toLocaleString();

    var windowEnd = Date.now() + 10 * 24 * 60 * 60 * 1000; // next 10 days
    var all = currentCalendarSources
      .flatMap(function (s) { return (s.events || []).map(function (e) { return Object.assign({}, e, { source: s.label }); }); })
      .filter(function (e) { return new Date(e.start).getTime() <= windowEnd; })
      .sort(function (a, b) { return new Date(a.start) - new Date(b.start); })
      .slice(0, 15); // whichever limit (10 days or 15 items) hits first

    var list = document.getElementById('calendar-events');
    var emptyWrap = document.getElementById('calendar-empty-states');
    emptyWrap.innerHTML = '';

    if (!currentCalendarSources.length) {
      list.innerHTML = '';
      emptyWrap.innerHTML = '<div class="empty-state">No calendars connected yet - tap + to add one</div>';
    } else if (all.length === 0) {
      list.innerHTML = '';
      emptyWrap.innerHTML = '<div class="empty-state">Nothing scheduled on any calendar</div>';
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

    currentCalendarSources.forEach(function (s) {
      if (s.error) emptyWrap.innerHTML += '<div class="empty-state">' + s.label + ': ' + s.error + '</div>';
    });

    renderCalendarQuickLinks();
  } catch (err) {
    document.getElementById('calendar-sync-stamp').textContent = 'Sync failed: ' + err.message;
  }
}

// One button per connected calendar, named after it, instead of one static
// generic "Open Google Calendar" link - webcal: (not http/https) so tapping
// hands off to the OS/browser's own calendar app to actually subscribe,
// rather than downloading the raw .ics file.
function renderCalendarQuickLinks() {
  var wrap = document.getElementById('calendar-quick-links');
  wrap.innerHTML = currentCalendarSources.map(function (s, i) {
    var webcalUrl = s.ics_url.replace(/^https?:\/\//, 'webcal://');
    var cls = i === 0 ? 'btn btn-primary' : 'btn btn-ghost';
    return '<a class="' + cls + '" href="' + webcalUrl + '" target="_blank" rel="noopener">' + s.label + ' &nbsp;&rarr;</a>';
  }).join('');
}

function renderCalendarManageList() {
  var el = document.getElementById('calendar-manage-list');
  if (!currentCalendarSources.length) {
    el.innerHTML = '<p style="font-size:0.85rem;color:var(--muted);">No calendars connected yet.</p>';
    return;
  }
  el.innerHTML = currentCalendarSources.map(function (s) {
    return (
      '<div class="sub-row" data-id="' + s.id + '">' +
        '<span class="sub-name">' + s.label + (s.error ? ' &mdash; failing' : '') + '</span>' +
        '<button type="button" class="sub-remove" data-id="' + s.id + '" aria-label="Delete">&times;</button>' +
      '</div>'
    );
  }).join('');
  el.querySelectorAll('.sub-remove').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      await fetch('/api/calendar/sources/' + btn.dataset.id, { method: 'DELETE' });
      await loadCalendar();
      renderCalendarManageList();
    });
  });
}

var calendarOverlay = document.getElementById('calendar-modal-overlay');
document.getElementById('open-calendar-form').addEventListener('click', function () {
  document.getElementById('calendar-form-status').textContent = '';
  renderCalendarManageList();
  calendarOverlay.classList.add('open');
});
document.getElementById('cancel-calendar-form').addEventListener('click', function () {
  calendarOverlay.classList.remove('open');
});
calendarOverlay.addEventListener('click', function (e) { if (e.target === calendarOverlay) calendarOverlay.classList.remove('open'); });

document.getElementById('calendar-add-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('calendar-form-status');
  var label = document.getElementById('calendar-label-input').value.trim();
  var icsUrl = document.getElementById('calendar-url-input').value.trim();
  statusEl.textContent = 'Connecting&hellip;';
  statusEl.className = 'form-status';
  try {
    var res = await fetch('/api/calendar/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label, ics_url: icsUrl }),
    });
    var body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Server returned ' + res.status);
    statusEl.textContent = 'Connected.';
    statusEl.className = 'form-status ok';
    document.getElementById('calendar-add-form').reset();
    await loadCalendar();
    renderCalendarManageList();
  } catch (err) {
    statusEl.textContent = 'Failed to connect: ' + err.message;
    statusEl.className = 'form-status error';
  }
});

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
// An agent whose status_summary is still "OK" from the last time it ran
// looks fine at a glance even if it silently stopped running days ago -
// status_summary alone can't tell you that. Uses each agent's own
// expected_interval_hours if it's set (e.g. 720 for a monthly agent) so a
// slow-cadence agent doesn't get flagged for simply not having run today;
// falls back to this default for agents with nothing on file. 50% grace on
// top of the interval before actually flagging - "hasn't run in a while" is
// normal, "hasn't run in 1.5x its own cadence" is the "probably dead" signal.
var AGENT_STALE_HOURS_DEFAULT = 24;
var AGENT_STALE_GRACE = 1.5;

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
      var lastRunDate = new Date(a.last_run_at);
      var hoursSince = (Date.now() - lastRunDate.getTime()) / 3600000;
      var expectedHours = Number(a.expected_interval_hours) || AGENT_STALE_HOURS_DEFAULT;
      var stale = hoursSince > expectedHours * AGENT_STALE_GRACE;
      var pillColor = stale || statusLower.indexOf('error') !== -1 ? 'var(--critical)'
        : statusLower.indexOf('paused') !== -1 ? 'var(--muted)'
        : 'var(--good)';
      var pillText = (stale ? ICONS.warning : '') + a.status_summary;
      var lastRun = lastRunDate.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      return (
        '<li style="display:block;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span style="font-weight:600;">' + a.agent_name + '</span>' +
            '<span class="pill" style="background:' + pillColor + ';">' + pillText + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--muted);margin-top:0.2rem;">' +
            '<span>' + (a.action_taken || '&mdash;') + '</span>' +
            '<span' + (stale ? ' style="color:var(--critical);font-weight:700;"' : '') + '>' + lastRun + '</span>' +
          '</div>' +
        '</li>'
      );
    }).join('');
  } catch (err) {
    list.innerHTML = '<li>Failed to load</li>';
  }
}

// ---- Railway services status + usage ----
async function loadRailwayStatus() {
  var list = document.getElementById('railway-status-list');
  var usageLine = document.getElementById('railway-usage-line');
  try {
    var data = await getJSON('/api/railway/status');

    list.innerHTML = data.services.map(function (s) {
      var healthy = s.status === 'SUCCESS';
      var pillColor = healthy ? 'var(--good)' : 'var(--critical)';
      var deployed = s.deployedAt
        ? new Date(s.deployedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : 'never deployed';
      return (
        '<li>' +
          '<span>' + s.name + '</span>' +
          '<span class="amt"><span class="pill" style="background:' + pillColor + ';margin-right:0.4rem;">' + s.status + '</span>' + deployed + '</span>' +
        '</li>'
      );
    }).join('');

    // Real dollar billing isn't reachable via API token (Railway restricts
    // that to real user logins) - estimatedDollars is computed server-side
    // from Railway's published per-second rates, not an authoritative bill.
    // See routes/railway.js for how that math works and its caveats.
    if (data.usage) {
      var u = data.usage;
      usageLine.textContent = '~' + fmtDollar(u.estimatedDollars || 0, { cents: true }) + ' est. this period · ' +
        Math.round(u.MEMORY_USAGE_GB || 0).toLocaleString() + ' GB-min memory · ' +
        (u.CPU_USAGE || 0).toFixed(1) + ' vCPU-min · ' +
        (u.NETWORK_TX_GB || 0).toFixed(2) + ' GB egress';
    } else {
      usageLine.textContent = 'Usage unavailable';
    }
  } catch (err) {
    list.innerHTML = '<li>Failed to load</li>';
    usageLine.textContent = '';
  }
}

// ---- shared drag-to-reorder for .todo-row lists (To-Do, Customize dashboard) ----
// Built on Pointer Events, not native HTML5 drag-and-drop (`draggable` +
// dragstart/dragover/drop) - the native API only ever fires for a mouse, not
// a finger, so it silently doesn't work at all on iPad/touch. Pointer Events
// fire the same way for mouse, touch, and pen, so this is one implementation
// that actually works on both instead of a desktop-only one.
function makeReorderable(listEl, onReordered) {
  var draggingRow = null;

  function rowUnderPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    return el ? el.closest('.todo-row') : null;
  }

  function endDrag() {
    if (!draggingRow) return;
    draggingRow.classList.remove('dragging');
    draggingRow = null;
    onReordered();
  }

  listEl.addEventListener('pointermove', function (e) {
    if (!draggingRow) return;
    e.preventDefault();
    var target = rowUnderPoint(e.clientX, e.clientY);
    if (!target || target === draggingRow || !listEl.contains(target)) return;
    var rect = target.getBoundingClientRect();
    var before = (e.clientY - rect.top) < rect.height / 2;
    listEl.insertBefore(draggingRow, before ? target : target.nextSibling);
  });
  listEl.addEventListener('pointerup', endDrag);
  listEl.addEventListener('pointercancel', endDrag);

  listEl.querySelectorAll('.todo-row').forEach(function (row) {
    var handle = row.querySelector('.todo-drag-handle');
    if (!handle) return;
    handle.addEventListener('pointerdown', function (e) {
      draggingRow = row;
      row.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* not supported - drag still works via elementFromPoint */ }
      e.preventDefault();
    });
  });
}

// ---- To-Do list (drag to reorder, check off, disappears an hour after checking) ----
var currentTodos = [];

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
      '<li class="todo-row' + (checked ? ' checked' : '') + '" data-id="' + t.id + '">' +
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

  makeReorderable(list, async function () {
    var order = Array.from(list.querySelectorAll('.todo-row')).map(function (r) { return Number(r.dataset.id); });
    await fetch('/api/todos/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: order }),
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
    // no-store - unlike other API calls in this file, this one skipped the
    // getJSON() helper (which always sets this), so the browser was free to
    // serve a cached response from before you'd signed in, or from a
    // different tenant's session, regardless of what's actually true now.
    var res = await fetch('/api/auth/webauthn/credentials', { cache: 'no-store' });
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

function renderEmailVerifiedBadge(me) {
  var badge = document.getElementById('email-verified-badge');
  var resendBtn = document.getElementById('resend-verification-btn');
  if (!me.email) {
    badge.textContent = '';
    resendBtn.style.display = 'none';
  } else if (me.email_verified) {
    badge.textContent = 'Confirmed';
    badge.style.color = '#1a8a4a';
    resendBtn.style.display = 'none';
  } else {
    badge.textContent = 'Not confirmed yet - check your inbox, or resend below.';
    badge.style.color = 'var(--muted)';
    resendBtn.style.display = 'inline-flex';
  }
}

document.getElementById('open-signin-settings').addEventListener('click', async function () {
  webauthnStatusEl.textContent = '';
  document.getElementById('change-password-form').reset();
  document.getElementById('change-password-status').textContent = '';
  document.getElementById('email-status').textContent = '';
  document.getElementById('delete-account-status').textContent = '';
  document.getElementById('delete-account-confirm').style.display = 'none';
  document.getElementById('delete-account-confirm-input').value = '';
  renderWebauthnCredentialsList();
  try {
    var me = await getJSON('/api/me');
    document.getElementById('email-input').value = me.email || '';
    renderEmailVerifiedBadge(me);
  } catch (err) {
    // leave the field empty - not worth blocking the modal over
  }
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

document.getElementById('change-password-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('change-password-status');
  var currentPassword = document.getElementById('current-password-input').value;
  var newPassword = document.getElementById('new-password-input').value;
  var confirmPassword = document.getElementById('confirm-password-input').value;

  if (newPassword !== confirmPassword) {
    statusEl.textContent = 'New passwords do not match.';
    statusEl.className = 'form-status error';
    return;
  }

  try {
    var res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not update password');
    statusEl.textContent = 'Password updated.';
    statusEl.className = 'form-status ok';
    this.reset();
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'form-status error';
  }
});

document.getElementById('email-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('email-status');
  try {
    var res = await fetch('/api/me/email', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email-input').value }),
    });
    var body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not save email');
    if (body.email_send_failed) {
      statusEl.textContent = 'Email saved, but the confirmation link could not be sent right now - contact the admin.';
      statusEl.className = 'form-status error';
    } else {
      statusEl.textContent = 'Email saved - check your inbox for a confirmation link.';
      statusEl.className = 'form-status ok';
    }
    renderEmailVerifiedBadge(body);
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'form-status error';
  }
});

document.getElementById('resend-verification-btn').addEventListener('click', async function () {
  var statusEl = document.getElementById('email-status');
  try {
    var res = await fetch('/api/auth/resend-verification', { method: 'POST' });
    var body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not resend confirmation email');
    if (body.email_send_failed) {
      statusEl.textContent = 'Could not send the confirmation email right now - contact the admin.';
      statusEl.className = 'form-status error';
    } else {
      statusEl.textContent = 'Confirmation email sent.';
      statusEl.className = 'form-status ok';
    }
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'form-status error';
  }
});

document.getElementById('open-delete-account-btn').addEventListener('click', function () {
  document.getElementById('delete-account-confirm').style.display = 'block';
});

document.getElementById('confirm-delete-account-btn').addEventListener('click', async function () {
  var statusEl = document.getElementById('delete-account-status');
  var confirmInput = document.getElementById('delete-account-confirm-input');
  if (confirmInput.value.trim().toLowerCase() !== 'delete') {
    statusEl.textContent = 'Type "delete" to confirm.';
    statusEl.className = 'form-status error';
    return;
  }
  try {
    var res = await fetch('/api/me', { method: 'DELETE' });
    if (!res.ok) throw new Error('Could not delete account');
    window.location.href = '/login';
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'form-status error';
  }
});

// ---- shared idle tracking (used by auto-reload below and auto-scroll further down) ----
var ACTIVITY_IDLE_MS = 60 * 1000;
// A reload triggered by the idle auto-reload below (not a manual/initial
// load) means idle auto-scroll was already active going into it - resume
// immediately instead of sitting still for another ACTIVITY_IDLE_MS, by
// starting lastActivityTs already "stale" rather than at Date.now().
var RESUMING_AFTER_IDLE_RELOAD_KEY = 'lifeDashboardResumingAfterIdleReload';
var lastActivityTs = sessionStorage.getItem(RESUMING_AFTER_IDLE_RELOAD_KEY) ? 0 : Date.now();
sessionStorage.removeItem(RESUMING_AFTER_IDLE_RELOAD_KEY);
['mousemove', 'mousedown', 'wheel', 'touchstart', 'keydown'].forEach(function (evt) {
  window.addEventListener(evt, function () { lastActivityTs = Date.now(); }, { passive: true });
});

// ---- soft data refresh for an always-on desk display ----
// Re-calls each widget's own load function so fresh data replaces old data
// in place - none of these functions clear a section back to its loading
// skeleton first (that skeleton only ever exists in the page's initial
// static HTML), so this never produces the every-widget-flashes-to-loading
// flicker a full page reload does. Notes is deliberately excluded - it's a
// plain <textarea>, and overwriting its value out from under someone even
// mid-idle-window feels wrong for something that's meant to persist exactly
// what was typed. Skipped while someone's actually using the page, same as
// the hard reload below.
function refreshAllWidgets() {
  loadTicker();
  loadCalendar();
  loadSubscriptions();
  loadExams();
  loadCountdowns();
  loadTodos();
  loadFinanceAndRobinhood();
  loadAgentTracker();
  loadRailwayStatus();
  loadSlideshow();
  loadWeather();
  renderMoonPhase();
  if (isAdminUser) loadErrors();
}
setInterval(function () {
  if (Date.now() - lastActivityTs < ACTIVITY_IDLE_MS) return;
  refreshAllWidgets();
}, 2 * 60 * 1000);

// ---- auto-reload for an always-on desk display ----
// A full page reload - unlike the soft refresh above, this actually picks up
// a new deploy's JS/CSS, which a re-fetch can't do. Deliberately much less
// frequent than the soft refresh now that the soft refresh handles routine
// data freshness - this is here for eventual code freshness and as a
// belt-and-suspenders full reset, not the main mechanism, so the
// every-widget-shows-loading flash it causes is rare instead of every few
// minutes. Skipped while someone's actually using it, so an in-progress
// tap/scroll doesn't get yanked out from under them.
setInterval(function () {
  if (Date.now() - lastActivityTs < ACTIVITY_IDLE_MS) return;
  sessionStorage.setItem(RESUMING_AFTER_IDLE_RELOAD_KEY, '1');
  location.reload();
}, 45 * 60 * 1000);

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

renderChristmasLights();

// ---- self-service widget layout: freeform grid, drag to reposition, drag a
// corner to resize, edit mode toggled from the header button (iPhone-
// homescreen style, not the earlier list-based reorder modal) ----
// Canonical list of every data-widget-id in index.html, plus a short
// example/fake-data preview shown in the edit-mode "add widget" gallery for
// anything not currently on the dashboard, so picking a widget isn't a
// guess at what it looks like. adminOnly widgets only apply to the tslep
// account (Robinhood/agent/infra data is tied specifically to that account
// server-side - see routes/robinhood.js) - other accounts never see them in
// the gallery, and can't add them.
// Each preview is a small HTML mockup built from the .wp-* building blocks
// in styles.css, styled to resemble the widget's real markup/typography
// (not just a text blurb) so picking something from the gallery isn't a
// guessing game about what it'll actually look like on the dashboard.
function leaguePreviewHTML(away, home, scoreOrTime) {
  return (
    '<div class="wp-label">Upcoming</div>' +
    '<div class="wp-row"><span style="display:flex;align-items:center;gap:0.3rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
      '<span class="wp-dot"></span>' + away + ' @ <span class="wp-dot"></span>' + home +
    '</span><span class="wp-muted">' + scoreOrTime + '</span></div>' +
    '<div class="wp-label">Recent</div>' +
    '<div class="wp-row"><span style="display:flex;align-items:center;gap:0.3rem;">' +
      '<span class="wp-dot"></span>' + home + '</span><span class="wp-muted">24-17 W</span></div>'
  );
}

var WIDGET_REGISTRY = [
  { id: 'calendar', name: 'Calendar', preview:
    '<div class="wp-row"><span>Team meeting</span><span class="wp-muted">2:00 PM</span></div>' +
    '<div class="wp-row"><span>Dentist</span><span class="wp-muted">Tomorrow</span></div>'
  },
  { id: 'subscriptions', name: 'Subscriptions', preview:
    '<div class="wp-row"><span>Netflix</span><span class="wp-muted">$15.49/mo</span></div>' +
    '<div class="wp-row"><span>Spotify</span><span class="wp-muted">$11.99/mo</span></div>'
  },
  { id: 'exams', name: 'Exams / Big Projects', preview:
    '<div class="wp-row"><span>Final exam</span><span class="wp-muted">in 12 days</span></div>' +
    '<div class="wp-row"><span>Term paper</span><span class="wp-muted">in 25 days</span></div>'
  },
  { id: 'countdowns', name: 'Countdowns', preview:
    '<div class="wp-row"><span>Vacation</span><span class="wp-muted">34 days left</span></div>' +
    '<div class="wp-row"><span>Wedding</span><span class="wp-muted">61 days left</span></div>'
  },
  { id: 'agent-tracker', name: 'AI Agent Tracker', adminOnly: true, preview:
    '<div class="wp-row"><span>daily-sync</span><span class="wp-pill wp-pill-ok">Active</span></div>' +
    '<div class="wp-row"><span>backup-job</span><span class="wp-pill">Idle</span></div>'
  },
  { id: 'railway', name: 'Railway', adminOnly: true, preview:
    '<div class="wp-row"><span>Life-dashboard</span><span class="wp-pill wp-pill-ok">Running</span></div>'
  },
  { id: 'errors', name: 'Errors', adminOnly: true, preview:
    '<div class="wp-row"><span class="wp-muted">No errors logged</span></div>'
  },
  { id: 'todo', name: 'To-Do', preview:
    '<div class="wp-row"><span>&#9744; Buy groceries</span></div>' +
    '<div class="wp-row"><span>&#9745; Finish report</span></div>'
  },
  { id: 'slideshow', name: 'Photos', preview: '<div class="wp-photo-box"></div>' },
  { id: 'weather', name: 'Weather', preview:
    '<div class="wp-row"><span class="wp-title" style="font-size:1.1rem;">72&deg;F</span><span class="wp-muted">Partly cloudy</span></div>'
  },
  { id: 'sports', name: 'Favorite Teams', preview:
    '<div class="wp-row"><span style="display:flex;align-items:center;gap:0.3rem;"><span class="wp-dot"></span>Cowboys</span></div>' +
    '<div class="wp-row"><span class="wp-muted">@ Eagles</span><span class="wp-muted">Sun 1:00 PM</span></div>'
  },
  { id: 'league-nfl', name: 'NFL', preview: leaguePreviewHTML('Cowboys', 'Eagles', 'Sun 1:00 PM') },
  { id: 'league-mlb', name: 'MLB', preview: leaguePreviewHTML('Yankees', 'Red Sox', '7:05 PM') },
  { id: 'league-nhl', name: 'NHL', preview: leaguePreviewHTML('Rangers', 'Bruins', '7:00 PM') },
  { id: 'league-nba', name: 'NBA', preview: leaguePreviewHTML('Lakers', 'Celtics', '7:30 PM') },
  { id: 'league-ncaaf', name: 'NCAA Football', preview: leaguePreviewHTML('Ohio St', 'Michigan', 'Sat noon') },
  { id: 'league-ncaambb', name: "NCAA Men's Basketball", preview: leaguePreviewHTML('Duke', 'UNC', '7:00 PM') },
  { id: 'league-ncaawbb', name: "NCAA Women's Basketball", preview: leaguePreviewHTML('UConn', 'Iowa', '7:00 PM') },
  { id: 'moon-phase', name: 'Moon phase', preview:
    '<div class="wp-row" style="align-items:center;"><span style="font-size:1.3rem;">' + moonPhaseIcon(0.78) + '</span>' +
    '<span style="text-align:right;"><div>Waxing gibbous</div><div class="wp-muted">78% illuminated</div></span></div>'
  },
  { id: 'notes', name: 'Notes', preview: '<div class="wp-notes-box">Grocery list, gift ideas&hellip;</div>' },
  { id: 'week-nav', name: 'Week navigator', preview:
    '<div class="wp-row" style="justify-content:center;gap:0.6rem;"><span>&larr;</span><span class="wp-title">Week of Aug 4</span><span>&rarr;</span></div>'
  },
  { id: 'finance-stats', name: 'Net worth / spent / income', preview:
    '<div class="wp-stat-grid">' +
      '<div class="wp-stat"><div class="wp-stat-val">$12,480</div><div class="wp-muted">Net worth</div></div>' +
      '<div class="wp-stat"><div class="wp-stat-val">$640</div><div class="wp-muted">Spent</div></div>' +
      '<div class="wp-stat"><div class="wp-stat-val">$2,100</div><div class="wp-muted">Income</div></div>' +
    '</div>'
  },
  { id: 'net-worth-breakdown', name: 'Net worth breakdown', preview:
    '<div class="wp-bars"><span class="wp-bar" style="height:80%;"></span><span class="wp-bar" style="height:45%;"></span><span class="wp-bar" style="height:60%;"></span><span class="wp-bar" style="height:30%;"></span></div>'
  },
  { id: 'spending-by-category', name: 'Spending by category', preview:
    '<div class="wp-row"><span>Groceries</span><span class="wp-muted">$210</span></div>' +
    '<div class="wp-row"><span>Dining</span><span class="wp-muted">$140</span></div>'
  },
  { id: 'bank', name: 'Bank (1yr)', preview:
    '<div class="wp-row"><span class="wp-stat-val">$4,210</span><span class="wp-muted">1yr trend</span></div>' +
    '<div class="wp-bars" style="height:1.2rem;"><span class="wp-bar" style="height:40%;"></span><span class="wp-bar" style="height:55%;"></span><span class="wp-bar" style="height:50%;"></span><span class="wp-bar" style="height:70%;"></span><span class="wp-bar" style="height:65%;"></span></div>'
  },
  { id: 'robinhood-agentic', name: 'Robinhood · Agentic', adminOnly: true, preview:
    '<div class="wp-row"><span class="wp-stat-val">$1,204.55</span><span style="color:#3ca05a;">&#9650; 2.1%</span></div>'
  },
  { id: 'robinhood-individual', name: 'Robinhood · Individual', adminOnly: true, preview:
    '<div class="wp-row"><span class="wp-stat-val">$3,880.12</span><span style="color:#3ca05a;">&#9650; 0.6%</span></div>'
  },
  { id: 'status-row', name: 'Status row', preview:
    '<div class="wp-row"><span class="wp-muted">3 entries logged this week</span></div>'
  },
];

var currentWidgetLayout = null; // [{id, enabled, x, y, w, h}, ...] as loaded from /api/me
var isAdminUser = false; // set once /api/me resolves - see loadWidgetLayout()
var editModeOn = false;
var GRID_COLS = 3; // matches .modules' desktop grid-template-columns
var MAX_SPAN = 3;  // "full screen" cap from the 3-column grid's own width

// Financial widgets stay grouped together, always below the locked
// week-nav ("date picker") widget, and never interleave with everything
// else - the constraint the old list-based layout enforced via two
// #calendar-divider/#finance-divider elements, carried forward into the
// freeform grid instead of dropped. week-nav itself is locked separately
// (see LOCKED_WIDGET_ID below), not part of either group.
var FINANCIAL_WIDGET_IDS = {
  'finance-stats': true,
  'net-worth-breakdown': true,
  'spending-by-category': true,
  bank: true,
  'robinhood-agentic': true,
  'robinhood-individual': true,
  'status-row': true,
};
var LOCKED_WIDGET_ID = 'week-nav';

// NULL (no saved layout at all - true for every account that existed before
// per-widget layout did) means "all widgets, enabled, auto-arranged" for
// backward compatibility - nobody's dashboard silently went blank the day
// this shipped. An actual saved array, even an empty one, is taken
// literally: a brand new account starts with widget_layout explicitly set
// to [] (see signup in routes/auth.js) so it renders as a deliberately
// blank dashboard, and widgets missing from a real saved array are simply
// not placed - they show up in the edit-mode gallery instead of being
// silently auto-added. adminOnly widgets are dropped entirely for
// non-admin users either way. x/y/w/h are filled in by packMissingPositions()
// below, not here - this only decides which widgets are in play.
function resolveWidgetLayout(saved) {
  var allowed = WIDGET_REGISTRY.filter(function (r) { return isAdminUser || !r.adminOnly; });
  if (!Array.isArray(saved)) {
    return allowed.map(function (r) { return { id: r.id, enabled: true }; });
  }
  return saved
    .filter(function (w) { return allowed.some(function (r) { return r.id === w.id; }); })
    .map(function (w) { return { id: w.id, enabled: w.enabled !== false, x: w.x, y: w.y, w: w.w, h: w.h }; });
}

// Assigns x/y/w/h to any item missing them (legacy accounts with only
// order-based positions from before this rewrite, or a widget just added
// from the gallery) by packing them into the next open slot, top-left
// first, scanning row by row - the same idea as CSS Grid's own
// auto-placement algorithm, just computed once here so drag/resize have
// real explicit coordinates to work with afterward instead of relying on
// document flow.
function packMissingPositions(items) {
  var occupied = {};
  function isFree(x, y, w, h) {
    for (var dy = 0; dy < h; dy++) {
      for (var dx = 0; dx < w; dx++) {
        if (x + dx >= GRID_COLS) return false;
        if (occupied[(x + dx) + ',' + (y + dy)]) return false;
      }
    }
    return true;
  }
  function occupy(x, y, w, h) {
    for (var dy = 0; dy < h; dy++) {
      for (var dx = 0; dx < w; dx++) occupied[(x + dx) + ',' + (y + dy)] = true;
    }
  }
  items.forEach(function (item) {
    if (typeof item.x === 'number' && typeof item.y === 'number') {
      occupy(item.x, item.y, item.w || 1, item.h || 1);
    }
  });
  return items.map(function (item) {
    if (typeof item.x === 'number' && typeof item.y === 'number') {
      return { id: item.id, enabled: item.enabled, x: item.x, y: item.y, w: item.w || 1, h: item.h || 1 };
    }
    var w = Math.min(item.w || 1, GRID_COLS);
    var h = item.h || 1;
    var y = 0;
    while (true) {
      for (var x = 0; x <= GRID_COLS - w; x++) {
        if (isFree(x, y, w, h)) {
          occupy(x, y, w, h);
          return { id: item.id, enabled: item.enabled, x: x, y: y, w: w, h: h };
        }
      }
      y++;
    }
  });
}

// Re-bin-packs a group of widgets from scratch into the first available
// cell, scanning row by row - reading order is taken from each widget's
// CURRENT x/y (sorted top-left first) so a drag/resize's intended target
// position still determines where things land, but any dead space left
// behind by a previous move/removal gets closed instead of staying empty.
// Also structurally can't produce overlaps, since every widget claims a
// genuinely free cell.
function compactGroup(items) {
  var sorted = items.slice().sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
  var occupied = {};
  function isFree(x, y, w, h) {
    for (var dy = 0; dy < h; dy++) {
      for (var dx = 0; dx < w; dx++) {
        if (x + dx >= GRID_COLS) return false;
        if (occupied[(x + dx) + ',' + (y + dy)]) return false;
      }
    }
    return true;
  }
  function occupy(x, y, w, h) {
    for (var dy = 0; dy < h; dy++) {
      for (var dx = 0; dx < w; dx++) occupied[(x + dx) + ',' + (y + dy)] = true;
    }
  }
  sorted.forEach(function (item) {
    var w = Math.min(item.w, GRID_COLS);
    var y = 0;
    while (true) {
      for (var x = 0; x <= GRID_COLS - w; x++) {
        if (isFree(x, y, w, item.h)) {
          occupy(x, y, w, item.h);
          item.x = x;
          item.y = y;
          return;
        }
      }
      y++;
    }
  });
  return sorted;
}

// Keeps the "date picker" (week-nav) pinned full-width directly beneath
// whatever non-financial content is above it, and keeps every financial
// widget below that line - the financial/non-financial no-mixing rule from
// the old list layout, adapted to explicit grid coordinates. Each group is
// compacted independently (see compactGroup) so gaps left by a removed or
// dragged-away widget get closed instead of leaving dead space, then the
// financial group is shifted down to sit right after the locked widget.
// Disabled widgets (enabled:false - only ever produced by pre-freeform-grid
// saved layouts at this point) are excluded from compaction entirely: they
// render as display:none regardless of x/y, so giving them a reserved cell
// only ever produced a dead-looking gap where the invisible widget "was".
function pinDatePickerAndFinance(layout) {
  var weekNav = layout.find(function (w) { return w.id === LOCKED_WIDGET_ID && w.enabled; });
  var nonFinancial = compactGroup(layout.filter(function (w) { return w.enabled && w.id !== LOCKED_WIDGET_ID && !FINANCIAL_WIDGET_IDS[w.id]; }));
  var financial = compactGroup(layout.filter(function (w) { return w.enabled && FINANCIAL_WIDGET_IDS[w.id]; }));
  var disabled = layout.filter(function (w) { return !w.enabled; });

  var maxNonFinancialBottom = 0;
  nonFinancial.forEach(function (w) { maxNonFinancialBottom = Math.max(maxNonFinancialBottom, w.y + w.h); });

  var financialStartY = maxNonFinancialBottom;
  if (weekNav) {
    weekNav.x = 0;
    weekNav.w = GRID_COLS;
    weekNav.h = 1;
    weekNav.y = maxNonFinancialBottom;
    financialStartY = weekNav.y + weekNav.h;
  }
  financial.forEach(function (w) { w.y += financialStartY; });

  return nonFinancial.concat(weekNav ? [weekNav] : []).concat(financial).concat(disabled);
}

function normalizeLayout(layout) {
  return pinDatePickerAndFinance(layout);
}

// Positions every widget on the live grid via explicit grid-column/grid-row
// (not CSS order - a freeform 2D grid needs real coordinates), hides
// anything disabled or genuinely absent from the layout, and returns the
// packed layout so callers persist/track the canonical positions rather
// than whatever partial data triggered this call. `excludeId`, if given,
// skips writing that one widget's grid-column/row - used while it's being
// actively dragged and is following the pointer via a raw transform
// instead, so it doesn't visually snap to its old/new cell mid-drag.
var ROW_UNIT_PX = 200; // matches the old grid-auto-rows floor, now applied per-widget instead of per-row - see styles.css

function applyGridLayout(layout, excludeId) {
  var packed = normalizeLayout(packMissingPositions(layout));
  var placedIds = {};
  var gridEl = document.querySelector('.modules');
  var gap = gridEl ? (parseFloat(getComputedStyle(gridEl).gap) || 0) : 0;
  packed.forEach(function (w) {
    placedIds[w.id] = true;
    var el = document.querySelector('[data-widget-id="' + w.id + '"]');
    if (!el) return;
    if (w.id !== excludeId) {
      el.style.gridColumn = (w.x + 1) + ' / span ' + w.w;
      el.style.gridRow = (w.y + 1) + ' / span ' + w.h;
    }
    el.style.display = w.enabled ? '' : 'none';
    el.classList.toggle('widget-locked', w.id === LOCKED_WIDGET_ID);
    // Every row used to get a hard 200px floor from the grid itself
    // (grid-auto-rows) - that's now enforced per widget instead, so the
    // locked week-nav widget (which overrides this back to 0 in CSS) can
    // finally be shorter than everything else. League widgets additionally
    // get a matching max-height so a long game list scrolls inside the
    // card instead of growing it past its grid cell.
    var cellHeight = (w.h * ROW_UNIT_PX + (w.h - 1) * gap) + 'px';
    el.style.minHeight = cellHeight;
    el.style.maxHeight = w.id.indexOf('league-') === 0 ? cellHeight : '';
  });
  WIDGET_REGISTRY.forEach(function (r) {
    if (placedIds[r.id]) return;
    var el = document.querySelector('[data-widget-id="' + r.id + '"]');
    if (el) el.style.display = 'none';
  });
  // The old list-reorder system's financial/non-financial dividers are
  // superseded by the border-top "spacer" on the locked week-nav widget
  // itself (see styles.css) - these stay permanently hidden.
  var calendarDivider = document.getElementById('calendar-divider');
  var financeDivider = document.getElementById('finance-divider');
  if (calendarDivider) calendarDivider.style.display = 'none';
  if (financeDivider) financeDivider.style.display = 'none';
  return packed;
}

var persistLayoutTimer = null;
function persistWidgetLayout() {
  clearTimeout(persistLayoutTimer);
  persistLayoutTimer = setTimeout(function () {
    fetch('/api/me/widget-layout', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widget_layout: currentWidgetLayout }),
    });
  }, 500);
}

async function loadWidgetLayout() {
  try {
    var me = await getJSON('/api/me');
    isAdminUser = me.username === 'tslep';
    customThemes = Array.isArray(me.custom_themes) ? me.custom_themes : [];
    populateThemeSelectOptions();
    applyTheme(activeThemeValue); // pick up real colors now that custom themes have loaded
    currentWidgetLayout = applyGridLayout(resolveWidgetLayout(me.widget_layout));
  } catch (err) {
    isAdminUser = false;
    currentWidgetLayout = applyGridLayout(resolveWidgetLayout(null));
  }
}

// ---- edit mode: drag to reposition, drag the corner handle to resize ----
// Built on Pointer Events (not native HTML5 drag-and-drop) for the same
// reason as makeReorderable() elsewhere in this file - it's the one API
// that actually fires on touch as well as mouse, which matters here more
// than anywhere else given the iPad is this dashboard's primary display.
function cellMetrics() {
  var grid = document.querySelector('.modules');
  var rect = grid.getBoundingClientRect();
  var gap = parseFloat(getComputedStyle(grid).gap) || 0;
  var cols = window.innerWidth <= 600 ? 1 : (window.innerWidth <= 900 ? 2 : GRID_COLS);
  var colWidth = (rect.width - gap * (cols - 1)) / cols;
  return { rect: rect, gap: gap, cols: cols, colWidth: colWidth, rowHeight: 200 + gap };
}

function pointToCell(clientX, clientY) {
  var m = cellMetrics();
  var x = Math.floor((clientX - m.rect.left) / (m.colWidth + m.gap));
  var y = Math.floor((clientY - m.rect.top) / m.rowHeight);
  x = Math.max(0, Math.min(m.cols - 1, x));
  y = Math.max(0, y);
  return { x: x, y: y };
}

function findWidget(id) {
  return currentWidgetLayout.find(function (w) { return w.id === id; });
}

// Pure: returns a NEW layout array with `id` moved to (x, y), swapping with
// whatever currently occupies that exact top-left cell, if anything - the
// simplest collision handling that still feels intentional (matches how iOS
// itself swaps two icons dragged onto each other). Never swaps onto the
// locked week-nav widget's cell, since it isn't allowed to move. Used both
// for the live preview during a drag (called on every cell change, not
// committed) and to compute the final position on drop (committed).
function layoutWithMove(layout, id, x, y) {
  var result = layout.map(function (w) { return Object.assign({}, w); });
  var moving = result.find(function (w) { return w.id === id; });
  if (!moving) return result;
  var occupant = result.find(function (w) { return w.id !== id && w.id !== LOCKED_WIDGET_ID && w.x === x && w.y === y; });
  if (occupant) {
    occupant.x = moving.x;
    occupant.y = moving.y;
  }
  moving.x = Math.min(x, GRID_COLS - moving.w);
  moving.y = y;
  return result;
}

var dragState = null;
var resizeState = null;
var pendingPointerFrame = null;

document.addEventListener('pointerdown', function (e) {
  if (!editModeOn) return;
  if (e.target.closest('.widget-remove-btn')) return; // handled by its own click listener
  var moduleEl = e.target.closest('.module[data-widget-id]');
  if (!moduleEl) return;
  if (moduleEl.getAttribute('data-widget-id') === LOCKED_WIDGET_ID) return; // date picker is fixed in place
  if (e.target.closest('.widget-resize-handle')) {
    var item = findWidget(moduleEl.getAttribute('data-widget-id'));
    if (!item) return;
    resizeState = { id: item.id, startX: e.clientX, startY: e.clientY, startW: item.w, startH: item.h };
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  dragState = {
    id: moduleEl.getAttribute('data-widget-id'),
    startClientX: e.clientX,
    startClientY: e.clientY,
    lastClientX: e.clientX,
    lastClientY: e.clientY,
    lastCellX: null,
    lastCellY: null,
    previewLayout: null,
  };
  moduleEl.classList.add('widget-dragging');
  try { moduleEl.setPointerCapture(e.pointerId); } catch (err) {}
  e.preventDefault();
});

// rAF-batched so a flood of pointermove events (touch fires these at a very
// high rate) only ever produces one transform/layout write per frame -
// writing the DOM synchronously on every single event is what made the old
// drag feel "shaky", especially on iPad.
document.addEventListener('pointermove', function (e) {
  if (!dragState && !resizeState) return;
  e.preventDefault();
  if (dragState) {
    dragState.lastClientX = e.clientX;
    dragState.lastClientY = e.clientY;
  } else {
    resizeState.lastClientX = e.clientX;
    resizeState.lastClientY = e.clientY;
  }
  if (pendingPointerFrame) return;
  pendingPointerFrame = requestAnimationFrame(function () {
    pendingPointerFrame = null;
    if (dragState) {
      var el = document.querySelector('[data-widget-id="' + dragState.id + '"]');
      if (el) {
        var dx = dragState.lastClientX - dragState.startClientX;
        var dy = dragState.lastClientY - dragState.startClientY;
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      }
      var cell = pointToCell(dragState.lastClientX, dragState.lastClientY);
      if (cell.x !== dragState.lastCellX || cell.y !== dragState.lastCellY) {
        dragState.lastCellX = cell.x;
        dragState.lastCellY = cell.y;
        // Live preview: show where everything ELSE would land if dropped
        // here right now (the dragged widget itself stays transform-driven,
        // excluded below, so it keeps following the finger with no jump).
        dragState.previewLayout = layoutWithMove(currentWidgetLayout, dragState.id, cell.x, cell.y);
        applyGridLayout(dragState.previewLayout, dragState.id);
      }
    } else if (resizeState) {
      var m = cellMetrics();
      var rdx = resizeState.lastClientX - resizeState.startX;
      var rdy = resizeState.lastClientY - resizeState.startY;
      var addCols = Math.round(rdx / (m.colWidth + m.gap));
      var addRows = Math.round(rdy / m.rowHeight);
      var item = findWidget(resizeState.id);
      if (item) {
        item.w = Math.max(1, Math.min(MAX_SPAN, GRID_COLS - item.x, resizeState.startW + addCols));
        item.h = Math.max(1, Math.min(MAX_SPAN, resizeState.startH + addRows));
        currentWidgetLayout = applyGridLayout(currentWidgetLayout);
      }
    }
  });
}, { passive: false });

document.addEventListener('pointerup', function (e) {
  if (dragState) {
    var el = document.querySelector('[data-widget-id="' + dragState.id + '"]');
    if (el) {
      el.classList.remove('widget-dragging');
      el.style.transform = '';
    }
    currentWidgetLayout = applyGridLayout(dragState.previewLayout || currentWidgetLayout);
    persistWidgetLayout();
    dragState = null;
  } else if (resizeState) {
    resizeState = null;
    persistWidgetLayout();
  }
});

document.addEventListener('click', function (e) {
  var btn = e.target.closest('.widget-remove-btn');
  if (!btn) return;
  var el = btn.closest('[data-widget-id]');
  if (!el) return;
  var id = el.getAttribute('data-widget-id');
  currentWidgetLayout = currentWidgetLayout.filter(function (w) { return w.id !== id; });
  currentWidgetLayout = applyGridLayout(currentWidgetLayout);
  persistWidgetLayout();
  if (editModeOn) renderAddWidgetGallery();
});

// Injects the remove button + resize handle into every widget once, up
// front - simpler and far less repetitive than hand-adding them to every
// module section in index.html.
document.querySelectorAll('[data-widget-id]').forEach(function (el) {
  var removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'widget-remove-btn';
  removeBtn.setAttribute('aria-label', 'Remove widget');
  removeBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  el.appendChild(removeBtn);

  var resizeHandle = document.createElement('span');
  resizeHandle.className = 'widget-resize-handle';
  resizeHandle.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 20L12 20M20 20L20 12M20 20L9 9"/></svg>';
  el.appendChild(resizeHandle);
});

function renderAddWidgetGallery() {
  var listEl = document.getElementById('add-widget-list');
  var placedIds = {};
  currentWidgetLayout.forEach(function (w) { placedIds[w.id] = true; });
  var available = WIDGET_REGISTRY.filter(function (r) {
    if (placedIds[r.id]) return false;
    if (r.adminOnly && !isAdminUser) return false;
    return true;
  });
  if (!available.length) {
    listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">All available widgets are already on your dashboard.</p>';
    return;
  }
  listEl.innerHTML = available.map(function (r) {
    return (
      '<button type="button" class="add-widget-card" data-id="' + r.id + '">' +
        '<span class="add-widget-card-name">' + r.name + '</span>' +
        '<span class="add-widget-card-preview">' + (r.preview || '') + '</span>' +
      '</button>'
    );
  }).join('');
  listEl.querySelectorAll('.add-widget-card').forEach(function (card) {
    card.addEventListener('click', function () {
      currentWidgetLayout.push({ id: card.dataset.id, enabled: true });
      currentWidgetLayout = applyGridLayout(currentWidgetLayout);
      persistWidgetLayout();
      renderAddWidgetGallery();
    });
  });
}

function enterEditMode() {
  editModeOn = true;
  document.body.classList.add('dashboard-edit-mode');
  document.getElementById('add-widget-gallery').style.display = 'block';
  renderAddWidgetGallery();
}
function exitEditMode() {
  editModeOn = false;
  document.body.classList.remove('dashboard-edit-mode');
  document.getElementById('add-widget-gallery').style.display = 'none';
}

document.getElementById('open-customize-dashboard').addEventListener('click', function () {
  if (editModeOn) exitEditMode(); else enterEditMode();
});
document.getElementById('done-editing-btn').addEventListener('click', exitEditMode);

// ---- Photos / slideshow widget (up to 5 photos, auto-advancing) ----
var slideshowPhotos = [];
var slideshowIndex = 0;
var slideshowTimer = null;
var SLIDESHOW_INTERVAL_MS = 6000;

async function loadSlideshow() {
  try {
    slideshowPhotos = await getJSON('/api/slideshow');
  } catch (err) {
    slideshowPhotos = [];
  }
  renderSlideshowViewport();
}

function renderSlideshowViewport() {
  var viewport = document.getElementById('slideshow-viewport');
  var dotsEl = document.getElementById('slideshow-dots');
  if (slideshowTimer) {
    clearInterval(slideshowTimer);
    slideshowTimer = null;
  }

  if (!slideshowPhotos.length) {
    viewport.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No photos yet.</p>';
    dotsEl.innerHTML = '';
    return;
  }

  slideshowIndex = 0;
  viewport.innerHTML = slideshowPhotos.map(function (p, i) {
    return '<img src="' + p.image + '" class="' + (i === 0 ? 'active' : '') + '">';
  }).join('');
  dotsEl.innerHTML = slideshowPhotos.map(function (p, i) {
    return '<span class="slideshow-dot' + (i === 0 ? ' active' : '') + '"></span>';
  }).join('');

  if (slideshowPhotos.length > 1) {
    slideshowTimer = setInterval(function () {
      var imgs = viewport.querySelectorAll('img');
      var dots = dotsEl.querySelectorAll('.slideshow-dot');
      imgs[slideshowIndex].classList.remove('active');
      dots[slideshowIndex].classList.remove('active');
      slideshowIndex = (slideshowIndex + 1) % slideshowPhotos.length;
      imgs[slideshowIndex].classList.add('active');
      dots[slideshowIndex].classList.add('active');
    }, SLIDESHOW_INTERVAL_MS);
  }
}

function renderSlideshowManageList() {
  var listEl = document.getElementById('slideshow-manage-list');
  if (!slideshowPhotos.length) {
    listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No photos yet.</p>';
  } else {
    listEl.innerHTML = slideshowPhotos.map(function (p) {
      return (
        '<div class="slideshow-manage-row" data-id="' + p.id + '">' +
          '<span class="slideshow-manage-thumb-wrap"><img src="' + p.image + '" alt="">Photo</span>' +
          '<button type="button" class="icon-btn remove-slideshow-photo-btn" data-id="' + p.id + '" aria-label="Remove">&times;</button>' +
        '</div>'
      );
    }).join('');
    listEl.querySelectorAll('.remove-slideshow-photo-btn').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        await fetch('/api/slideshow/' + btn.dataset.id, { method: 'DELETE' });
        await loadSlideshow();
        renderSlideshowManageList();
      });
    });
  }
  document.getElementById('slideshow-file-input').closest('.field-group').style.display = slideshowPhotos.length >= 5 ? 'none' : '';
}

var slideshowOverlay = document.getElementById('slideshow-modal-overlay');
document.getElementById('open-slideshow-form').addEventListener('click', function () {
  document.getElementById('slideshow-form-status').textContent = '';
  renderSlideshowManageList();
  slideshowOverlay.classList.add('open');
});
document.getElementById('cancel-slideshow-form').addEventListener('click', function () {
  slideshowOverlay.classList.remove('open');
});
slideshowOverlay.addEventListener('click', function (e) {
  if (e.target === slideshowOverlay) slideshowOverlay.classList.remove('open');
});

document.getElementById('slideshow-file-input').addEventListener('change', async function () {
  var statusEl = document.getElementById('slideshow-form-status');
  var input = this;
  var file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    statusEl.textContent = 'Photo is too large (max 2MB).';
    statusEl.className = 'form-status error';
    input.value = '';
    return;
  }
  try {
    var dataUri = await readFileAsDataURL(file);
    var res = await fetch('/api/slideshow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUri }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not add photo');
    statusEl.textContent = '';
    input.value = '';
    await loadSlideshow();
    renderSlideshowManageList();
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'form-status error';
    input.value = '';
  }
});

// ---- Weather widget (Open-Meteo - free, no API key) ----
async function loadWeather() {
  var contentEl = document.getElementById('weather-content');
  try {
    var data = await getJSON('/api/weather');
    if (!data) {
      contentEl.innerHTML = '<p class="sync-stamp">Set a location&hellip;</p>';
      return;
    }
    contentEl.innerHTML =
      '<p class="sync-stamp">' + data.label + '</p>' +
      '<div class="weather-main">' +
        '<span class="weather-icon">' + (ICONS[data.current.icon] || ICONS['weather-unknown']) + '</span>' +
        '<div>' +
          '<div class="weather-temp">' + data.current.temp + '&deg;F</div>' +
          '<div class="weather-desc">' + data.current.description + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="weather-sub-row">' +
        '<span>H: ' + data.today.high + '&deg; L: ' + data.today.low + '&deg;</span>' +
        '<span>Humidity ' + data.current.humidity + '%</span>' +
        '<span>Wind ' + data.current.wind + ' mph</span>' +
      '</div>';
  } catch (err) {
    contentEl.innerHTML = '<p class="sync-stamp">Could not load weather.</p>';
  }
}

var weatherOverlay = document.getElementById('weather-modal-overlay');
document.getElementById('open-weather-form').addEventListener('click', function () {
  document.getElementById('weather-form-status').textContent = '';
  document.getElementById('weather-search-results').innerHTML = '';
  document.getElementById('weather-search-input').value = '';
  weatherOverlay.classList.add('open');
});
document.getElementById('cancel-weather-form').addEventListener('click', function () {
  weatherOverlay.classList.remove('open');
});
weatherOverlay.addEventListener('click', function (e) {
  if (e.target === weatherOverlay) weatherOverlay.classList.remove('open');
});

document.getElementById('weather-search-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('weather-form-status');
  var resultsEl = document.getElementById('weather-search-results');
  var q = document.getElementById('weather-search-input').value.trim();
  if (!q) return;
  statusEl.textContent = '';
  resultsEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">Searching&hellip;</p>';
  try {
    var results = await getJSON('/api/weather/search?q=' + encodeURIComponent(q));
    if (!results.length) {
      resultsEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No matches found.</p>';
      return;
    }
    resultsEl.innerHTML = results.map(function (r, i) {
      return '<div class="weather-search-result" data-idx="' + i + '">' + r.label + '</div>';
    }).join('');
    resultsEl.querySelectorAll('.weather-search-result').forEach(function (el) {
      el.addEventListener('click', async function () {
        var r = results[Number(el.dataset.idx)];
        try {
          await fetch('/api/me/weather-location', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: { lat: r.lat, lon: r.lon, label: r.label } }),
          });
          weatherOverlay.classList.remove('open');
          await loadWeather();
        } catch (err) {
          statusEl.textContent = 'Could not save location.';
          statusEl.className = 'form-status error';
        }
      });
    });
  } catch (err) {
    resultsEl.innerHTML = '';
    statusEl.textContent = 'Search failed.';
    statusEl.className = 'form-status error';
  }
});

// ---- Sports widget - favorite teams' scores/standings via ESPN's free public API ----
var sportsLeaguesCache = null;

function fmtGameDate(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function teamLogoImg(team, size) {
  if (!team.logo) return '';
  return '<img src="' + team.logo + '" alt="" style="width:' + size + 'px;height:' + size + 'px;object-fit:contain;vertical-align:middle;margin-right:0.3rem;">';
}

function renderGameRow(g, favTeamId) {
  var favIsHome = g.home.id === favTeamId;
  var favTeam = favIsHome ? g.home : g.away;
  var oppTeam = favIsHome ? g.away : g.home;
  var scoreText;
  if (g.status.state === 'final' || g.status.state === 'live') {
    scoreText = favTeam.score + '-' + oppTeam.score + (favTeam.winner ? ' W' : (g.status.state === 'final' ? ' L' : ' •'));
  } else {
    scoreText = fmtGameDate(g.date);
  }
  var oppLabel = (favIsHome ? 'vs ' : '@ ') + oppTeam.name;
  return (
    '<div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;padding:0.1rem 0;">' +
      '<span style="color:var(--muted);display:flex;align-items:center;">' + teamLogoImg(oppTeam, 16) + oppLabel + '</span>' +
      '<span>' + scoreText + '</span>' +
    '</div>'
  );
}

async function loadSports() {
  var list = document.getElementById('sports-list');
  try {
    var scores = await getJSON('/api/sports/scores');
    if (!scores.length) {
      list.innerHTML = '<li style="color:var(--muted);font-size:0.85rem;">No favorite teams yet - tap + to add some.</li>';
      return;
    }
    list.innerHTML = scores.map(function (team) {
      var next = team.upcoming[0];
      var last = team.recent[0];
      return (
        '<li style="display:block;">' +
          '<div style="display:flex;align-items:center;font-weight:600;font-size:0.85rem;margin-bottom:0.2rem;">' +
            teamLogoImg({ logo: team.teamLogo }, 18) + team.teamName +
          '</div>' +
          (next ? renderGameRow(next, team.teamId) : '<div style="font-size:0.78rem;color:var(--muted);">No upcoming game scheduled</div>') +
          (last ? renderGameRow(last, team.teamId) : '') +
        '</li>'
      );
    }).join('');
  } catch (err) {
    list.innerHTML = '<li style="color:var(--muted);font-size:0.85rem;">Could not load.</li>';
  }
}

async function ensureSportsLeagues() {
  if (sportsLeaguesCache) return sportsLeaguesCache;
  sportsLeaguesCache = await getJSON('/api/sports/leagues');
  var select = document.getElementById('sports-league-select');
  select.innerHTML = sportsLeaguesCache.map(function (l) { return '<option value="' + l.key + '">' + l.label + '</option>'; }).join('');
  return sportsLeaguesCache;
}

async function populateStandingsSelect() {
  var select = document.getElementById('sports-standings-select');
  try {
    var favorites = await getJSON('/api/sports/favorites');
    if (!favorites.length) {
      select.style.display = 'none';
      return;
    }
    var leagues = await ensureSportsLeagues();
    var leagueLabel = {};
    leagues.forEach(function (l) { leagueLabel[l.key] = l.label; });
    var seen = {};
    var options = ['<option value="">Games</option>'];
    favorites.forEach(function (f) {
      if (seen[f.league]) return;
      seen[f.league] = true;
      options.push('<option value="' + f.league + '">' + (leagueLabel[f.league] || f.league) + ' standings</option>');
    });
    select.innerHTML = options.join('');
    select.style.display = options.length > 1 ? 'block' : 'none';
  } catch (err) {
    select.style.display = 'none';
  }
}

document.getElementById('sports-standings-select').addEventListener('change', async function () {
  var league = this.value;
  var list = document.getElementById('sports-list');
  if (!league) {
    loadSports();
    return;
  }
  list.innerHTML = '<li class="skel skel-row"></li><li class="skel skel-row"></li>';
  try {
    var data = await getJSON('/api/sports/standings/' + league);
    list.innerHTML = data.groups.map(function (g) {
      var rows = g.teams.map(function (t) {
        return (
          '<div style="display:flex;justify-content:space-between;font-size:0.78rem;padding:0.1rem 0;">' +
            '<span>' + t.teamName + '</span><span style="color:var(--muted);">' + t.record + '</span>' +
          '</div>'
        );
      }).join('');
      return '<li style="display:block;"><div style="font-weight:600;font-size:0.8rem;margin-bottom:0.2rem;">' + g.name + '</div>' + rows + '</li>';
    }).join('');
  } catch (err) {
    list.innerHTML = '<li style="color:var(--muted);font-size:0.85rem;">Could not load standings.</li>';
  }
});

async function renderSportsFavoritesList() {
  var listEl = document.getElementById('sports-favorites-list');
  try {
    var favorites = await getJSON('/api/sports/favorites');
    if (!favorites.length) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No favorite teams yet.</p>';
    } else {
      listEl.innerHTML = favorites.map(function (f) {
        return (
          '<div class="breakdown-row" data-id="' + f.id + '" style="display:flex;align-items:center;justify-content:space-between;padding:0.4rem 0;">' +
            '<span style="display:flex;align-items:center;">' + teamLogoImg({ logo: f.team_logo }, 20) + f.team_name + ' <span style="color:var(--muted);font-size:0.75rem;">&nbsp;(' + f.league.toUpperCase() + ')</span></span>' +
            '<button type="button" class="icon-btn remove-sports-favorite-btn" data-id="' + f.id + '" aria-label="Remove">&times;</button>' +
          '</div>'
        );
      }).join('');
      listEl.querySelectorAll('.remove-sports-favorite-btn').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          await fetch('/api/sports/favorites/' + btn.dataset.id, { method: 'DELETE' });
          renderSportsFavoritesList();
          loadSports();
          populateStandingsSelect();
        });
      });
    }
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">Could not load.</p>';
  }
}

var sportsOverlay = document.getElementById('sports-modal-overlay');
document.getElementById('open-sports-form').addEventListener('click', async function () {
  document.getElementById('sports-form-status').textContent = '';
  document.getElementById('sports-search-results').innerHTML = '';
  document.getElementById('sports-team-search-input').value = '';
  await ensureSportsLeagues();
  renderSportsFavoritesList();
  sportsOverlay.classList.add('open');
});
document.getElementById('cancel-sports-form').addEventListener('click', function () {
  sportsOverlay.classList.remove('open');
});
sportsOverlay.addEventListener('click', function (e) {
  if (e.target === sportsOverlay) sportsOverlay.classList.remove('open');
});

document.getElementById('sports-search-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('sports-form-status');
  var resultsEl = document.getElementById('sports-search-results');
  var league = document.getElementById('sports-league-select').value;
  var q = document.getElementById('sports-team-search-input').value.trim();
  statusEl.textContent = '';
  resultsEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">Searching&hellip;</p>';
  try {
    var teams = await getJSON('/api/sports/' + league + '/teams?q=' + encodeURIComponent(q));
    if (!teams.length) {
      resultsEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No matches found.</p>';
      return;
    }
    resultsEl.innerHTML = teams.slice(0, 15).map(function (t, i) {
      return '<div class="weather-search-result" data-idx="' + i + '" style="display:flex;align-items:center;">' + teamLogoImg(t, 18) + t.name + '</div>';
    }).join('');
    resultsEl.querySelectorAll('.weather-search-result').forEach(function (el) {
      el.addEventListener('click', async function () {
        var t = teams[Number(el.dataset.idx)];
        try {
          var res = await fetch('/api/sports/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ league: league, team_id: t.id, team_name: t.name, team_logo: t.logo }),
          });
          if (!res.ok) throw new Error((await res.json()).error || 'Could not add team');
          renderSportsFavoritesList();
          loadSports();
          populateStandingsSelect();
          resultsEl.innerHTML = '';
        } catch (err) {
          statusEl.textContent = err.message;
          statusEl.className = 'form-status error';
        }
      });
    });
  } catch (err) {
    resultsEl.innerHTML = '';
    statusEl.textContent = 'Search failed.';
    statusEl.className = 'form-status error';
  }
});

// ---- Per-league widgets - league-wide upcoming/recent games, distinct
// from the favorite-teams Sports widget above (routes/sports.js's
// /:league/scoreboard, not /scores). The 3 college leagues get a filter
// (all D1/FBS, Top 25, or one conference) saved per-widget in localStorage -
// simple per-device persistence, no server schema change needed for a
// 2-user personal dashboard. ----
var LEAGUE_WIDGETS = [
  { id: 'league-nfl', league: 'nfl', college: false },
  { id: 'league-mlb', league: 'mlb', college: false },
  { id: 'league-nhl', league: 'nhl', college: false },
  { id: 'league-nba', league: 'nba', college: false },
  { id: 'league-ncaaf', league: 'ncaaf', college: true },
  { id: 'league-ncaambb', league: 'ncaambb', college: true },
  { id: 'league-ncaawbb', league: 'ncaawbb', college: true },
];
var leagueWidgetRotateTimers = {};

function leagueFilterStorageKey(widgetId) {
  return 'league-widget-filter:' + widgetId;
}

function renderLeagueGameRow(g) {
  var scoreText;
  if (g.status.state === 'final' || g.status.state === 'live') {
    scoreText = g.away.score + '-' + g.home.score + (g.status.state === 'live' ? ' •' : '');
  } else {
    scoreText = fmtGameDate(g.date);
  }
  return (
    '<li class="league-game-row">' +
      '<span class="league-game-teams">' +
        teamLogoImg(g.away, 16) + g.away.name + ' @ ' + teamLogoImg(g.home, 16) + g.home.name +
      '</span>' +
      '<span class="league-game-score">' + scoreText + '</span>' +
    '</li>'
  );
}

// Both the upcoming and recent lists page through their full game list a
// screenful at a time - rather than relying on the card's own scrollbar,
// which is easy to miss/hard to use on a wall-mounted iPad nobody's
// actually touching - advancing automatically every 6 seconds instead of
// showing (or requiring a manual scroll through) a long static list.
function startRotation(timerId, events, listEl, pageSize, emptyText) {
  if (leagueWidgetRotateTimers[timerId]) clearInterval(leagueWidgetRotateTimers[timerId]);
  var page = 0;
  var pageCount = Math.max(1, Math.ceil(events.length / pageSize));
  function renderPage() {
    var slice = events.slice(page * pageSize, page * pageSize + pageSize);
    listEl.innerHTML = slice.length ? slice.map(renderLeagueGameRow).join('') : '<li style="color:var(--muted);font-size:0.78rem;">' + emptyText + '</li>';
  }
  renderPage();
  if (pageCount > 1) {
    leagueWidgetRotateTimers[timerId] = setInterval(function () {
      page = (page + 1) % pageCount;
      renderPage();
    }, 10000);
  }
}

async function loadLeagueWidget(cfg) {
  var bodyEl = document.getElementById(cfg.id + '-body');
  if (!bodyEl) return;
  var filter = cfg.college ? (localStorage.getItem(leagueFilterStorageKey(cfg.id)) || 'all') : 'all';
  bodyEl.innerHTML =
    '<div class="league-widget-section-label">Upcoming</div>' +
    '<ul class="league-game-list" id="' + cfg.id + '-upcoming"><li class="skel skel-row"></li></ul>' +
    '<div class="league-widget-section-label">Recent</div>' +
    '<ul class="league-game-list" id="' + cfg.id + '-recent"><li class="skel skel-row"></li></ul>';
  try {
    var data = await getJSON('/api/sports/' + cfg.league + '/scoreboard?filter=' + encodeURIComponent(filter));
    var upcomingEl = document.getElementById(cfg.id + '-upcoming');
    var recentEl = document.getElementById(cfg.id + '-recent');
    // The fetch window covers the next ~10 days, so a team can legitimately
    // have more than one game in it - only its soonest one is kept, so each
    // team shows up once (in chronological order) instead of the list
    // repeating a team for every game it has coming up.
    var seenTeamIds = {};
    var upcoming = (data.upcoming || []).filter(function (g) {
      if (seenTeamIds[g.home.id] || seenTeamIds[g.away.id]) return false;
      seenTeamIds[g.home.id] = true;
      seenTeamIds[g.away.id] = true;
      return true;
    });
    startRotation(cfg.id + '-upcoming', upcoming, upcomingEl, 5, 'No upcoming games');
    startRotation(cfg.id + '-recent', data.recent || [], recentEl, 3, 'No recent games');
  } catch (err) {
    bodyEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">Could not load.</p>';
  }
}

async function initLeagueWidgetFilter(cfg) {
  var select = document.getElementById(cfg.id + '-filter');
  if (!select) return;
  var saved = localStorage.getItem(leagueFilterStorageKey(cfg.id)) || 'all';
  var options = ['<option value="all">All D1/FBS</option>', '<option value="top25">Top 25</option>'];
  try {
    var conferences = await getJSON('/api/sports/' + cfg.league + '/conferences');
    conferences.forEach(function (c) {
      options.push('<option value="' + c.id + '">' + c.name + '</option>');
    });
  } catch (err) {
    // Filter still works with just "All"/"Top 25" if the conference list fails to load.
  }
  select.innerHTML = options.join('');
  select.value = saved;
  select.addEventListener('change', function () {
    localStorage.setItem(leagueFilterStorageKey(cfg.id), select.value);
    loadLeagueWidget(cfg);
  });
}

function initLeagueWidgets() {
  LEAGUE_WIDGETS.forEach(function (cfg) {
    if (cfg.college) initLeagueWidgetFilter(cfg);
    loadLeagueWidget(cfg);
  });
}

// ---- Moon phase widget - pure calculation, no API needed ----
var MOON_PHASE_NAMES = [
  'New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
  'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent',
];

function renderMoonPhase() {
  var synodicMonth = 29.530588853; // average days per lunar cycle
  var knownNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0); // a real reference new moon
  var daysSince = (Date.now() - knownNewMoon) / 86400000;
  var age = daysSince % synodicMonth;
  if (age < 0) age += synodicMonth;

  var fraction = age / synodicMonth;
  var phaseIndex = Math.floor(fraction * 8 + 0.5) % 8;
  var illumination = Math.round((1 - Math.cos(fraction * 2 * Math.PI)) / 2 * 100);

  document.getElementById('moon-phase-emoji').innerHTML = moonPhaseIcon(fraction);
  document.getElementById('moon-phase-name').textContent = MOON_PHASE_NAMES[phaseIndex];
  document.getElementById('moon-phase-illumination').textContent =
    illumination + '% illuminated · day ' + Math.floor(age) + ' of cycle';
}

// ---- Notes widget - one freeform blob per user, autosaved on a debounce ----
var notesSaveTimer = null;

async function loadNotes() {
  try {
    var me = await getJSON('/api/me');
    document.getElementById('notes-textarea').value = me.notes || '';
  } catch (err) {
    // leave the textarea empty - nothing to lose since nothing loaded
  }
}

document.getElementById('notes-textarea').addEventListener('input', function () {
  var statusEl = document.getElementById('notes-status');
  var value = this.value;
  statusEl.textContent = 'Saving…';
  statusEl.className = 'form-status';
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(function () {
    fetch('/api/me/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: value }),
    }).then(function (res) {
      if (!res.ok) throw new Error();
      statusEl.textContent = 'Saved';
      statusEl.className = 'form-status ok';
    }).catch(function () {
      statusEl.textContent = 'Could not save.';
      statusEl.className = 'form-status error';
    });
  }, 800);
});

// ---- Errors widget (admin-only - see routes/errors.js's server-side check) ----
function timeAgo(iso) {
  var diffMs = Date.now() - new Date(iso).getTime();
  var mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}

async function loadErrors() {
  var list = document.getElementById('errors-list');
  try {
    var errors = await getJSON('/api/errors?limit=20');
    if (!errors.length) {
      list.innerHTML = '<li style="color:var(--muted);font-size:0.85rem;">No errors logged.</li>';
      return;
    }
    list.innerHTML = errors.map(function (e) {
      return (
        '<li style="display:block;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem;">' +
            '<span style="font-weight:600;font-size:0.82rem;">[' + e.source + '] ' + e.message + '</span>' +
            '<span style="font-size:0.72rem;color:var(--muted);white-space:nowrap;">' + timeAgo(e.occurred_at) + '</span>' +
          '</div>' +
        '</li>'
      );
    }).join('');
  } catch (err) {
    list.innerHTML = '<li style="color:var(--muted);font-size:0.85rem;">Could not load.</li>';
  }
}

document.getElementById('clear-errors-btn').addEventListener('click', async function () {
  await fetch('/api/errors', { method: 'DELETE' });
  loadErrors();
});

// ---- boot ----
loadTicker();
loadCalendar();
loadSubscriptions();
loadExams();
loadCountdowns();
loadTodos();
loadFinanceAndRobinhood();
loadAgentTracker();
loadRailwayStatus();
loadWidgetLayout().then(function () {
  if (isAdminUser) loadErrors();
});
loadSlideshow();
loadWeather();
loadSports();
initLeagueWidgets();
populateStandingsSelect();
renderMoonPhase();
loadNotes();
