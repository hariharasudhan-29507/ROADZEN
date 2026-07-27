/* =============================================
   RoadZen Heatmap Engine
   Leaflet + OpenStreetMap with Google Maps–level features
   ============================================= */

(function () {
  'use strict';

  if (document.body.dataset.page !== 'heatmap') return;

  /* ── Theme registry (7 map themes) ── */
  const THEMES = {
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      opt: { attribution: '&copy; OpenStreetMap &amp; Carto', maxZoom: 20, subdomains: 'abcd' },
    },
    light: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      opt: { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 },
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opt: { attribution: 'Tiles &copy; Esri', maxZoom: 19 },
    },
    terrain: {
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      opt: { attribution: '&copy; OpenTopoMap', maxZoom: 17 },
    },
    watercolor: {
      url: 'https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg',
      opt: { attribution: '&copy; Stadia Maps &amp; Stamen', maxZoom: 16 },
    },
    toner: {
      url: 'https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}{r}.png',
      opt: { attribution: '&copy; Stadia Maps &amp; Stamen', maxZoom: 20 },
    },
    humanitarian: {
      url: 'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      opt: { attribution: '&copy; OpenStreetMap, HOT', maxZoom: 20 },
    },
  };

  /* ── Severity color map ── */
  const SEVERITY_COLORS = { 1: '#ef4444', 2: '#f97316', 3: '#34d399' };
  const SEVERITY_LABELS = { 1: 'Critical', 2: 'Moderate', 3: 'Low' };
  const SEVERITY_RADIUS = { 1: 8, 2: 6, 3: 5 };

  /* ── Incident icons ── */
  const INCIDENT_ICONS = { accident: '🚗', congestion: '🚦', roadwork: '🚧', hazard: '⚠️', closure: '🚫' };

  /* ── State ── */
  let map = null;
  const tileLayers = {};
  let heatLayer = null;
  let traumaLayer = null;
  let pinLayer = null;
  let markerLayer = null;
  let clusterGroup = null;
  let locationMarker = null;
  let locationAccuracy = null;
  let incidentLayer = null;
  let userPins = [];
  let reportMode = false;
  let clusterVisible = false;
  let markersVisible = true;
  let allPoints = [];
  let selectedReportLatLng = null;
  let reportDraftMarker = null;

  /* ── Helpers ── */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const setText = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
  const show = (id) => { const n = document.getElementById(id); if (n) n.classList.remove('is-hidden'); };
  const hide = (id) => { const n = document.getElementById(id); if (n) n.classList.add('is-hidden'); };
  const formatNum = (v) => new Intl.NumberFormat('en-IN').format(v);
  const reportSeverityToPoint = { high: 1, medium: 2, low: 3 };
  const allowedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

  function haversine([lat1, lon1], [lat2, lon2]) {
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  /* ── Create severity divIcon ── */
  function severityIcon(severity) {
    const size = SEVERITY_RADIUS[severity] * 2 || 12;
    return L.divIcon({
      className: '',
      html: `<div class="severity-marker severity-${severity}" style="width:${size}px;height:${size}px;"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  /* ── Create incident divIcon ── */
  function incidentIcon(type) {
    return L.divIcon({
      className: '',
      html: `<div class="incident-marker incident-${type}" style="width:28px;height:28px;">${INCIDENT_ICONS[type] || '📍'}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  }

  /* ── Build popup content ── */
  function buildSeverityPopup(point) {
    const color = SEVERITY_COLORS[point.severity] || '#888';
    const label = SEVERITY_LABELS[point.severity] || 'Unknown';
    return `
      <div style="min-width:180px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="width:12px;height:12px;border-radius:50%;background:${color};display:inline-block"></span>
          <strong>${label} severity</strong>
        </div>
        <div style="font-size:0.82rem;color:var(--muted)">
          <div>Lat: ${point.lat.toFixed(5)}</div>
          <div>Lng: ${point.lng.toFixed(5)}</div>
          <div>Intensity: ${(point.intensity * 100).toFixed(0)}%</div>
        </div>
      </div>
    `;
  }

  /* ── Map theme switching ── */
  function setTheme(key) {
    if (!map || !tileLayers[key]) return;
    Object.values(tileLayers).forEach((l) => map.removeLayer(l));
    tileLayers[key].addTo(map);
    $$('[data-map-theme]').forEach((b) => b.classList.toggle('active', b.dataset.mapTheme === key));
  }

  /* ── Update distance tool ── */
  function updateDistance() {
    const el = document.getElementById('map-distance');
    const co = document.getElementById('map-coordinates');
    if (!el || !co) return;
    co.innerHTML = userPins.map((p, i) => `<div>P${i + 1}: ${p[0].toFixed(5)}, ${p[1].toFixed(5)}</div>`).join('') || 'Click anywhere on the map to mark a point.';
    if (userPins.length === 2) {
      const km = haversine(userPins[0], userPins[1]);
      el.textContent = `${km.toFixed(2)} km between selected points`;
    } else {
      el.textContent = 'Select two points to calculate distance.';
    }
  }

  /* ── Add pin ── */
  function addPin(latlng, label) {
    if (!pinLayer) return;
    const marker = L.marker(latlng, { riseOnHover: true })
      .bindPopup(`<strong>${label}</strong><br>${latlng[0].toFixed(5)}, ${latlng[1].toFixed(5)}`);
    pinLayer.addLayer(marker);
    userPins.push(latlng);
    if (userPins.length > 2) {
      userPins.shift();
      const markers = pinLayer.getLayers();
      if (markers.length > 2) pinLayer.removeLayer(markers[0]);
    }
    setText('marker-count', String(pinLayer.getLayers().length));
    updateDistance();
  }

  function setReportStatus(message, isError = false) {
    const node = document.getElementById('report-status');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('error', isError);
  }

  function validateReportPayload() {
    const title = document.getElementById('report-title')?.value.trim() || '';
    const description = document.getElementById('report-description')?.value.trim() || '';
    const files = Array.from(document.getElementById('report-photo')?.files || []);
    if (!selectedReportLatLng) return { error: 'Pick the report location on the map first.' };
    if (!/^[\w\s.,'()-]{6,90}$/.test(title)) return { error: 'Use a clear title between 6 and 90 characters.' };
    if (description.length < 20 || description.length > 900 || /<[^>]+>/.test(description)) {
      return { error: 'Use a plain-text description between 20 and 900 characters.' };
    }
    if (files.length > 4) return { error: 'Upload up to 4 photos.' };
    for (const file of files) {
      if (!allowedPhotoTypes.has(file.type)) return { error: 'Photos must be JPEG, PNG, or WebP.' };
      if (file.size > 5 * 1024 * 1024) return { error: 'Each photo must be 5 MB or smaller.' };
    }
    return {
      payload: {
        title,
        description,
        category: document.getElementById('incident-type')?.value || 'hazard',
        severity: document.getElementById('incident-severity')?.value || 'medium',
        lat: selectedReportLatLng.lat,
        lng: selectedReportLatLng.lng,
      },
      files,
    };
  }

  function selectReportLocation(latlng) {
    selectedReportLatLng = latlng;
    if (reportDraftMarker) map.removeLayer(reportDraftMarker);
    reportDraftMarker = L.marker([latlng.lat, latlng.lng], { icon: incidentIcon('hazard') })
      .bindPopup(`Report location<br>${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`)
      .addTo(map);
    reportDraftMarker.openPopup();
    setReportStatus('Location selected. Complete the report and submit.');
    const btn = document.getElementById('report-incident');
    if (btn) {
      btn.textContent = 'Pick location on map';
      btn.style.borderColor = '';
    }
  }

  async function submitZoneReport(event) {
    event.preventDefault();
    const auth = window.RoadZenAuth;
    if (!auth) {
      setReportStatus('Authentication is not loaded yet.', true);
      return;
    }
    const session = await auth.getSession();
    if (!session) {
      setReportStatus('Sign in before submitting a report with photos.', true);
      window.location.href = '/auth';
      return;
    }
    const checked = validateReportPayload();
    if (checked.error) {
      setReportStatus(checked.error, true);
      return;
    }

    setReportStatus('Submitting report...');
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await auth.authHeaders()),
        },
        body: JSON.stringify(checked.payload),
      });
      if (!response.ok) throw new Error((await response.json()).detail || 'Report submission failed.');
      const created = await response.json();

      const photoPaths = [];
      for (const file of checked.files) {
        setReportStatus(`Uploading ${file.name}...`);
        photoPaths.push(await auth.uploadReportPhoto(created.id, file));
      }
      if (photoPaths.length) {
        const attach = await fetch(`/api/reports/${created.id}/photos`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(await auth.authHeaders()),
          },
          body: JSON.stringify({ paths: photoPaths }),
        });
        if (!attach.ok) throw new Error((await attach.json()).detail || 'Photo registration failed.');
      }

      setReportStatus('Report submitted. It now contributes to aggregate heat while details wait for review.');
      document.getElementById('zone-report-form')?.reset();
      selectedReportLatLng = null;
    } catch (error) {
      setReportStatus(error.message || 'Report could not be submitted.', true);
    }
  }

  /* ── Update zoom info ── */
  function updateZoomInfo() {
    if (!map) return;
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const visible = allPoints.filter((p) => bounds.contains([p.lat, p.lng])).length;
    setText('zoom-info', `Zoom: ${zoom} · Points visible: ${formatNum(visible)} / ${formatNum(allPoints.length)}`);
  }

  /* ── Location tracking ── */
  function locateUser() {
    if (!navigator.geolocation || !map) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const latlng = [latitude, longitude];

        if (locationMarker) map.removeLayer(locationMarker);
        if (locationAccuracy) map.removeLayer(locationAccuracy);

        // Accuracy circle
        locationAccuracy = L.circle(latlng, {
          radius: Math.min(accuracy, 5000),
          className: 'location-pulse',
          fillOpacity: 0.15,
          stroke: true,
          weight: 1,
          color: 'rgba(59,130,246,0.4)',
        }).addTo(map);

        // Location dot
        locationMarker = L.marker(latlng, {
          icon: L.divIcon({
            className: '',
            html: '<div class="location-dot" style="width:16px;height:16px"></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
          zIndexOffset: 1000,
        })
          .bindPopup(`<strong>You are here</strong><br>${latitude.toFixed(5)}, ${longitude.toFixed(5)}<br>Accuracy: ±${Math.round(accuracy)}m`)
          .addTo(map);

        map.setView(latlng, Math.max(map.getZoom(), 10), { animate: true });
        locationMarker.openPopup();
      },
      () => { /* permission denied */ },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  /* ── Search / Geocoding (Nominatim) ── */
  let searchTimeout = null;
  function initSearch() {
    const input = document.getElementById('location-search');
    const results = document.getElementById('search-results');
    const btn = document.getElementById('search-btn');
    if (!input || !results) return;

    const doSearch = async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=1`, {
          headers: { 'Accept-Language': 'en' },
        });
        const data = await res.json();
        results.innerHTML = data.map((item) => `
          <div class="search-result-item" data-lat="${item.lat}" data-lon="${item.lon}" data-name="${item.display_name}">
            <div class="search-result-name">${item.display_name.split(',').slice(0, 2).join(',')}</div>
            <div class="search-result-detail">${item.display_name}</div>
          </div>
        `).join('');
      } catch (_) {
        results.innerHTML = '<div class="search-result-item">Search failed. Try again.</div>';
      }
    };

    input.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(doSearch, 400);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimeout); doSearch(); } });
    if (btn) btn.addEventListener('click', () => { clearTimeout(searchTimeout); doSearch(); });

    results.addEventListener('click', (e) => {
      const item = e.target.closest('.search-result-item');
      if (!item || !map) return;
      const lat = parseFloat(item.dataset.lat);
      const lon = parseFloat(item.dataset.lon);
      const name = item.dataset.name || 'Location';
      map.setView([lat, lon], 14, { animate: true });
      addPin([lat, lon], name.split(',').slice(0, 2).join(','));
      results.innerHTML = '';
      input.value = '';
    });
  }

  /* ── Main init ── */
  async function initHeatmapEngine() {
    try {
      const [points, centers, reportSignals] = await Promise.all([
        fetch('/api/heatmap').then((r) => { if (!r.ok) throw new Error('Failed'); return r.json(); }),
        fetch('/api/trauma-centers').then((r) => { if (!r.ok) throw new Error('Failed'); return r.json(); }),
        fetch('/api/reports/aggregate').then((r) => r.ok ? r.json() : []).catch(() => []),
      ]);

      const reportPoints = reportSignals.map((report) => ({
        lat: report.lat,
        lng: report.lng,
        severity: reportSeverityToPoint[report.severity] || 2,
        intensity: report.intensity || 0.5,
      }));
      allPoints = points.concat(reportPoints);

      // CRITICAL: Show the container BEFORE creating the map so #map has non-zero dimensions.
      // The heat layer canvas requires a sized container to call getImageData().
      hide('heatmap-skeleton');
      show('heatmap-live');

      // Create map
      map = L.map('map', {
        zoomControl: false,
        preferCanvas: true,
        attributionControl: true,
        zoomSnap: 0.5,
        zoomDelta: 0.5,
        wheelDebounceTime: 80,
      }).setView([22.6, 79.2], 5);

      // Force layout recalculation so the map container has correct pixel dimensions
      map.invalidateSize({ animate: false });

      L.control.zoom({ position: 'bottomright' }).addTo(map);
      L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

      // Build tile layers
      Object.entries(THEMES).forEach(([key, cfg]) => {
        tileLayers[key] = L.tileLayer(cfg.url, cfg.opt);
      });

      // Set initial theme
      const bodyTheme = document.body.dataset.theme || 'dark';
      setTheme(bodyTheme === 'light' ? 'light' : 'dark');

      // ── Heat layer (deferred to ensure canvas is sized) ──
      const heatPoints = allPoints.map((p) => [p.lat, p.lng, p.intensity || 0.5]);
      heatLayer = L.heatLayer(heatPoints, {
        radius: 24,
        blur: 30,
        maxZoom: 12,
        max: 1.0,
        minOpacity: 0.35,
        gradient: {
          0.0: '#064e3b',
          0.15: '#34d399',
          0.3: '#fbbf24',
          0.5: '#f97316',
          0.7: '#ef4444',
          0.85: '#dc2626',
          1.0: '#7f1d1d',
        },
      });
      // Add after a microtask so the browser has rendered the container at full size
      requestAnimationFrame(() => {
        map.invalidateSize({ animate: false });
        heatLayer.addTo(map);
      });

      // ── Severity marker layer ──
      markerLayer = L.layerGroup();
      allPoints.forEach((p) => {
        const m = L.marker([p.lat, p.lng], { icon: severityIcon(p.severity), riseOnHover: true })
          .bindPopup(buildSeverityPopup(p));
        markerLayer.addLayer(m);
      });
      markerLayer.addTo(map);

      // ── Cluster group (off by default) ──
      clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        disableClusteringAtZoom: 14,
      });
      allPoints.forEach((p) => {
        const m = L.marker([p.lat, p.lng], { icon: severityIcon(p.severity), riseOnHover: true })
          .bindPopup(buildSeverityPopup(p));
        clusterGroup.addLayer(m);
      });

      // ── Trauma centers ──
      traumaLayer = L.layerGroup(
        centers.map((c) =>
          L.circleMarker([c.lat, c.lng], {
            radius: 7,
            fillColor: '#ffffff',
            color: '#0f172a',
            weight: 2.5,
            fillOpacity: 0.95,
          }).bindPopup(`
            <div style="min-width:160px">
              <strong>${c.name}</strong>
              <div style="font-size:0.82rem;color:var(--muted);margin-top:4px">
                ${c.city} · ${c.type}
              </div>
            </div>
          `)
        )
      ).addTo(map);

      // ── User pin layer ──
      pinLayer = L.layerGroup().addTo(map);

      // ── Incident layer ──
      incidentLayer = L.layerGroup().addTo(map);

      // ── Map click → pin ──
      map.on('click', (e) => {
        if (reportMode) {
          selectReportLocation(e.latlng);
          reportMode = false;
          return;
        }
        addPin([e.latlng.lat, e.latlng.lng], 'Selected point');
      });

      // ── Right-click → labeled marker ──
      map.on('contextmenu', (e) => {
        const label = prompt('Enter marker label:');
        if (label) addPin([e.latlng.lat, e.latlng.lng], label);
      });

      // ── Zoom & move ──
      map.on('zoomend moveend', updateZoomInfo);

      // ── Fit to data bounds ──
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.12));

      // ── Populate stats ──
      setText('heat-count', formatNum(points.length));
      setText('center-count', formatNum(centers.length));
      updateDistance();
      updateZoomInfo();

      // ── Show live map ──
      hide('heatmap-skeleton');
      show('heatmap-live');

      // ── Wire toolbar buttons ──
      document.addEventListener('click', (e) => {
        const themeBtn = e.target.closest('[data-map-theme]');
        if (themeBtn) {
          setTheme(themeBtn.dataset.mapTheme);
          return;
        }

        const toggle = e.target.closest('[data-map-toggle]');
        if (!toggle) return;
        const type = toggle.dataset.mapToggle;

        if (type === 'heat') {
          const on = map.hasLayer(heatLayer);
          if (on) map.removeLayer(heatLayer); else map.addLayer(heatLayer);
          toggle.classList.toggle('active', !on);
        }

        if (type === 'markers') {
          if (clusterVisible) {
            // when cluster is on, toggle cluster instead
            const on = map.hasLayer(clusterGroup);
            if (on) map.removeLayer(clusterGroup); else map.addLayer(clusterGroup);
            toggle.classList.toggle('active', !on);
            markersVisible = !on;
          } else {
            const on = map.hasLayer(markerLayer);
            if (on) map.removeLayer(markerLayer); else map.addLayer(markerLayer);
            toggle.classList.toggle('active', !on);
            markersVisible = !on;
          }
        }

        if (type === 'trauma') {
          const on = map.hasLayer(traumaLayer);
          if (on) map.removeLayer(traumaLayer); else map.addLayer(traumaLayer);
          toggle.classList.toggle('active', !on);
        }

        if (type === 'cluster') {
          clusterVisible = !clusterVisible;
          if (clusterVisible) {
            map.removeLayer(markerLayer);
            map.addLayer(clusterGroup);
          } else {
            map.removeLayer(clusterGroup);
            if (markersVisible) map.addLayer(markerLayer);
          }
          toggle.classList.toggle('active', clusterVisible);
          // Sync the markers button state
          const markersBtn = document.querySelector('[data-map-toggle="markers"]');
          if (markersBtn) markersBtn.classList.toggle('active', clusterVisible || markersVisible);
        }

        if (type === 'reset') {
          userPins = [];
          pinLayer.clearLayers();
          incidentLayer.clearLayers();
          setText('marker-count', '0');
          updateDistance();
          if (bounds.isValid()) map.fitBounds(bounds.pad(0.12));
        }
      });

      // ── Locate me button ──
      const locateBtn = document.getElementById('locate-me');
      if (locateBtn) locateBtn.addEventListener('click', locateUser);

      // ── Report incident ──
      const reportBtn = document.getElementById('report-incident');
      if (reportBtn) {
        reportBtn.addEventListener('click', () => {
          reportMode = true;
          reportBtn.textContent = 'Click map to place';
          reportBtn.style.borderColor = 'rgba(239,68,68,0.6)';
          setReportStatus('Click the exact accident-prone zone on the map.');
          setTimeout(() => {
            reportBtn.textContent = 'Pick location on map';
            reportBtn.style.borderColor = '';
          }, 8000);
        });
      }

      document.getElementById('zone-report-form')?.addEventListener('submit', submitZoneReport);

      window.RoadZenAuth?.subscribe((authState) => {
        if (!authState.enabled) {
          setReportStatus('Supabase is not configured yet.', true);
          return;
        }
        if (authState.user) {
          setReportStatus('Signed in. Pick a location, add details, and submit.');
          return;
        }
        setReportStatus('Sign in to submit reports with photos.');
      });

      // ── Init search ──
      initSearch();

      // ── Auto-locate ──
      setTimeout(locateUser, 1200);

      // ── Sync with appState (for theme toggle in roadzen.js) ──
      if (window.appState) {
        window.appState.map = map;
        window.appState.heatLayer = heatLayer;
        window.appState.traumaLayer = traumaLayer;
        window.appState.pinLayer = pinLayer;
        window.appState.mapLayers = tileLayers;
      }

    } catch (err) {
      console.error('Heatmap init error:', err);
      setText('heatmap-error', `Heatmap data could not be loaded. ${err.message || ''}`);
      show('heatmap-error');
    }
  }

  /* ── Drop incident marker ── */
  function dropIncident(latlng) {
    const type = document.getElementById('incident-type')?.value || 'accident';
    const severity = document.getElementById('incident-severity')?.value || 'medium';
    const severityColor = { low: '#34d399', medium: '#f59e0b', high: '#ef4444' };
    const marker = L.marker([latlng.lat, latlng.lng], { icon: incidentIcon(type) })
      .bindPopup(`
        <div style="min-width:160px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-size:18px">${INCIDENT_ICONS[type]}</span>
            <strong>${type.charAt(0).toUpperCase() + type.slice(1)}</strong>
          </div>
          <div style="font-size:0.82rem;color:var(--muted)">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${severityColor[severity]};margin-right:6px"></span>
            ${severity.charAt(0).toUpperCase() + severity.slice(1)} severity
          </div>
          <div style="font-size:0.78rem;color:var(--muted);margin-top:4px">
            ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}
          </div>
        </div>
      `)
      .addTo(incidentLayer);
    marker.openPopup();
    setText('marker-count', String(pinLayer.getLayers().length + incidentLayer.getLayers().length));

      const btn = document.getElementById('report-incident');
      if (btn) {
      btn.textContent = 'Pick location on map';
      btn.style.borderColor = '';
    }
  }

  // ── Boot ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHeatmapEngine);
  } else {
    initHeatmapEngine();
  }
})();
