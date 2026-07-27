/* ========== RoadZen Frontend App ========== */
const API = '';
let map, heatLayer, hospitalMarkers = [], heatmapVisible = true, hospitalsVisible = true;

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadModelInfo();
  loadCharts();
  loadHeatmap();
  loadHospitals();
});

// ========== MAP ==========
function initMap() {
  map = L.map('map').setView([28.61, 77.23], 11);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB', maxZoom: 19
  }).addTo(map);
}

async function loadHeatmap() {
  try {
    const res = await fetch(`${API}/api/heatmap`);
    const data = await res.json();
    const pts = data.map(d => [d.lat, d.lng, d.intensity || 0.5]);
    heatLayer = L.heatLayer(pts, { radius: 18, blur: 25, maxZoom: 15, gradient: {0.2:'#00f', 0.4:'#0ff', 0.6:'#0f0', 0.8:'#ff0', 1:'#f00'} }).addTo(map);
    if (pts.length) map.fitBounds(pts.map(p => [p[0], p[1]]));
  } catch(e) { console.log('Heatmap not loaded', e); }
}

async function loadHospitals() {
  try {
    const res = await fetch(`${API}/api/trauma-centers`);
    const data = await res.json();
    const icon = L.divIcon({ html: '<div style="font-size:24px">🏥</div>', className: '', iconSize: [30,30] });
    data.forEach(h => {
      const m = L.marker([h.lat, h.lng], {icon}).addTo(map)
        .bindPopup(`<div style="font-size:13px;min-width:200px"><b>${h.name}</b><br>Type: ${h.type}<br>Speciality: ${h.speciality}<br>Beds: ${h.beds}<br>📞 ${h.phone}</div>`);
      hospitalMarkers.push(m);
    });
  } catch(e) { console.log('Hospitals not loaded', e); }
}

function toggleHeatmap() { if (!heatLayer) return; heatmapVisible = !heatmapVisible; heatmapVisible ? map.addLayer(heatLayer) : map.removeLayer(heatLayer); }
function toggleHospitals() { hospitalsVisible = !hospitalsVisible; hospitalMarkers.forEach(m => hospitalsVisible ? map.addLayer(m) : map.removeLayer(m)); }
function resetMap() { map.setView([28.61, 77.23], 11); }

// ========== MODEL INFO ==========
async function loadModelInfo() {
  try {
    const res = await fetch(`${API}/api/model-info`);
    const d = await res.json();
    document.getElementById('stat-accuracy').textContent = (d.accuracy * 100).toFixed(1) + '%';
    document.getElementById('stat-samples').textContent = d.n_samples.toLocaleString();
  } catch(e) {}
}

// ========== PREDICTION ==========
function getInputData() {
  return {
    hour: parseInt(document.getElementById('inp-hour').value),
    driver_age: parseInt(document.getElementById('inp-age').value),
    engine_size: parseInt(document.getElementById('inp-engine').value),
    car_age: parseInt(document.getElementById('inp-carage').value),
    weather: document.getElementById('inp-weather').value,
    lum: document.getElementById('inp-lum').value,
    vehicle_type: document.getElementById('inp-vehicle').value,
    driver_sex: document.getElementById('inp-sex').value,
    week_day: 'T', state: 'DL'
  };
}

async function predictRisk() {
  const data = getInputData();
  try {
    const res = await fetch(`${API}/predict`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    const r = await res.json();
    if (r.error) { alert('Error: ' + r.error); return; }
    showResult(r);
  } catch(e) { alert('Cannot connect to backend. Is it running?'); }
}

function showResult(r) {
  document.getElementById('result-placeholder').style.display = 'none';
  document.getElementById('result-content').style.display = 'block';
  document.getElementById('explain-content').style.display = 'none';
  document.getElementById('alert-content').style.display = 'none';

  const colors = { Minor: '#10b981', Moderate: '#f59e0b', Severe: '#ef4444' };
  const c = colors[r.risk_label] || '#00d4ff';
  document.getElementById('gauge-ring').style.borderTopColor = c;
  document.getElementById('gauge-ring').style.borderColor = `${c}33`;
  document.getElementById('gauge-ring').style.borderTopColor = c;
  document.getElementById('gauge-label').textContent = r.risk_label;
  document.getElementById('gauge-label').style.color = c;
  document.getElementById('gauge-conf').textContent = r.confidence.toFixed(1) + '% confidence';

  const bars = document.getElementById('prob-bars');
  bars.innerHTML = '';
  for (const [label, val] of Object.entries(r.probabilities)) {
    bars.innerHTML += `<div class="prob-bar-wrap"><div class="prob-bar-label"><span>${label}</span><span>${(val*100).toFixed(1)}%</span></div><div class="prob-bar"><div class="prob-bar-fill" style="width:${val*100}%;background:${colors[label]}"></div></div></div>`;
  }
}

async function explainRisk() {
  const data = getInputData();
  try {
    const res = await fetch(`${API}/explain`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    const r = await res.json();
    if (r.error) { alert('Error: ' + r.error); return; }
    document.getElementById('result-placeholder').style.display = 'none';
    document.getElementById('explain-content').style.display = 'block';
    const el = document.getElementById('shap-factors');
    el.innerHTML = '';
    r.top_factors.forEach(f => {
      const color = f.impact > 0 ? '#ef4444' : '#10b981';
      const width = Math.min(Math.abs(f.impact) * 200, 100);
      el.innerHTML += `<div class="shap-factor"><span class="feat-name">${f.feature}</span><div class="shap-bar"><div class="shap-bar-fill" style="width:${width}%;background:${color}"></div></div><span class="shap-val" style="color:${color}">${f.impact > 0 ? '↑' : '↓'} ${Math.abs(f.impact).toFixed(3)}</span></div>`;
    });
  } catch(e) { alert('Cannot connect to backend.'); }
}

async function sendAlert() {
  try {
    const res = await fetch(`${API}/api/alert`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({severity:'Severe', lat:28.61, lng:77.23}) });
    const r = await res.json();
    document.getElementById('result-placeholder').style.display = 'none';
    document.getElementById('alert-content').style.display = 'block';
    const el = document.getElementById('alert-info');
    let html = `<div class="alert-notif sent">🚨 Alert Status: <strong>${r.alert_status}</strong> | Ambulance ETA: ${r.estimated_response}</div>`;
    r.notified_centers.forEach(c => {
      html += `<div class="alert-notif">🏥 ${c.hospital} — ${c.status} — ETA: ${c.eta}</div>`;
    });
    el.innerHTML = html;
  } catch(e) { alert('Cannot connect to backend.'); }
}

// ========== CHARTS ==========
const chartColors = { bg: ['rgba(0,212,255,0.6)','rgba(124,58,237,0.6)','rgba(16,185,129,0.6)','rgba(245,158,11,0.6)','rgba(239,68,68,0.6)','rgba(99,102,241,0.6)','rgba(6,182,212,0.6)'], border: ['#00d4ff','#7c3aed','#10b981','#f59e0b','#ef4444','#6366f1','#06b6d4'] };
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

async function loadCharts() {
  try {
    const [hourly, weather, vehicle, importance, day, casualty] = await Promise.all([
      fetch(`${API}/api/hourly-stats`).then(r => r.json()),
      fetch(`${API}/api/weather-stats`).then(r => r.json()),
      fetch(`${API}/api/vehicle-stats`).then(r => r.json()),
      fetch(`${API}/api/feature-importance`).then(r => r.json()),
      fetch(`${API}/api/day-stats`).then(r => r.json()),
      fetch(`${API}/api/casualty-stats`).then(r => r.json())
    ]);
    makeChart('chart-hourly', 'line', hourly.map(d=>d.hour), hourly.map(d=>d.avg_severity), 'Avg Severity', hourly.map(d=>d.count), 'Accidents');
    makeBarChart('chart-weather', weather.map(d=>d.weather), weather.map(d=>d.avg_severity), 'Avg Severity');
    makeBarChart('chart-vehicle', vehicle.map(d=>d.vehicle_type), vehicle.map(d=>d.avg_severity), 'Avg Severity');
    makeHorizontalBar('chart-importance', importance.map(d=>d.feature.replace('_encoded','')), importance.map(d=>d.importance), 'Importance');
    makeBarChart('chart-day', day.map(d=>d.day), day.map(d=>d.avg_severity), 'Avg Severity');
    makeDoughnut('chart-casualty', casualty.map(d=>d.casualty_type), casualty.map(d=>d.count));
  } catch(e) { console.log('Charts error', e); }
}

function makeChart(id, type, labels, data1, l1, data2, l2) {
  new Chart(document.getElementById(id), {
    type, data: { labels, datasets: [
      { label: l1, data: data1, borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,0.1)', fill: true, tension: 0.4 },
      ...(data2 ? [{ label: l2, data: data2, borderColor: '#7c3aed', backgroundColor: 'rgba(124,58,237,0.1)', fill: true, tension: 0.4, yAxisID: 'y1' }] : [])
    ]}, options: { responsive: true, plugins: { legend: { labels: { font: { size: 11 }}}}, scales: { y: { beginAtZero: true }, ...(data2 ? { y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }}} : {})}}
  });
}

function makeBarChart(id, labels, data, label) {
  new Chart(document.getElementById(id), {
    type: 'bar', data: { labels, datasets: [{ label, data, backgroundColor: chartColors.bg.slice(0, data.length), borderColor: chartColors.border.slice(0, data.length), borderWidth: 1 }]},
    options: { responsive: true, plugins: { legend: { display: false }}, scales: { y: { beginAtZero: true }}}
  });
}

function makeHorizontalBar(id, labels, data, label) {
  new Chart(document.getElementById(id), {
    type: 'bar', data: { labels, datasets: [{ label, data, backgroundColor: 'rgba(0,212,255,0.6)', borderColor: '#00d4ff', borderWidth: 1 }]},
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false }}}
  });
}

function makeDoughnut(id, labels, data) {
  new Chart(document.getElementById(id), {
    type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: chartColors.bg, borderColor: 'transparent' }]},
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }}}}}
  });
}

// ========== CHATBOT ==========
async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  addChatMsg(msg, 'user');
  try {
    const res = await fetch(`${API}/api/chat`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({message: msg}) });
    const r = await res.json();
    addChatMsg(r.reply, 'bot', r.suggestions);
  } catch(e) { addChatMsg('⚠️ Cannot connect to backend. Please ensure the server is running on port 8000.', 'bot'); }
}

function quickChat(msg) {
  document.getElementById('chat-input').value = msg;
  sendChat();
}

function addChatMsg(text, type, suggestions) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${type}-msg`;
  const avatar = type === 'bot' ? '🤖' : '👤';
  let sugHtml = '';
  if (suggestions && suggestions.length) {
    sugHtml = '<div class="msg-suggestions">' + suggestions.map(s => `<button class="suggestion-btn" onclick="quickChat('${s}')">${s}</button>`).join('') + '</div>';
  }
  // Convert markdown-like bold
  const formatted = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  div.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="msg-bubble"><p>${formatted}</p>${sugHtml}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}
