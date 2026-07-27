const API = '';

const NAV_ITEMS = [
  { href: '/', label: 'Home', page: 'home' },
  { href: '/heatmap', label: 'Heatmap', page: 'heatmap' },
  { href: '/dashboard', label: 'Analytics', page: 'dashboard' },
  { href: '/predict', label: 'Predict', page: 'predict' },
  { href: '/chatbot', label: 'Chatbot', page: 'chatbot' },
  { href: '/auth', label: 'Login', page: 'auth' },
];

const MAP_THEMES = {
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { attribution: '&copy; OpenStreetMap & Carto', maxZoom: 20 },
  },
  light: {
    label: 'Light',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { attribution: '&copy; OpenStreetMap contributors', maxZoom: 20 },
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { attribution: 'Tiles &copy; Esri', maxZoom: 19 },
  },
};

const appState = {
  theme: 'light',
  page: document.body.dataset.page || 'home',
  map: null,
  mapLayers: {},
  heatLayer: null,
  traumaLayer: null,
  pinLayer: null,
  selectedPins: [],
  typingTimer: null,
};

const ANALYTICS_PAGES = {
  'analytics-states': {
    title: 'States with the heaviest accident load',
    copy: 'This view ranks regions by accidents while keeping fatalities and injuries readable in the table below.',
    pillA: 'Ranked regions',
    pillB: 'Accidents leader',
  },
  'analytics-weather': {
    title: 'Weather conditions that push severity upward',
    copy: 'This view compares severity across conditions so you can spot which environments deserve extra caution.',
    pillA: 'Condition mix',
    pillB: 'Severity radar',
  },
  'analytics-vehicles': {
    title: 'Vehicle groups behind the incident mix',
    copy: 'This view breaks category share apart so high-volume vehicle classes become obvious at a glance.',
    pillA: 'Category split',
    pillB: 'Volume share',
  },
  'analytics-hourly': {
    title: 'Hourly severity profile across the day',
    copy: 'This view shows when risk intensifies so timing decisions can be made with more confidence.',
    pillA: '24 hour lens',
    pillB: 'Time pressure',
  },
  'analytics-impact': {
    title: 'Feature importance across the prediction model',
    copy: 'This view highlights which variables influence the model most, making the system easier to explain.',
    pillA: 'Model drivers',
    pillB: 'Feature weight',
  },
  'analytics-casualties': {
    title: 'Casualty mix across recorded incidents',
    copy: 'This view keeps the human impact distribution legible instead of burying it under other charts.',
    pillA: 'Impact mix',
    pillB: 'Casualty split',
  },
};

const formatNumber = (value) => new Intl.NumberFormat('en-IN').format(value);
const chartNumber = (value, digits = 2) => Number(value || 0).toFixed(digits);

function getThemeValue(token) {
  return getComputedStyle(document.body).getPropertyValue(token).trim();
}

function getSeriesPalette() {
  return [
    getThemeValue('--accent') || '#8399A2',
    getThemeValue('--accent-strong') || '#6f8690',
    '#d2dde2',
    '#9ab4bd',
    '#5f7f8a',
    '#e8eff2',
  ];
}

async function fetchJson(path, options) {
  const response = await fetch(`${API}${path}`, options);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }
  return response.json();
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function hide(id) {
  const node = document.getElementById(id);
  if (node) node.classList.add('is-hidden');
}

function show(id) {
  const node = document.getElementById(id);
  if (node) node.classList.remove('is-hidden');
}

function escapeHtml(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.RoadZen = {
  escapeHtml,
};
window.appState = appState;

function formatMessage(value) {
  return escapeHtml(value)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

function hydrateNav() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  const currentPage = appState.page.startsWith('analytics-') ? 'dashboard' : appState.page;

  nav.innerHTML = `
    <div class="nav-inner">
      <a class="brand" href="/">
        <span class="brand-mark">RZ</span>
        <span class="brand-copy">RoadZen<br><small>Road intelligence</small></span>
      </a>
      <button class="nav-menu-toggle" type="button" aria-label="Toggle navigation" data-nav-toggle>
        <span></span><span></span><span></span>
      </button>
      <div class="nav-links" data-nav-links>
        ${NAV_ITEMS.map((item) => `
          <a class="nav-link ${item.page === currentPage ? 'active' : ''}" href="${item.href}">${item.label}</a>
        `).join('')}
      </div>
      <div class="nav-actions">
        <div class="nav-status" id="nav-live-status">Live</div>
        <button class="theme-toggle" type="button" id="app-tour"><i class="iconoir-compass" aria-hidden="true"></i><span>Guide</span></button>
        <button class="theme-toggle" type="button" data-theme-toggle><i class="iconoir-sun-light" aria-hidden="true"></i><span>Light mode</span></button>
        <button class="theme-toggle" type="button" id="nav-auth-action"><i class="iconoir-user" aria-hidden="true"></i><span>Sign in</span></button>
      </div>
    </div>
  `;
}

function initAuthStatus() {
  const button = document.getElementById('nav-auth-action');
  if (!button || !window.RoadZenAuth) return;

  button.addEventListener('click', async () => {
    const session = await window.RoadZenAuth.getSession();
    if (session) {
      await window.RoadZenAuth.signOut();
      window.location.href = '/auth';
      return;
    }
    window.location.href = '/auth';
  });

  window.RoadZenAuth.subscribe((authState) => {
    const label = button.querySelector('span');
    if (!authState.enabled) {
      if (label) label.textContent = 'Login setup';
      else button.textContent = 'Login setup';
      return;
    }
    if (label) label.textContent = authState.user ? 'Sign out' : 'Sign in';
    else button.textContent = authState.user ? 'Sign out' : 'Sign in';
  });
}

function initThemeToggle() {
  const storageKey = 'roadzen-theme';
  const applyTheme = (theme) => {
    appState.theme = theme;
    document.body.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      const label = button.querySelector('span');
      if (label) label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
      else button.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    });
    document.querySelectorAll('.theme-switcher button').forEach((button) => {
      button.classList.toggle('active', button.dataset.mapTheme === theme);
    });
    document.dispatchEvent(new CustomEvent('roadzen:themechange', { detail: { theme } }));
  };

  applyTheme(localStorage.getItem(storageKey) || document.body.dataset.theme || 'light');

  document.addEventListener('click', (event) => {
    const themeButton = event.target.closest('[data-theme-toggle]');
    if (themeButton) {
      const nextTheme = appState.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(storageKey, nextTheme);
      applyTheme(nextTheme);
      if (appState.page === 'heatmap' && appState.map) {
        setMapTheme(nextTheme === 'light' ? 'light' : 'light');
      }
      if (appState.page.startsWith('analytics-')) {
        window.setTimeout(() => window.location.reload(), 30);
      }
      return;
    }

    const navToggle = event.target.closest('[data-nav-toggle]');
    if (navToggle) {
      document.body.classList.toggle('nav-open');
    }
  });
}

function initRevealText() {
  if (window.gsap && window.ScrollTrigger) {
    window.gsap.registerPlugin(window.ScrollTrigger);
    window.gsap.utils.toArray('.reveal-text').forEach((node) => {
      window.gsap.fromTo(node, { opacity: 0, y: 24 }, {
        opacity: 1,
        y: 0,
        duration: 0.7,
        ease: 'power2.out',
        scrollTrigger: { trigger: node, start: 'top 88%', once: true },
      });
    });
    return;
  }
  const nodes = document.querySelectorAll('.reveal-text');
  if (!nodes.length) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
      }
    });
  }, { threshold: 0.18 });
  nodes.forEach((node) => observer.observe(node));
}

function revealParallax() {
  const nodes = document.querySelectorAll('[data-parallax]');
  if (!nodes.length) return;

  const update = () => {
    const y = window.scrollY;
    nodes.forEach((node) => {
      const rate = Number(node.dataset.parallax || 0.12);
      node.style.transform = `translate3d(0, ${y * rate}px, 0)`;
    });
  };

  update();
  window.addEventListener('scroll', update, { passive: true });
}

function initButtons() {
  document.querySelectorAll('.button-primary').forEach((button) => {
    button.addEventListener('mousemove', (event) => {
      const bounds = button.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      button.style.setProperty('--mx', `${x}px`);
      button.style.setProperty('--my', `${y}px`);
    });
  });
}

function initMotionAccents() {
  if (!window.anime) return;
  window.anime({
    targets: '.brand-mark',
    scale: [0.96, 1],
    opacity: [0.75, 1],
    duration: 420,
    easing: 'easeOutQuad',
  });
}

function initGuide() {
  const guideButton = document.getElementById('app-tour');
  if (!guideButton) return;
  guideButton.addEventListener('click', () => {
    const driverFactory = window.driver?.js?.driver || window.driver;
    if (!driverFactory) return;
    const tour = driverFactory({
      showProgress: true,
      steps: [
        { element: '.nav-links', popover: { title: 'Navigation', description: 'Move between the map, analytics, predictor, chat, and account portal.' } },
        { element: '.nav-actions', popover: { title: 'Session controls', description: 'Use the guide, switch the visual mode, or sign in before posting reports.' } },
        { element: document.body.dataset.page === 'heatmap' ? '#zone-report-form' : '.page-hero', popover: { title: 'Core workspace', description: 'Each page has one clear job and keeps sensitive account actions behind login.' } },
      ],
    });
    tour.drive();
  });
}

async function initHome() {
  if (appState.page !== 'home') return;
  try {
    const [info, incidents, states] = await Promise.all([
      fetchJson('/api/model-info'),
      fetchJson('/api/recent-incidents'),
      fetchJson('/api/state-stats'),
    ]);

    setText('hero-samples', formatNumber(info.n_samples));
    setText('hero-accuracy', `${(info.accuracy * 100).toFixed(1)}%`);

    const stateLead = states.slice().sort((a, b) => b.accidents - a.accidents).slice(0, 3);
    const stateHost = document.getElementById('state-preview');
    if (stateHost) {
      stateHost.innerHTML = stateLead.map((state) => `
        <div class="story-line story-line-animated">
          <div>
            <strong>${state.state}</strong>
            <div class="small-copy">${formatNumber(state.accidents)} accidents</div>
          </div>
          <div class="risk-chip">${state.risk}</div>
        </div>
      `).join('');
    }

    const incidentHost = document.getElementById('incident-preview');
    if (incidentHost) {
      incidentHost.innerHTML = incidents.slice(0, 4).map((item) => `
        <div class="story-line story-line-animated">
          <div>
            <strong>${item.location}</strong>
            <div class="small-copy">${item.date} · ${item.type}</div>
          </div>
          <div class="risk-chip">${item.severity}</div>
        </div>
      `).join('');
    }

    hide('home-skeleton');
    show('home-live');
  } catch (error) {
    setText('home-error', 'RoadZen could not load the latest highlights right now.');
    show('home-error');
  }
}

function renderChatRow(feed, role, html, meta = []) {
  const row = document.createElement('div');
  row.className = `chat-row ${role}`;
  row.innerHTML = `
    <div class="chat-avatar">${role === 'user' ? 'U' : 'RZ'}</div>
    <div class="chat-bubble ${role === 'bot' ? 'bot-bubble' : 'user-bubble'}">
      <div class="chat-body">${html}</div>
      ${meta.length ? `<div class="chat-meta">${meta.map((item) => `<span class="mini-pill">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    </div>
  `;
  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;
  return row;
}

async function streamChat(message, onChunk) {
  const response = await fetch(`${API}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!response.ok || !response.body) {
    throw new Error('Streaming unavailable');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let donePayload = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    events.forEach((eventBlock) => {
      const typeMatch = eventBlock.match(/event: (.+)/);
      const dataMatch = eventBlock.match(/data: (.+)/);
      if (!typeMatch || !dataMatch) return;
      const eventType = typeMatch[1].trim();
      const payload = JSON.parse(dataMatch[1]);
      if (eventType === 'chunk') onChunk(payload.text || '');
      if (eventType === 'meta') {
        setText('nav-live-status', payload.cached ? 'Cached' : `Live · ${payload.model || 'RoadZen guidance'}`);
      }
      if (eventType === 'done') donePayload = payload;
    });
  }

  return donePayload;
}

async function initLocationWidgets() {
  const targets = document.querySelectorAll('[data-location-widget]');
  if (!targets.length || !navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(async (position) => {
    const { latitude, longitude } = position.coords;
    try {
      const data = await fetchJson(`/api/location-context?lat=${latitude}&lon=${longitude}`);
      document.querySelectorAll('[data-location-name]').forEach((node) => {
        node.textContent = data.location_name || 'Your area';
      });
      document.querySelectorAll('[data-location-temp]').forEach((node) => {
        node.textContent = data.temperature_c == null ? '--' : `${Math.round(data.temperature_c)}°C`;
      });
      document.querySelectorAll('[data-location-weather]').forEach((node) => {
        node.textContent = data.condition || 'Weather unavailable';
      });
      document.querySelectorAll('[data-location-time]').forEach((node) => {
        node.textContent = `${data.time} · ${data.date}`;
      });

      if (appState.page === 'heatmap' && appState.map) {
        appState.map.setView([latitude, longitude], 8, { animate: true });
        addPin([latitude, longitude], 'You are here');
      }
    } catch (_) {
      // noop
    }
  }, () => {}, { enableHighAccuracy: false, timeout: 7000, maximumAge: 300000 });
}

async function initChat() {
  if (appState.page !== 'chatbot') return;

  const feed = document.getElementById('chat-feed');
  const input = document.getElementById('chat-input');
  const sendButton = document.getElementById('chat-send');
  const suggestions = document.getElementById('chat-suggestions');

  const ask = async (message) => {
    renderChatRow(feed, 'user', formatMessage(message));
    input.value = '';

    const botRow = renderChatRow(feed, 'bot', '<span class="typing-indicator"><span></span><span></span><span></span></span>', ['Streaming']);
    const body = botRow.querySelector('.chat-body');
    let answer = '';

    try {
      const result = await streamChat(message, (chunk) => {
        answer += chunk;
        body.innerHTML = formatMessage(answer || '');
        feed.scrollTop = feed.scrollHeight;
      });

      if (result?.suggestions?.length) {
        suggestions.innerHTML = result.suggestions
          .map((item) => `<button class="button button-ghost" data-chat-q="${escapeHtml(item)}">${escapeHtml(item)}</button>`)
          .join('');
      }
    } catch (_) {
      botRow.remove();
      renderChatRow(feed, 'bot', 'RoadZen could not respond right now. Please try again in a moment.');
    }
  };

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-chat-q]');
    if (!trigger) return;
    ask(trigger.dataset.chatQ || trigger.getAttribute('data-chat-q'));
  });

  sendButton?.addEventListener('click', () => {
    const value = input.value.trim();
    if (value) ask(value);
  });

  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim()) {
      event.preventDefault();
      ask(input.value.trim());
    }
  });
}

function buildProbabilityRows(probabilities) {
  return Object.entries(probabilities).map(([label, value]) => `
    <div class="probability-row">
      <div class="legend-row"><span>${label}</span><span>${(value * 100).toFixed(1)}%</span></div>
      <div class="probability-track"><div class="probability-fill" style="width:${value * 100}%"></div></div>
    </div>
  `).join('');
}

async function initPredict() {
  if (appState.page !== 'predict') return;

  const form = document.getElementById('predict-form');
  const result = document.getElementById('predict-result');
  const explainButton = document.getElementById('explain-btn');
  const alertButton = document.getElementById('alert-btn');

  const getPayload = () => ({
    hour: Number(document.getElementById('inp-hour').value),
    driver_age: Number(document.getElementById('inp-age').value),
    engine_size: Number(document.getElementById('inp-engine').value),
    car_age: Number(document.getElementById('inp-carage').value),
    weather: document.getElementById('inp-weather').value,
    lum: document.getElementById('inp-lum').value,
    vehicle_type: document.getElementById('inp-vehicle').value,
    driver_sex: document.getElementById('inp-sex').value,
    week_day: 'T',
    state: 'DL',
  });

  const loadPrediction = async () => {
    result.innerHTML = '<div class="risk-hero"><div class="skeleton-line long"></div><div class="skeleton-line mid" style="margin-top:10px"></div></div>';
    const data = await fetchJson('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getPayload()),
    });
    result.innerHTML = `
      <div class="risk-hero">
        <div class="eyebrow">Predicted severity</div>
        <strong>${data.risk_label}</strong>
        <div class="section-copy">Confidence ${data.confidence.toFixed(1)}% · ${escapeHtml(data.input_summary || '')}</div>
      </div>
      <div class="panel predict-panel">
        <div class="panel-title">Probability breakdown</div>
        <div class="risk-grid">${buildProbabilityRows(data.probabilities)}</div>
      </div>
      <div class="panel predict-panel" id="explain-result">
        <div class="panel-title">Risk explanation</div>
        <div class="helper-text">Use “Explain factors” to see the strongest drivers.</div>
      </div>
    `;
  };

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await loadPrediction();
    } catch (_) {
      result.innerHTML = '<div class="panel predict-panel">Prediction could not be loaded.</div>';
    }
  });

  explainButton?.addEventListener('click', async () => {
    const explainTarget = document.getElementById('explain-result');
    if (!explainTarget) return;
    explainTarget.innerHTML = '<div class="panel-title">Risk explanation</div><div class="skeleton-line long"></div>';
    try {
      const data = await fetchJson('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getPayload()),
      });
      explainTarget.innerHTML = `
        <div class="panel-title">Top risk factors</div>
        <div class="helper-text">${formatMessage(data.explanation)}</div>
        <div class="factor-list">
          ${data.top_factors.map((factor) => `
            <div class="factor-row">
              <div>
                <strong>${factor.feature}</strong>
                <div class="small-copy">${factor.direction} severity</div>
              </div>
              <div>${Math.abs(factor.impact).toFixed(3)}</div>
            </div>
          `).join('')}
        </div>
      `;
    } catch (_) {
      explainTarget.innerHTML = '<div class="panel-title">Risk explanation</div><div class="helper-text">Explanation could not be loaded.</div>';
    }
  });

  alertButton?.addEventListener('click', async () => {
    const explainTarget = document.getElementById('explain-result');
    if (!explainTarget) return;
    explainTarget.innerHTML = '<div class="panel-title">Emergency dispatch</div><div class="helper-text">Sending alert...</div>';
    try {
      const data = await fetchJson('/api/alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ severity: 'Severe', lat: 28.61, lng: 77.23 }),
      });
      explainTarget.innerHTML = `
        <div class="panel-title">Emergency dispatch</div>
        <div class="helper-text">${data.alert_status} · Ambulance ETA ${data.estimated_response}</div>
        <div class="factor-list">
          ${data.notified_centers.map((item) => `
            <div class="factor-row">
              <div><strong>${item.hospital}</strong><div class="small-copy">${item.city} · ${item.distance_km} km</div></div>
              <div>${item.eta}</div>
            </div>
          `).join('')}
        </div>
      `;
    } catch (_) {
      explainTarget.innerHTML = '<div class="panel-title">Emergency dispatch</div><div class="helper-text">Alert service is unavailable.</div>';
    }
  });

  try {
    const info = await fetchJson('/api/model-info');
    setText('predict-accuracy', `${(info.accuracy * 100).toFixed(1)}%`);
    setText('predict-samples', formatNumber(info.n_samples));
  } catch (_) {
    // noop
  }
}

function haversineDistance([lat1, lon1], [lat2, lon2]) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function setMapTheme(themeKey) {
  if (!appState.map) return;
  Object.values(appState.mapLayers).forEach((layer) => appState.map.removeLayer(layer));
  appState.mapLayers[themeKey].addTo(appState.map);
  document.querySelectorAll('[data-map-theme]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mapTheme === themeKey);
  });
}

function addPin(latlng, label) {
  if (!appState.pinLayer) return;
  const marker = L.marker(latlng, { riseOnHover: true }).bindPopup(`${label}<br>${latlng[0].toFixed(5)}, ${latlng[1].toFixed(5)}`);
  appState.pinLayer.addLayer(marker);
  appState.selectedPins.push(latlng);
  if (appState.selectedPins.length > 2) {
    appState.selectedPins.shift();
    const markers = appState.pinLayer.getLayers();
    if (markers.length > 2) {
      appState.pinLayer.removeLayer(markers[0]);
    }
  }
  updateDistanceUI();
}

function updateDistanceUI() {
  const details = document.getElementById('map-distance');
  const coords = document.getElementById('map-coordinates');
  if (!details || !coords) return;
  coords.innerHTML = appState.selectedPins.map((pin, index) => `<div>P${index + 1}: ${pin[0].toFixed(5)}, ${pin[1].toFixed(5)}</div>`).join('') || 'Click anywhere on the map to mark a point.';
  if (appState.selectedPins.length === 2) {
    const km = haversineDistance(appState.selectedPins[0], appState.selectedPins[1]);
    details.textContent = `${km.toFixed(2)} km between selected points`;
  } else {
    details.textContent = 'Select two points to calculate distance.';
  }
}

async function initHeatmap() {
  // Heatmap initialization is handled by heatmap-engine.js
  // This stub remains for compatibility with the DOMContentLoaded boot sequence.
  return;
}

function renderDashboardCards(cards) {
  const host = document.getElementById('dashboard-analytics-grid');
  if (!host) return;
  host.innerHTML = cards.map((card) => `
    <a class="analytic-card" href="${card.href}">
      <div class="analytic-card-head">
        <div>
          <div class="eyebrow">${card.kicker}</div>
          <div class="analytic-card-title">${card.title}</div>
        </div>
        <div class="library-pill">${card.library}</div>
      </div>
      <div class="analytic-card-copy">${card.copy}</div>
      <div class="analytic-card-metric">${card.metric}</div>
      <div class="analytic-card-foot">
        <span class="mini-pill">${card.support}</span>
        <span class="analytic-card-link">Open analysis</span>
      </div>
    </a>
  `).join('');
}

function renderDashboardIncidents(incidents) {
  const host = document.getElementById('dashboard-incidents');
  if (!host) return;
  host.innerHTML = incidents.slice(0, 3).map((item) => `
    <div class="incident-card">
      <div class="analytic-card-head">
        <strong>${escapeHtml(item.location)}</strong>
        <span class="risk-chip">${escapeHtml(item.severity)}</span>
      </div>
      <div class="incident-copy">${escapeHtml(item.date)} · ${escapeHtml(item.type)}</div>
    </div>
  `).join('');
}

async function initDashboard() {
  if (appState.page !== 'dashboard') return;

  try {
    const [states, weather, vehicle, hourly, importance, casualties, incidents] = await Promise.all([
      fetchJson('/api/state-stats'),
      fetchJson('/api/weather-stats'),
      fetchJson('/api/vehicle-stats'),
      fetchJson('/api/hourly-stats'),
      fetchJson('/api/feature-importance'),
      fetchJson('/api/casualty-stats'),
      fetchJson('/api/recent-incidents'),
    ]);

    const topState = states.slice().sort((a, b) => b.accidents - a.accidents)[0];
    const topWeather = weather.slice().sort((a, b) => b.avg_severity - a.avg_severity)[0];
    const topVehicle = vehicle.slice().sort((a, b) => b.avg_severity - a.avg_severity)[0];
    const topHour = hourly.slice().sort((a, b) => b.avg_severity - a.avg_severity)[0];
    const topImpact = importance.slice().sort((a, b) => b.importance - a.importance)[0];
    const topCasualty = casualties.slice().sort((a, b) => b.count - a.count)[0];

    setText('dash-top-state', topState?.state || '--');
    setText('dash-top-weather', topWeather?.weather || '--');
    setText('dash-top-vehicle', topVehicle?.vehicle_type || '--');
    setText('dash-top-hour', topHour ? `${topHour.hour}:00` : '--');
    setText('dash-top-state-copy', topState ? `${formatNumber(topState.accidents)} accidents recorded` : 'State trend unavailable');
    setText('dash-top-weather-copy', topWeather ? `${chartNumber(topWeather.avg_severity)} avg severity` : 'Weather signal unavailable');
    setText('dash-top-vehicle-copy', topVehicle ? `${chartNumber(topVehicle.avg_severity)} avg severity` : 'Vehicle mix unavailable');
    setText('dash-top-hour-copy', topHour ? `${chartNumber(topHour.avg_severity)} avg severity window` : 'Hourly pressure unavailable');
    setText('dash-guidance-title', topState ? `Start with ${topState.state}, then validate timing against ${topHour.hour}:00.` : 'Open the focused analytics pages.');
    setText('dash-guidance-copy', topImpact ? `${topImpact.feature.replace('_encoded', '')} is a strong model driver, so compare it with the casualty mix before acting.` : 'Use the dedicated analytics pages to turn trends into action.');
    setText('dash-state-count', formatNumber(states.length));
    setText('dash-weather-count', formatNumber(weather.length));
    setText('dash-vehicle-count', formatNumber(vehicle.length));
    setText('dash-hour-count', formatNumber(hourly.length));

    renderDashboardCards([
      { href: '/analytics/states', kicker: 'State risk', title: 'State comparisons', copy: 'Rank high-pressure regions and compare accidents, fatalities, and injuries side by side.', metric: topState ? formatNumber(topState.accidents) : '--', support: topState ? `${topState.state} leads` : 'Regional view', library: 'ApexCharts' },
      { href: '/analytics/weather', kicker: 'Weather lens', title: 'Weather severity', copy: 'See which conditions correlate with the sharpest severity spikes.', metric: topWeather ? chartNumber(topWeather.avg_severity) : '--', support: topWeather ? `${topWeather.weather} peaks` : 'Condition view', library: 'ECharts' },
      { href: '/analytics/vehicles', kicker: 'Vehicle mix', title: 'Vehicle distribution', copy: 'Break down the traffic mix so vulnerable or high-volume segments stand out clearly.', metric: topVehicle ? formatNumber(topVehicle.count) : '--', support: topVehicle ? `${topVehicle.vehicle_type} dominant` : 'Category view', library: 'Chart.js' },
      { href: '/analytics/hourly', kicker: 'Time pressure', title: 'Hourly severity', copy: 'Track the day’s risk rhythm and see when operational pressure builds fastest.', metric: topHour ? `${topHour.hour}:00` : '--', support: topHour ? `${chartNumber(topHour.avg_severity)} severity` : 'Time view', library: 'Plotly' },
      { href: '/analytics/impact', kicker: 'Model logic', title: 'Feature importance', copy: 'Understand which inputs the model relies on most when estimating risk.', metric: topImpact ? chartNumber(topImpact.importance, 3) : '--', support: topImpact ? topImpact.feature.replace('_encoded', '') : 'Model view', library: 'ECharts' },
      { href: '/analytics/casualties', kicker: 'Human impact', title: 'Casualty distribution', copy: 'Read the casualty mix separately so it does not get lost inside broader dashboard summaries.', metric: topCasualty ? formatNumber(topCasualty.count) : '--', support: topCasualty ? `${topCasualty.casualty_type} largest` : 'Impact view', library: 'Chart.js' },
    ]);

    renderDashboardIncidents(incidents);

    hide('dashboard-skeleton');
    show('dashboard-live');
  } catch (_) {
    setText('dashboard-error', 'Dashboard analytics could not be loaded.');
    show('dashboard-error');
  }
}

function setAnalyticsText(config) {
  setText('analytics-title', config.title);
  setText('analytics-copy', config.copy);
  setText('analytics-pill-a', config.pillA);
  setText('analytics-pill-b', config.pillB);
}

function renderAnalyticsTable(rows, formatter) {
  const body = document.getElementById('analytics-table-body');
  if (body) body.innerHTML = rows.map(formatter).join('');
}

function createChartJsPalette(alpha = 0.72) {
  return getSeriesPalette().map((color) => {
    if (!color.startsWith('#')) return color;
    return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
  });
}

function buildChartJsOptions() {
  const muted = getThemeValue('--muted') || '#b6c3c9';
  const line = getThemeValue('--line') || 'rgba(255,255,255,0.12)';
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: muted } },
    },
    scales: {
      x: { ticks: { color: muted }, grid: { color: line } },
      y: { ticks: { color: muted }, grid: { color: line } },
    },
  };
}

async function initAnalyticsPage() {
  if (!ANALYTICS_PAGES[appState.page]) return;

  try {
    const config = ANALYTICS_PAGES[appState.page];
    setAnalyticsText(config);

    if (appState.page === 'analytics-states') {
      const states = await fetchJson('/api/state-stats');
      renderAnalyticsTable(states.slice(0, 12), (state) => `<tr><td>${state.state}</td><td>${formatNumber(state.accidents)}</td><td>${formatNumber(state.fatalities)}</td><td>${formatNumber(state.injuries)}</td><td>${state.risk}</td></tr>`);
      if (window.ApexCharts) {
        const container = document.getElementById('analytics-chart');
        container.innerHTML = '';
        const chart = new ApexCharts(container, {
          chart: { type: 'bar', height: 420, toolbar: { show: false }, background: 'transparent' },
          series: [{ name: 'Accidents', data: states.slice(0, 10).map((item) => item.accidents) }],
          colors: [getThemeValue('--accent') || '#8399A2'],
          plotOptions: { bar: { horizontal: true, borderRadius: 10 } },
          xaxis: { categories: states.slice(0, 10).map((item) => item.code || item.state), labels: { style: { colors: getThemeValue('--muted') } } },
          yaxis: { labels: { style: { colors: getThemeValue('--muted') } } },
          grid: { borderColor: getThemeValue('--line') },
          tooltip: { theme: appState.theme },
          theme: { mode: appState.theme },
        });
        chart.render();
      }
    }

    if (appState.page === 'analytics-weather') {
      const weather = await fetchJson('/api/weather-stats');
      const total = weather.reduce((sum, item) => sum + Number(item.count || 0), 0);
      renderAnalyticsTable(weather, (item) => `<tr><td>${item.weather}</td><td>${chartNumber(item.avg_severity)}</td><td>${total ? chartNumber((item.count / total) * 100) : '0.00'}%</td></tr>`);
      if (window.echarts) {
        const maxValue = Math.max(...weather.map((item) => Number(item.avg_severity || 0)), 1);
        const chart = window.echarts.init(document.getElementById('analytics-chart'), null, { renderer: 'canvas' });
        chart.setOption({
          backgroundColor: 'transparent',
          textStyle: { color: getThemeValue('--muted') },
          radar: {
            indicator: weather.map((item) => ({ name: item.weather, max: maxValue + 1 })),
            axisName: { color: getThemeValue('--muted') },
            splitLine: { lineStyle: { color: getThemeValue('--line') } },
            splitArea: { areaStyle: { color: ['transparent'] } },
          },
          series: [{ type: 'radar', data: [{ value: weather.map((item) => Number(item.avg_severity || 0)), areaStyle: { color: getThemeValue('--accent-soft') }, lineStyle: { color: getThemeValue('--accent') }, symbolSize: 8 }] }],
        });
      }
    }

    if (appState.page === 'analytics-vehicles') {
      const vehicle = await fetchJson('/api/vehicle-stats');
      renderAnalyticsTable(vehicle, (item) => `<tr><td>${item.vehicle_type}</td><td>${formatNumber(item.count)}</td><td>${chartNumber(item.avg_severity)}</td></tr>`);
      if (window.Chart) {
        new Chart(document.getElementById('analytics-chart'), {
          type: 'doughnut',
          data: { labels: vehicle.map((item) => item.vehicle_type), datasets: [{ data: vehicle.map((item) => item.count), backgroundColor: createChartJsPalette(0.8), borderColor: getThemeValue('--bg') || '#081014', borderWidth: 2 }] },
          options: { ...buildChartJsOptions(), cutout: '58%', scales: {} },
        });
      }
    }

    if (appState.page === 'analytics-hourly') {
      const hourly = await fetchJson('/api/hourly-stats');
      renderAnalyticsTable(hourly, (item) => `<tr><td>${item.hour}:00</td><td>${chartNumber(item.avg_severity)}</td><td>${formatNumber(item.count)}</td></tr>`);
      if (window.Plotly) {
        window.Plotly.newPlot('plotly-chart', [{
          x: hourly.map((item) => `${item.hour}:00`),
          y: hourly.map((item) => Number(item.avg_severity || 0)),
          type: 'scatter',
          mode: 'lines+markers',
          fill: 'tozeroy',
          line: { color: getThemeValue('--accent') || '#8399A2', width: 3 },
          marker: { color: getThemeValue('--accent-strong') || '#6f8690', size: 8 },
          fillcolor: getThemeValue('--accent-soft') || 'rgba(131,153,162,0.18)',
          hovertemplate: '%{x}<br>Severity %{y:.2f}<extra></extra>',
        }], {
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          margin: { t: 10, r: 20, b: 50, l: 50 },
          font: { color: getThemeValue('--muted') || '#b6c3c9' },
          xaxis: { gridcolor: getThemeValue('--line') },
          yaxis: { gridcolor: getThemeValue('--line') },
        }, { displayModeBar: false, responsive: true });
      }
    }

    if (appState.page === 'analytics-impact') {
      const importance = await fetchJson('/api/feature-importance');
      renderAnalyticsTable(importance, (item) => `<tr><td>${item.feature.replace('_encoded', '')}</td><td>${chartNumber(item.importance, 3)}</td></tr>`);
      if (window.echarts) {
        const chart = window.echarts.init(document.getElementById('analytics-chart'), null, { renderer: 'canvas' });
        chart.setOption({
          backgroundColor: 'transparent',
          grid: { left: 110, right: 30, top: 20, bottom: 30 },
          xAxis: { type: 'value', axisLabel: { color: getThemeValue('--muted') }, splitLine: { lineStyle: { color: getThemeValue('--line') } } },
          yAxis: { type: 'category', axisLabel: { color: getThemeValue('--muted') }, data: importance.map((item) => item.feature.replace('_encoded', '')) },
          series: [{ type: 'bar', data: importance.map((item) => Number(item.importance || 0)), itemStyle: { color: getThemeValue('--accent') || '#8399A2', borderRadius: [0, 10, 10, 0] } }],
        });
      }
    }

    if (appState.page === 'analytics-casualties') {
      const casualties = await fetchJson('/api/casualty-stats');
      const total = casualties.reduce((sum, item) => sum + Number(item.count || 0), 0);
      renderAnalyticsTable(casualties, (item) => `<tr><td>${item.casualty_type}</td><td>${formatNumber(item.count)}</td><td>${total ? chartNumber((item.count / total) * 100) : '0.00'}%</td></tr>`);
      if (window.Chart) {
        new Chart(document.getElementById('analytics-chart'), {
          type: 'polarArea',
          data: { labels: casualties.map((item) => item.casualty_type), datasets: [{ data: casualties.map((item) => item.count), backgroundColor: createChartJsPalette(0.72), borderColor: getThemeValue('--bg') || '#081014', borderWidth: 2 }] },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: getThemeValue('--muted') || '#b6c3c9' } } },
            scales: { r: { grid: { color: getThemeValue('--line') }, pointLabels: { color: getThemeValue('--muted') || '#b6c3c9' }, ticks: { color: getThemeValue('--muted') || '#b6c3c9', backdropColor: 'transparent' } } },
          },
        });
      }
    }
  } catch (_) {
    setText('analytics-error', 'The selected analytics page could not be loaded.');
    show('analytics-error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  hydrateNav();
  initThemeToggle();
  initAuthStatus();
  initRevealText();
  revealParallax();
  initButtons();
  initMotionAccents();
  initGuide();
  initHome();
  initChat();
  initPredict();
  initHeatmap();
  initDashboard();
  initAnalyticsPage();
  initLocationWidgets();
});
