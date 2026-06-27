// RadioPlay - Client App Controller

const API_BASE = window.location.origin + '/api';
let jwtToken = localStorage.getItem('jwt');
let currentUser = null;
let currentView = 'studio';

// State variables for list/folders navigation
let tracksList = [];
let categoriesList = [];
let activeFolderId = null; // null = "All Tracks"
let sortField = 'title';
let sortOrder = 'asc';

// Chart instances
let chartHours = null;
let chartGeo = null;

// Audio preview element
let previewAudio = null;

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  setupNavigation();
  setupForms();
  setupUploadModal();
  setupTrackDrawer();
  setupAudioPlayer();

  // Poll now playing every 4 seconds
  setInterval(pollNowPlaying, 4000);
});

// === AUTHENTICATION & INITIALIZATION ===
function initAuth() {
  const loginContainer = document.getElementById('login-container');
  const appLayout = document.getElementById('app-layout');

  if (jwtToken) {
    // Verify token
    fetch(`${API_BASE}/auth/me`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    })
    .then(res => {
      if (!res.ok) throw new Error('Session expired');
      return res.json();
    })
    .then(data => {
      currentUser = data.user;
      loginContainer.style.display = 'none';
      appLayout.style.display = 'grid';
      bootApp();
    })
    .catch(() => {
      logout();
    });
  } else {
    loginContainer.style.display = 'flex';
    appLayout.style.display = 'none';
  }
}

function bootApp() {
  loadThemeSettings();
  pollNowPlaying();
  loadLibraryFolders();
  loadLibraryTracks();
  loadAnalytics();
}

function logout() {
  localStorage.removeItem('jwt');
  jwtToken = null;
  currentUser = null;
  window.location.reload();
}

// === API HELPERS ===
function apiFetch(endpoint, options = {}) {
  const headers = {
    'Authorization': `Bearer ${jwtToken}`,
    ...options.headers
  };
  
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  return fetch(`${API_BASE}${endpoint}`, { ...options, headers })
    .then(res => {
      if (res.status === 401 || res.status === 403) {
        logout();
        throw new Error('Unauthorized');
      }
      if (!res.ok) {
        return res.json().then(err => { throw new Error(err.error || 'Request failed') });
      }
      // Check if response has content
      if (res.status === 204) return null;
      return res.json();
    });
}

// === NAVIGATION & VIEWS ===
function setupNavigation() {
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetView = item.getAttribute('data-view');
      switchView(targetView);
    });
  });

  document.getElementById('btn-logout').addEventListener('click', logout);
}

function switchView(viewName) {
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('data-view') === viewName) {
      item.classList.add('active');
    }
  });

  document.querySelectorAll('.view-section').forEach(sec => {
    sec.classList.remove('active');
  });

  const targetSec = document.getElementById(`section-${viewName}`);
  if (targetSec) {
    targetSec.classList.add('active');
  }

  currentView = viewName;

  // Trigger specific reloads
  if (viewName === 'analytics') loadAnalytics();
  if (viewName === 'logs') loadLogs();
  if (viewName === 'library') {
    loadLibraryFolders();
    loadLibraryTracks();
  }
}

// === STUDIO DESK & NOW PLAYING POLLING ===
let currentTrackDuration = 0;
let currentTrackElapsed = 0;
let nowPlayingTimer = null;

function pollNowPlaying() {
  fetch(`${API_BASE}/public/now-playing`)
    .then(res => res.json())
    .then(data => {
      updateStudioDeck(data.now_playing);
      updateQueueList(data.up_next);
    })
    .catch(err => console.error('Now Playing poll error:', err));
}

function updateStudioDeck(track) {
  const deckTitle = document.getElementById('deck-title');
  const deckArtist = document.getElementById('deck-artist');
  const deckTime = document.getElementById('deck-time');
  const deckProgress = document.getElementById('deck-progress');
  const deckCover = document.getElementById('deck-cover');

  if (nowPlayingTimer) clearInterval(nowPlayingTimer);

  if (!track) {
    deckTitle.textContent = 'No Track Playing';
    deckArtist.textContent = 'Playout offline';
    deckTime.textContent = '00:00';
    deckProgress.style.width = '0%';
    deckCover.src = '/covers/default-vinyl.svg';
    return;
  }

  deckTitle.textContent = track.title;
  deckArtist.textContent = track.artist || 'Unknown Artist';
  deckCover.src = track.coverArtUrl || '/covers/default-vinyl.svg';

  currentTrackDuration = track.duration;
  currentTrackElapsed = track.elapsed;

  const updateProgressBar = () => {
    const remaining = Math.max(0, currentTrackDuration - currentTrackElapsed);
    const m = Math.floor(remaining / 60);
    const s = Math.floor(remaining % 60);
    deckTime.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    const percent = (currentTrackElapsed / currentTrackDuration) * 100;
    deckProgress.style.width = `${Math.min(100, percent)}%`;
  };

  updateProgressBar();

  // Run progress counter locally every second for smoother UI
  nowPlayingTimer = setInterval(() => {
    if (currentTrackElapsed < currentTrackDuration) {
      currentTrackElapsed++;
      updateProgressBar();
    }
  }, 1000);
}

function updateQueueList(queue) {
  const container = document.getElementById('studio-queue-list');
  container.innerHTML = '';

  if (!queue || queue.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px 0;">Queue empty. AutoDJ will select fallback items.</p>`;
    return;
  }

  queue.forEach((item, index) => {
    const itemCard = document.createElement('div');
    itemCard.className = 'folder-card';
    itemCard.style.display = 'flex';
    itemCard.style.alignItems = 'center';
    itemCard.style.gap = '12px';
    itemCard.style.padding = '10px 14px';
    itemCard.style.textAlign = 'left';
    
    // Type icon
    let icon = '🎵';
    if (item.fileType === 'AD') icon = '💰';
    if (item.fileType === 'JINGLE') icon = '🎤';

    itemCard.innerHTML = `
      <span style="font-size: 18px;">${icon}</span>
      <div style="flex: 1;">
        <div style="font-size: 13px; font-weight: 600;">${item.title}</div>
        <div style="font-size: 11px; color: var(--text-muted);">${item.artist || 'Unknown Artist'}</div>
      </div>
      <span style="font-size: 11px; color: var(--text-muted);">#${index + 1}</span>
    `;
    container.appendChild(itemCard);
  });
}

// Skip Action
document.getElementById('btn-skip').addEventListener('click', () => {
  apiFetch('/tracks/skip', { method: 'POST' })
    .then(() => pollNowPlaying())
    .catch(err => alert(err.message));
});

// === MUSIC LIBRARY MANAGEMENT ===
function loadLibraryFolders() {
  apiFetch('/categories')
    .then(categories => {
      categoriesList = categories;
      renderLibraryFolders();
    })
    .catch(err => console.error('Failed loading categories:', err));
}

function renderLibraryFolders() {
  const container = document.getElementById('folder-container');
  container.innerHTML = '';

  // "All Tracks" folder
  const allCard = document.createElement('div');
  allCard.className = `folder-card ${activeFolderId === null ? 'active' : ''}`;
  allCard.innerHTML = `
    <span class="folder-icon">📁</span>
    <span class="folder-name">All Tracks</span>
    <span class="folder-count">Library Root</span>
  `;
  allCard.addEventListener('click', () => {
    activeFolderId = null;
    document.getElementById('library-sub-title').textContent = 'All Music Tracks';
    renderLibraryFolders();
    loadLibraryTracks();
  });
  container.appendChild(allCard);

  // Dynamic Category folders
  categoriesList.forEach(cat => {
    const card = document.createElement('div');
    card.className = `folder-card ${activeFolderId === cat.id ? 'active' : ''}`;
    card.innerHTML = `
      <span class="folder-icon">📁</span>
      <span class="folder-name">${cat.name}</span>
      <span class="folder-count">${cat.trackCount} items</span>
    `;
    card.addEventListener('click', () => {
      activeFolderId = cat.id;
      document.getElementById('library-sub-title').textContent = `Tracks in category: ${cat.name}`;
      renderLibraryFolders();
      loadLibraryTracks();
    });
    container.appendChild(card);
  });
}

function loadLibraryTracks() {
  let endpoint = `/tracks?sortField=${sortField}&sortOrder=${sortOrder}`;
  if (activeFolderId) {
    endpoint += `&categoryId=${activeFolderId}`;
  }
  
  const searchInput = document.getElementById('library-search').value;
  if (searchInput) {
    endpoint += `&search=${encodeURIComponent(searchInput)}`;
  }

  apiFetch(endpoint)
    .then(data => {
      tracksList = data.tracks;
      renderLibraryTracks();
    })
    .catch(err => console.error('Failed loading tracks:', err));
}

function renderLibraryTracks() {
  const tbody = document.getElementById('library-table-body');
  tbody.innerHTML = '';

  if (tracksList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 40px 0;">No tracks found in this category.</td></tr>`;
    return;
  }

  tracksList.forEach(track => {
    const tr = document.createElement('tr');
    
    const minutes = Math.floor(track.duration / 60);
    const seconds = Math.floor(track.duration % 60);
    const durationStr = `${minutes}:${String(seconds).padStart(2, '0')}`;
    const dateStr = new Date(track.createdAt).toLocaleDateString();

    let typeLabel = 'Song';
    if (track.fileType === 'AD') typeLabel = 'Ad';
    if (track.fileType === 'JINGLE') typeLabel = 'Jingle';
    if (track.fileType === 'STATION_ID') typeLabel = 'Station ID';

    tr.innerHTML = `
      <td>💿</td>
      <td style="font-weight: 600;">${track.title}</td>
      <td>${track.artist || 'Unknown Artist'}</td>
      <td>${durationStr}</td>
      <td><span style="background: rgba(255,255,255,0.06); padding: 4px 8px; border-radius: 4px; font-size: 11px;">${typeLabel}</span></td>
      <td>${dateStr}</td>
      <td>
        <button class="control-btn btn-edit-track" data-id="${track.id}" style="font-size: 14px; margin-right: 10px;">✏️</button>
        <button class="control-btn btn-delete-track" data-id="${track.id}" style="font-size: 14px; color: #ff5252;">🗑️</button>
      </td>
    `;

    // Wire up event listeners
    tr.querySelector('.btn-edit-track').addEventListener('click', () => openEditDrawer(track));
    tr.querySelector('.btn-delete-track').addEventListener('click', () => deleteTrack(track.id));

    tbody.appendChild(tr);
  });
}

// Table Sorting
document.querySelectorAll('.library-table th[data-field]').forEach(th => {
  th.addEventListener('click', () => {
    const field = th.getAttribute('data-field');
    if (sortField === field) {
      sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      sortField = field;
      sortOrder = 'asc';
    }
    loadLibraryTracks();
  });
});

// Search input
document.getElementById('library-search').addEventListener('input', () => {
  loadLibraryTracks();
});

// Delete Track
function deleteTrack(id) {
  if (confirm('Are you sure you want to delete this track?')) {
    apiFetch(`/tracks/${id}`, { method: 'DELETE' })
      .then(() => {
        loadLibraryTracks();
        loadLibraryFolders();
      })
      .catch(err => alert(err.message));
  }
}

// === TRACK EDIT DRAWER OVERRIDES ===
function setupTrackDrawer() {
  const drawer = document.getElementById('edit-drawer');
  const closeBtn = document.getElementById('btn-close-drawer');
  const form = document.getElementById('drawer-form');
  const coverImg = document.getElementById('drawer-cover');
  const coverInput = document.getElementById('cover-file-input');

  closeBtn.addEventListener('click', () => drawer.classList.remove('open'));

  // Trigger hidden file input on cover art click
  coverImg.addEventListener('click', () => coverInput.click());

  // Upload Cover art image on select
  coverInput.addEventListener('change', () => {
    const trackId = document.getElementById('drawer-track-id').value;
    if (!coverInput.files[0] || !trackId) return;

    const formData = new FormData();
    formData.append('cover', coverInput.files[0]);

    apiFetch(`/tracks/${trackId}/cover`, {
      method: 'PUT',
      body: formData
    })
    .then(data => {
      coverImg.src = data.coverArtUrl + '?t=' + Date.now(); // cache buster
      pollNowPlaying();
    })
    .catch(err => alert(err.message));
  });

  // Save changes form
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('drawer-track-id').value;
    
    const body = {
      title: document.getElementById('drawer-input-title').value,
      artist: document.getElementById('drawer-input-artist').value,
      album: document.getElementById('drawer-input-album').value,
      fileType: document.getElementById('drawer-select-type').value,
      cueStart: document.getElementById('drawer-cue-start').value,
      cueEnd: document.getElementById('drawer-cue-end').value,
      volumeTrim: document.getElementById('drawer-vol-trim').value,
      fadeDuration: document.getElementById('drawer-fade-duration').value || null
    };

    apiFetch(`/tracks/${id}`, {
      method: 'PATCH',
      body
    })
    .then(() => {
      drawer.classList.remove('open');
      loadLibraryTracks();
    })
    .catch(err => alert(err.message));
  });
}

function openEditDrawer(track) {
  const drawer = document.getElementById('edit-drawer');
  
  document.getElementById('drawer-track-id').value = track.id;
  document.getElementById('drawer-input-title').value = track.title;
  document.getElementById('drawer-input-artist').value = track.artist || '';
  document.getElementById('drawer-input-album').value = track.album || '';
  document.getElementById('drawer-select-type').value = track.fileType;
  
  document.getElementById('drawer-cue-start').value = track.cueStart || 0.0;
  document.getElementById('drawer-cue-end').value = track.cueEnd || track.duration;
  document.getElementById('drawer-vol-trim').value = track.volumeTrim || 1.0;
  document.getElementById('drawer-fade-duration').value = track.fadeDuration !== null ? track.fadeDuration : '';

  document.getElementById('drawer-cover').src = `/covers/${track.fileHash}.jpg` || '/covers/default-vinyl.svg';

  drawer.classList.add('open');
}

// === BULK UPLOAD MODAL & DROPZONE ===
function setupUploadModal() {
  const modal = document.getElementById('upload-modal');
  const triggerBtn = document.getElementById('btn-trigger-upload');
  const closeBtn = document.getElementById('btn-close-upload');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('bulk-file-input');

  triggerBtn.addEventListener('click', () => {
    modal.style.display = 'flex';
  });

  closeBtn.addEventListener('click', () => {
    modal.style.display = 'none';
    document.getElementById('upload-status-area').style.display = 'none';
    loadLibraryTracks();
    loadLibraryFolders();
  });

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.background = 'rgba(255,255,255,0.08)';
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.style.background = 'none';
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.background = 'none';
    const files = e.dataTransfer.files;
    if (files.length > 0) handleBulkUpload(files);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleBulkUpload(fileInput.files);
  });
}

function handleBulkUpload(files) {
  const statusArea = document.getElementById('upload-status-area');
  const progressBar = document.getElementById('upload-progress-bar');
  const progressText = document.getElementById('upload-progress-text');

  statusArea.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = `Processing 0 / ${files.length} files...`;

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('audio', files[i]);
  }

  // Upload to bulk endpoint
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/tracks/bulk`);
  xhr.setRequestHeader('Authorization', `Bearer ${jwtToken}`);

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const percent = (e.loaded / e.total) * 100;
      progressBar.style.width = `${percent}%`;
      progressText.textContent = `Uploading files: ${Math.round(percent)}% completed`;
    }
  });

  xhr.addEventListener('load', () => {
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      progressText.textContent = `Completed! ${data.results.success.length} imported, ${data.results.skipped.length} duplicates skipped.`;
      progressBar.style.width = '100%';
    } else {
      progressText.textContent = 'Upload failed.';
    }
  });

  xhr.send(formData);
}

// Helper to convert hex colors to RGBA with dynamic opacity for glows
const hexToRgbA = (hex, alpha) => {
  let c;
  if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)){
    c= hex.substring(1).split('');
    if(c.length== 3){
      c= [c[0], c[0], c[1], c[1], c[2], c[2]];
    }
    c= '0x' + c.join('');
    return 'rgba('+[(c>>16)&255, (c>>8)&255, c&255].join(',')+','+alpha+')';
  }
  return hex;
};

// === SETTINGS & THEME CUSTOMIZATION ===
function loadThemeSettings() {
  fetch(`${API_BASE}/settings`, {
    headers: { 'Authorization': `Bearer ${jwtToken}` }
  })
  .then(res => res.json())
  .then(data => {
    // Apply layout variables and glows dynamically
    const primaryGlow = hexToRgbA(data.theme.primary, 0.35);
    const secondaryGlow = hexToRgbA(data.theme.secondary, 0.35);
    
    document.documentElement.style.setProperty('--primary-color', data.theme.primary);
    document.documentElement.style.setProperty('--secondary-color', data.theme.secondary);
    document.documentElement.style.setProperty('--primary-glow', primaryGlow);
    document.documentElement.style.setProperty('--secondary-glow', secondaryGlow);
    
    document.getElementById('station-logo').src = data.theme.logoUrl;
    document.getElementById('station-name').textContent = data.station_info.name;

    // Fill settings form values
    document.getElementById('settings-station-name').value = data.station_info.name;
    document.getElementById('settings-color-primary').value = data.theme.primary;
    document.getElementById('settings-color-secondary').value = data.theme.secondary;
  });
}

function setupForms() {
  // Login form submission
  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    .then(res => {
      if (!res.ok) throw new Error('Invalid login credentials');
      return res.json();
    })
    .then(data => {
      localStorage.setItem('jwt', data.token);
      window.location.reload();
    })
    .catch(err => {
      const errorDiv = document.getElementById('login-error');
      errorDiv.textContent = err.message;
      errorDiv.style.display = 'block';
    });
  });

  // Theme settings form submission
  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const primary = document.getElementById('settings-color-primary').value;
    const secondary = document.getElementById('settings-color-secondary').value;
    const name = document.getElementById('settings-station-name').value;

    // Save Theme settings
    apiFetch('/settings', {
      method: 'POST',
      body: {
        key: 'theme',
        value: { primary, secondary, logoUrl: document.getElementById('station-logo').src }
      }
    })
    .then(() => {
      // Save Station Info settings
      return apiFetch('/settings', {
        method: 'POST',
        body: {
          key: 'station_info',
          value: { name }
        }
      });
    })
    .then(() => {
      loadThemeSettings();
      alert('Branding settings saved and applied!');
    })
    .catch(err => alert(err.message));
  });

  // Logo upload form submission
  document.getElementById('logo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('logo-file');
    if (!fileInput.files[0]) return;

    const formData = new FormData();
    formData.append('logo', fileInput.files[0]);

    apiFetch('/settings/logo', {
      method: 'POST',
      body: formData
    })
    .then(data => {
      document.getElementById('station-logo').src = data.logoUrl;
      alert('Logo uploaded and applied!');
    })
    .catch(err => alert(err.message));
  });
}

// === ANALYTICS VIEW POPULATION ===
function loadAnalytics() {
  apiFetch('/analytics/dashboard')
    .then(data => {
      document.getElementById('stats-active').textContent = data.activeListeners;
      document.getElementById('stats-plays').textContent = data.playsToday;
      document.getElementById('stats-tlh').textContent = data.monthlyListeningHours + ' hrs';
      document.getElementById('stats-campaigns').textContent = data.activeCampaigns;
    })
    .catch(err => console.error('Failed loading analytics:', err));

  apiFetch('/analytics/listeners')
    .then(data => {
      // 1. Render Listener Geo Doughnut Chart
      const ctxGeo = document.getElementById('chart-geo-countries').getContext('2d');
      if (chartGeo) chartGeo.destroy();

      const labels = data.countries.map(c => c.country);
      const counts = data.countries.map(c => c.count);

      const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#00f0ff';
      const secondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--secondary-color').trim() || '#7000ff';

      chartGeo = new Chart(ctxGeo, {
        type: 'doughnut',
        data: {
          labels: labels.length > 0 ? labels : ['No Data'],
          datasets: [{
            data: counts.length > 0 ? counts : [1],
            backgroundColor: [primaryColor, secondaryColor, '#ffaa00', '#55ff00', '#ff00ff'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          }
        }
      });
    })
    .catch(err => console.error('Failed loading geo analytics:', err));

  apiFetch('/analytics/tracks-performance')
    .then(data => {
      const tbody = document.getElementById('analytics-table-body');
      tbody.innerHTML = '';
      if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px 0;">No playlogs recorded yet.</td></tr>`;
        return;
      }

      // 2. Render Listener Trends Line Chart based on playlog audience levels
      const ctxHours = document.getElementById('chart-listening-hours').getContext('2d');
      if (chartHours) chartHours.destroy();

      // Pull up to last 8 plays for visual timeline
      const recentPlays = data.slice(0, 8).reverse();
      const chartLabels = recentPlays.map(p => p.title.substring(0, 10) + '...');
      const audienceLevels = recentPlays.map(p => p.listenersStart);

      const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#00f0ff';
      const primaryGlow = getComputedStyle(document.documentElement).getPropertyValue('--primary-glow').trim() || 'rgba(0, 240, 255, 0.3)';

      chartHours = new Chart(ctxHours, {
        type: 'line',
        data: {
          labels: chartLabels.length > 0 ? chartLabels : ['Slot 1', 'Slot 2', 'Slot 3'],
          datasets: [{
            label: 'Concurrent Audience',
            data: audienceLevels.length > 0 ? audienceLevels : [0, 0, 0],
            borderColor: primaryColor,
            backgroundColor: primaryGlow,
            fill: true,
            tension: 0.4,
            borderWidth: 3
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
            x: { grid: { display: false } }
          },
          plugins: {
            legend: { display: false }
          }
        }
      });

      // Populate retention table
      data.forEach(log => {
        const tr = document.createElement('tr');
        const timeStr = new Date(log.playedAt).toLocaleTimeString();
        tr.innerHTML = `
          <td style="font-weight: 600;">${log.title}</td>
          <td>${log.artist}</td>
          <td>${timeStr}</td>
          <td>${log.listenersStart}</td>
          <td>${log.listenersEnd}</td>
          <td style="color: ${log.retentionRate >= 100 ? '#55ff00' : '#ff3c3c'}">${log.retentionRate}%</td>
        `;
        tbody.appendChild(tr);
      });
    })
    .catch(err => console.error('Failed loading play retention analytics:', err));
}

// === BOTTOM WEB AUDIO PLAYER ===
function setupAudioPlayer() {
  const playBtn = document.getElementById('btn-player-play');
  const volumeSlider = document.getElementById('player-volume');
  const briefTitle = document.getElementById('player-brief-title');
  const briefArtist = document.getElementById('player-brief-artist');
  const briefCover = document.getElementById('player-brief-cover');

  // Listen to volume updates
  volumeSlider.addEventListener('input', () => {
    if (previewAudio) previewAudio.volume = volumeSlider.value;
  });

  // Play button click
  playBtn.addEventListener('click', () => {
    // If audio is currently playing, pause it
    if (previewAudio && !previewAudio.paused) {
      previewAudio.pause();
      playBtn.textContent = '▶️';
      return;
    }

    // Configure and start play
    playBtn.textContent = '⏳';
    
    // Standard stream URL on play.vawam.ca domain
    // We append cache buster to prevent browser from caching the stream buffer
    const streamUrl = `https://play.vawam.ca/stream?cb=${Date.now()}`;
    
    if (!previewAudio) {
      previewAudio = new Audio();
    }
    
    previewAudio.src = streamUrl;
    previewAudio.volume = volumeSlider.value;
    
    previewAudio.play()
      .then(() => {
        playBtn.textContent = '⏸️';
        // Poll for current playing title updates
        fetch(`${API_BASE}/public/now-playing`)
          .then(res => res.json())
          .then(data => {
            if (data.now_playing) {
              briefTitle.textContent = data.now_playing.title;
              briefArtist.textContent = data.now_playing.artist;
              briefCover.src = data.now_playing.coverArtUrl || '/covers/default-vinyl.svg';
            }
          });
      })
      .catch(err => {
        console.error('Audio play failed:', err);
        playBtn.textContent = '▶️';
        alert('Failed to connect to Icecast stream. Make sure stream is online.');
      });
  });
}

// === SYSTEM & AUDIT LOGS MANAGEMENT ===
let activeLogType = 'activity';

// Bind Logs UI Listeners
document.getElementById('select-log-type').addEventListener('change', (e) => {
  activeLogType = e.target.value;
  loadLogs();
});

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  if (confirm(`Are you sure you want to clear all ${activeLogType} logs? This action is permanent.`)) {
    const method = 'DELETE';
    const url = activeLogType === 'activity' ? '/logs/activity' : '/logs/system';
    
    apiFetch(url, { method })
      .then(() => {
        loadLogs();
        alert('Logs cleared successfully.');
      })
      .catch(err => alert(err.message));
  }
});

function loadLogs() {
  const url = activeLogType === 'activity' ? '/logs/activity' : '/logs/system';
  const header = document.getElementById('logs-table-header');
  const tbody = document.getElementById('logs-table-body');
  
  tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px 0;">Loading logs...</td></tr>`;

  // Draw appropriate table headers
  if (activeLogType === 'activity') {
    header.innerHTML = `
      <tr>
        <th>User</th>
        <th>Action</th>
        <th>Details</th>
        <th>Timestamp</th>
        <th style="width: 80px;">Action</th>
      </tr>
    `;
  } else {
    header.innerHTML = `
      <tr>
        <th style="width: 100px;">Level</th>
        <th>Message</th>
        <th>Details/Error</th>
        <th>Timestamp</th>
      </tr>
    `;
  }

  apiFetch(url)
    .then(logs => {
      tbody.innerHTML = '';
      if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px 0;">No log records found.</td></tr>`;
        return;
      }

      logs.forEach(log => {
        const tr = document.createElement('tr');
        const timeStr = new Date(log.timestamp).toLocaleString();

        if (activeLogType === 'activity') {
          tr.innerHTML = `
            <td style="font-weight: 600;">${log.email}</td>
            <td><span style="background: rgba(255,255,255,0.06); padding: 4px 8px; border-radius: 4px; font-size: 11px;">${log.action}</span></td>
            <td style="font-size: 13px; color: var(--text-muted);">${log.details || 'None'}</td>
            <td style="font-size: 13px; color: var(--text-muted);">${timeStr}</td>
            <td>
              <button class="control-btn btn-delete-log" data-id="${log.id}" style="font-size: 13px; color: #ff5252;">🗑️</button>
            </td>
          `;
          tr.querySelector('.btn-delete-log').addEventListener('click', () => deleteSingleActivityLog(log.id));
        } else {
          // Winston System Logs
          let levelColor = '#00f0ff'; // info
          if (log.level === 'error') levelColor = '#ff3c3c';
          if (log.level === 'warn') levelColor = '#ffaa00';

          let detailsStr = '';
          if (log.stack) {
            detailsStr = `<pre style="font-family: monospace; font-size: 11px; max-height: 80px; overflow-y: auto; color: #ff7b7b;">${log.stack}</pre>`;
          } else if (typeof log.message !== 'string') {
            detailsStr = `<pre style="font-family: monospace; font-size: 11px;">${JSON.stringify(log)}</pre>`;
          }

          tr.innerHTML = `
            <td><span style="color: ${levelColor}; font-weight: 600; text-transform: uppercase; font-size: 12px;">${log.level || 'info'}</span></td>
            <td style="font-size: 13px;">${log.message || 'System operation'}</td>
            <td>${detailsStr}</td>
            <td style="font-size: 13px; color: var(--text-muted);">${timeStr}</td>
          `;
        }
        tbody.appendChild(tr);
      });
    })
    .catch(err => {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #ff3c3c; padding: 20px 0;">Error: ${err.message}</td></tr>`;
    });
}

function deleteSingleActivityLog(id) {
  apiFetch(`/logs/activity/${id}`, { method: 'DELETE' })
    .then(() => {
      loadLogs();
    })
    .catch(err => alert(err.message));
}

