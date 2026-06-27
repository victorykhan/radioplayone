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

// Global Toast Notification Helper
function showNotification(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '🚨';
  if (type === 'warning') icon = '⚠️';
  
  toast.innerHTML = `
    <span>${icon}</span>
    <div style="flex: 1;">${message}</div>
    <span style="cursor: pointer; opacity: 0.5;" onclick="this.parentElement.remove()">✕</span>
  `;
  
  container.appendChild(toast);
  
  // Auto dismiss after 4 seconds
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Global Custom Confirm Modal Helper
function showConfirm(title, message, onProceed) {
  const modal = document.getElementById('confirm-modal');
  if (!modal) {
    if (confirm(message)) onProceed();
    return;
  }
  
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  
  modal.style.display = 'flex';
  
  const cancelBtn = document.getElementById('btn-confirm-cancel');
  const proceedBtn = document.getElementById('btn-confirm-proceed');
  
  const closeConfirm = () => {
    modal.style.display = 'none';
    const newCancel = cancelBtn.cloneNode(true);
    const newProceed = proceedBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    proceedBtn.parentNode.replaceChild(newProceed, proceedBtn);
  };
  
  document.getElementById('btn-confirm-cancel').addEventListener('click', closeConfirm);
  document.getElementById('btn-confirm-proceed').addEventListener('click', () => {
    onProceed();
    closeConfirm();
  });
}

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  setupNavigation();
  setupForms();
  setupUploadModal();
  setupCategoryModal();
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
  enforceRbac();
  loadThemeSettings();
  pollNowPlaying();
  loadLibraryFolders();
  loadLibraryTracks();
  loadAnalytics();
  if (currentUser && currentUser.role === 'ADMIN') {
    loadSettingsUsers();
  }
}

function enforceRbac() {
  if (!currentUser) return;
  const role = currentUser.role;

  // 1. Sidebar Nav Visibility
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    const view = item.getAttribute('data-view');
    item.style.display = 'block';

    if (role === 'PRODUCER') {
      if (view === 'settings' || view === 'system') item.style.display = 'none';
    } else if (role === 'DJ') {
      if (view === 'settings' || view === 'system' || view === 'logs' || view === 'analytics') {
        item.style.display = 'none';
      }
    } else if (role === 'VIEWER') {
      if (view === 'settings' || view === 'system' || view === 'logs' || view === 'analytics') {
        item.style.display = 'none';
      }
    }
  });

  // 2. Settings User management visibility
  const userMgmtCard = document.getElementById('settings-user-mgmt-card');
  if (userMgmtCard) {
    userMgmtCard.style.display = (role === 'ADMIN') ? 'block' : 'none';
  }

  // 3. Ext-admin link (Nginx proxy)
  const icecastAdminLink = document.querySelector('.monitor-ext-admin');
  if (icecastAdminLink) {
    icecastAdminLink.style.display = (role === 'ADMIN' || role === 'PRODUCER') ? 'inline-block' : 'none';
  }

  // 4. Playout Skip track button
  const skipBtn = document.getElementById('btn-skip');
  if (skipBtn) {
    skipBtn.style.display = (role !== 'VIEWER') ? 'flex' : 'none';
  }

  // 5. Playout Queue Add & Clear buttons
  const qAddBtn = document.getElementById('btn-queue-add');
  const qClearBtn = document.getElementById('btn-queue-clear');
  if (qAddBtn) qAddBtn.style.display = (role !== 'VIEWER') ? 'inline-block' : 'none';
  if (qClearBtn) qClearBtn.style.display = (role !== 'VIEWER') ? 'inline-block' : 'none';

  // 6. Tracks upload & category create buttons
  const uploadTrackBtn = document.getElementById('btn-upload-track');
  const createFolderBtn = document.getElementById('btn-create-folder');
  if (uploadTrackBtn) uploadTrackBtn.style.display = (role === 'ADMIN' || role === 'PRODUCER') ? 'inline-block' : 'none';
  if (createFolderBtn) createFolderBtn.style.display = (role === 'ADMIN' || role === 'PRODUCER') ? 'inline-block' : 'none';

  // 7. Playlist create button
  const createPlaylistBtn = document.getElementById('btn-create-playlist');
  if (createPlaylistBtn) createPlaylistBtn.style.display = (role === 'ADMIN' || role === 'PRODUCER') ? 'inline-block' : 'none';
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
  
  if (viewName === 'system') {
    startSystemMonitoring();
  } else {
    stopSystemMonitoring();
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
    container.innerHTML = `<p class="queue-empty-msg">Queue empty — AutoDJ will select tracks automatically.</p>`;
    return;
  }

  const isViewer = (currentUser && currentUser.role === 'VIEWER');

  queue.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.draggable = !isViewer;
    el.dataset.queueId = item.queueId;
    if (isViewer) el.style.cursor = 'default';

    // Type icon
    const icons = { SONG: '🎵', AD: '💰', JINGLE: '🎤', STATION_ID: '📻', FILLER: '🎵' };
    const icon = icons[item.fileType] || '🎵';

    // Format cue values
    const cIn  = (item.cueStart ?? 0).toFixed(1);
    const cOut = (item.cueEnd ?? item.duration ?? 0).toFixed(1);
    const dur  = item.duration ? `${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}` : '—';

    el.innerHTML = `
      <span class="queue-grip" title="Drag to reorder" style="${isViewer ? 'display:none;' : ''}">⠿</span>
      <span class="queue-pos">${index + 1}</span>
      <img class="queue-cover" src="${item.coverArtUrl || '/covers/default-vinyl.svg'}" onerror="this.src='/covers/default-vinyl.svg'" alt="">
      <div class="queue-track-meta">
        <div class="queue-track-title">${icon} ${item.title || 'Unknown'}</div>
        <div class="queue-track-artist">${item.artist || 'Unknown Artist'} · ${dur}</div>
      </div>
      <div class="queue-cue-group" title="Cue points (seconds)">
        <span class="queue-cue-label">IN</span>
        <input type="number" class="queue-cue-input cue-in" value="${cIn}" step="0.1" min="0" data-queue-id="${item.queueId}" ${isViewer ? 'disabled' : ''}>
        <span class="queue-cue-label">OUT</span>
        <input type="number" class="queue-cue-input cue-out" value="${cOut}" step="0.1" min="0" data-queue-id="${item.queueId}" ${isViewer ? 'disabled' : ''}>
      </div>
      <div class="queue-item-actions" style="${isViewer ? 'display:none;' : ''}">
        <button class="queue-item-btn clone-btn" title="Clone" data-queue-id="${item.queueId}">⧉</button>
        <button class="queue-item-btn remove-btn" title="Remove" data-queue-id="${item.queueId}">✕</button>
      </div>
    `;
    container.appendChild(el);
  });

  // ── Drag & Drop ──────────────────────────────────────────
  let dragSrcEl = null;

  container.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragSrcEl = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.dataset.queueId);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      container.querySelectorAll('.queue-item').forEach(i => i.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (item !== dragSrcEl) item.classList.add('drag-over');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (dragSrcEl === item) return;

      // Reorder DOM immediately for instant feedback
      const allItems = [...container.querySelectorAll('.queue-item')];
      const fromIdx = allItems.indexOf(dragSrcEl);
      const toIdx = allItems.indexOf(item);

      if (fromIdx < toIdx) {
        item.after(dragSrcEl);
      } else {
        item.before(dragSrcEl);
      }

      // Collect new order and send to API
      const newOrder = [...container.querySelectorAll('.queue-item')].map(i => parseInt(i.dataset.queueId));
      apiFetch('/queue/reorder', { method: 'POST', body: { order: newOrder } })
        .then(data => updateQueueList(data.queue))
        .catch(err => {
          showNotification('Failed to reorder queue: ' + err.message, 'error');
          pollNowPlaying(); // Refresh from server on error
        });
    });
  });

  // ── Clone buttons ────────────────────────────────────────
  container.querySelectorAll('.clone-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const qid = btn.dataset.queueId;
      apiFetch(`/queue/clone/${qid}`, { method: 'POST' })
        .then(data => {
          updateQueueList(data.queue);
          showNotification('Track cloned in queue', 'success');
        })
        .catch(err => showNotification(err.message, 'error'));
    });
  });

  // ── Remove buttons ───────────────────────────────────────
  container.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const qid = btn.dataset.queueId;
      apiFetch(`/queue/${qid}`, { method: 'DELETE' })
        .then(data => {
          updateQueueList(data.queue);
          showNotification('Track removed from queue', 'info');
        })
        .catch(err => showNotification(err.message, 'error'));
    });
  });

  // ── Cue point editing (debounced) ────────────────────────
  let cueDebounce = {};
  container.querySelectorAll('.queue-cue-input').forEach(input => {
    input.addEventListener('change', () => {
      const qid = input.dataset.queueId;
      const row = input.closest('.queue-item');
      const cueIn  = parseFloat(row.querySelector('.cue-in').value);
      const cueOut = parseFloat(row.querySelector('.cue-out').value);

      clearTimeout(cueDebounce[qid]);
      cueDebounce[qid] = setTimeout(() => {
        apiFetch(`/queue/${qid}/cues`, {
          method: 'PATCH',
          body: { cueStart: cueIn, cueEnd: cueOut }
        })
        .then(() => showNotification('Cue points updated', 'success'))
        .catch(err => showNotification(err.message, 'error'));
      }, 500);
    });

    // Stop drag when clicking in input
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
  });
}

// ── Skip Action (uses new queue API) ────────────────────────
document.getElementById('btn-skip').addEventListener('click', () => {
  apiFetch('/queue/skip', { method: 'POST' })
    .then(() => {
      showNotification('Skipped to next track', 'success');
      pollNowPlaying();
    })
    .catch(err => showNotification(err.message, 'error'));
});

// ── Add to Queue Modal ──────────────────────────────────────
(function initQueueAddModal() {
  const modal     = document.getElementById('queue-add-modal');
  const btnOpen   = document.getElementById('btn-queue-add');
  const btnClose  = document.getElementById('btn-queue-add-close');
  const searchIn  = document.getElementById('queue-search-input');
  const results   = document.getElementById('queue-search-results');

  if (!modal || !btnOpen) return;

  btnOpen.addEventListener('click', () => {
    modal.classList.add('open');
    searchIn.value = '';
    results.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 20px;">Type to search your music library</p>';
    setTimeout(() => searchIn.focus(), 100);
  });

  btnClose.addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

  let searchTimeout = null;
  searchIn.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchIn.value.trim();
    if (q.length < 2) {
      results.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 20px;">Type at least 2 characters to search</p>';
      return;
    }
    searchTimeout = setTimeout(() => searchLibraryForQueue(q), 300);
  });

  function searchLibraryForQueue(query) {
    apiFetch(`/tracks?search=${encodeURIComponent(query)}&limit=20&page=1`)
      .then(data => {
        const tracks = data.tracks || data;
        results.innerHTML = '';
        if (!tracks || tracks.length === 0) {
          results.innerHTML = '<p style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 20px;">No tracks found</p>';
          return;
        }
        tracks.forEach(track => {
          const dur = track.duration ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, '0')}` : '';
          const coverUrl = track.fileHash ? `/covers/${track.fileHash}.jpg` : '/covers/default-vinyl.svg';
          const row = document.createElement('div');
          row.className = 'queue-search-item';
          row.innerHTML = `
            <img class="search-cover" src="${coverUrl}" onerror="this.src='/covers/default-vinyl.svg'">
            <div class="search-meta">
              <div class="search-title">${track.title}</div>
              <div class="search-artist">${track.artist || 'Unknown'} · ${dur}</div>
            </div>
            <span class="search-add">＋ Add</span>
          `;
          row.addEventListener('click', () => {
            apiFetch('/queue/add', { method: 'POST', body: { trackId: track.id } })
              .then(data => {
                updateQueueList(data.queue);
                showNotification(`Added "${track.title}" to queue`, 'success');
              })
              .catch(err => showNotification(err.message, 'error'));
          });
          results.appendChild(row);
        });
      })
      .catch(err => {
        results.innerHTML = `<p style="color: #ff3c3c; font-size: 12px; text-align: center; padding: 20px;">Error: ${err.message}</p>`;
      });
  }
})();

// ── Clear Queue ─────────────────────────────────────────────
document.getElementById('btn-queue-clear').addEventListener('click', () => {
  showConfirm('Clear Queue', 'Remove all tracks from the playout queue? AutoDJ will take over.', () => {
    apiFetch('/queue/clear', { method: 'POST' })
      .then(() => {
        updateQueueList([]);
        showNotification('Queue cleared', 'success');
      })
      .catch(err => showNotification(err.message, 'error'));
  });
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

  const activeCat = categoriesList.find(c => c.id === activeFolderId);

  // If inside a sub-category, show "Go Up" folder card
  if (activeFolderId !== null) {
    const upCard = document.createElement('div');
    upCard.className = 'folder-card';
    upCard.innerHTML = `
      <span class="folder-icon">↩️</span>
      <span class="folder-name">Go Up</span>
      <span class="folder-count">Back to parent</span>
    `;
    upCard.addEventListener('click', () => {
      activeFolderId = activeCat ? activeCat.parentId : null;
      if (activeFolderId === null) {
        document.getElementById('library-sub-title').textContent = 'All Music Tracks';
      } else {
        const parentCat = categoriesList.find(c => c.id === activeFolderId);
        document.getElementById('library-sub-title').textContent = `Tracks in category: ${parentCat ? parentCat.name : 'Folder'}`;
      }
      renderLibraryFolders();
      loadLibraryTracks();
    });
    container.appendChild(upCard);
  } else {
    // We are at root: show "All Tracks" card
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
  }

  // Filter categories list: only show items belonging to the current activeFolderId (sub-folders)
  const subCategories = categoriesList.filter(cat => cat.parentId === activeFolderId);

  subCategories.forEach(cat => {
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

  const typeFilter = document.getElementById('library-filter-type').value;
  if (typeFilter) {
    endpoint += `&fileType=${typeFilter}`;
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
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 40px 0;">No tracks found in this category.</td></tr>`;
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

    const categoriesStr = track.categories && track.categories.length > 0
      ? track.categories.map(c => `<span style="background: var(--primary-glow); border: 1px solid var(--primary-color); padding: 2px 6px; border-radius: 4px; font-size: 10px; color: var(--text-main); margin-right: 4px; white-space: nowrap;">${c.name}</span>`).join('')
      : '<span style="color: var(--text-muted); font-size: 11px;">None</span>';

    tr.innerHTML = `
      <td class="btn-play-preview" data-id="${track.id}" style="cursor: pointer; text-align: center; font-size: 16px;">▶️</td>
      <td style="text-align: center;">
        <img src="${track.coverArtUrl || '/covers/default-vinyl.svg'}" style="width: 32px; height: 32px; border-radius: 4px; object-fit: cover; border: 1px solid rgba(255,255,255,0.08);">
      </td>
      <td style="font-weight: 600;">${track.title}</td>
      <td>${track.artist || 'Unknown Artist'}</td>
      <td><div style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 180px;">${categoriesStr}</div></td>
      <td>${durationStr}</td>
      <td><span style="background: rgba(255,255,255,0.06); padding: 4px 8px; border-radius: 4px; font-size: 11px;">${typeLabel}</span></td>
      <td>${dateStr}</td>
      <td>
        <button class="control-btn btn-edit-track" data-id="${track.id}" style="font-size: 14px; margin-right: 10px;">✏️</button>
        <button class="control-btn btn-delete-track" data-id="${track.id}" style="font-size: 14px; color: #ff5252;">🗑️</button>
      </td>
    `;

    // Click anywhere on track row to select it and open the drawer
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.control-btn') || e.target.closest('.btn-play-preview')) return;
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('selected-row'));
      tr.classList.add('selected-row');
      openEditDrawer(track);
    });

    tr.querySelector('.btn-play-preview').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTrackPreview(track.id, e.currentTarget);
    });

    tr.querySelector('.btn-edit-track').addEventListener('click', (e) => {
      e.stopPropagation();
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('selected-row'));
      tr.classList.add('selected-row');
      openEditDrawer(track);
    });
    tr.querySelector('.btn-delete-track').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTrack(track.id);
    });

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

// Format/Type filter dropdown input
document.getElementById('library-filter-type').addEventListener('change', () => {
  loadLibraryTracks();
});

// Delete Track
function deleteTrack(id) {
  showConfirm(
    'Delete Track',
    'Are you sure you want to delete this track? This action is permanent.',
    () => {
      apiFetch(`/tracks/${id}`, { method: 'DELETE' })
        .then(() => {
          loadLibraryTracks();
          loadLibraryFolders();
          showNotification('Track deleted successfully.', 'success');
        })
        .catch(err => showNotification(err.message, 'error'));
    }
  );
}

// Global track preview audio player
let previewingTrackId = null;
let previewingAudioNode = null;

function toggleTrackPreview(trackId, playBtnElement) {
  const scrubContainer = document.getElementById('drawer-preview-container');
  const scrubSlider = document.getElementById('drawer-preview-scrub');
  const timeText = document.getElementById('drawer-preview-time');
  const stateText = document.getElementById('drawer-preview-state');

  const resetScrubber = () => {
    if (scrubContainer) scrubContainer.style.display = 'none';
    if (scrubSlider) {
      scrubSlider.value = 0;
      // Remove event listeners by cloning
      const newSlider = scrubSlider.cloneNode(true);
      scrubSlider.parentNode.replaceChild(newSlider, scrubSlider);
    }
  };

  if (previewingTrackId === trackId && previewingAudioNode) {
    if (previewingAudioNode.paused) {
      previewingAudioNode.play();
      playBtnElement.textContent = '⏸️';
      if (playBtnElement.tagName === 'BUTTON') playBtnElement.innerHTML = '⏸️ Pause Track';
      if (stateText) stateText.textContent = 'Playing Preview';
    } else {
      previewingAudioNode.pause();
      playBtnElement.textContent = '▶️';
      if (playBtnElement.tagName === 'BUTTON') playBtnElement.innerHTML = '▶️ Listen Track';
      if (stateText) stateText.textContent = 'Paused';
    }
    return;
  }

  // Stop current playing preview if any
  if (previewingAudioNode) {
    previewingAudioNode.pause();
    previewingAudioNode = null;
    document.querySelectorAll('.btn-play-preview').forEach(btn => btn.textContent = '▶️');
    const drawerBtn = document.getElementById('btn-drawer-preview');
    if (drawerBtn) drawerBtn.innerHTML = '▶️ Listen Track';
    resetScrubber();
  }

  // Setup new audio preview
  previewingTrackId = trackId;
  previewingAudioNode = new Audio(`${API_BASE}/tracks/${trackId}/audio?token=${jwtToken}`);
  previewingAudioNode.volume = 0.8;

  // Setup scrubber view if elements exist
  const liveScrubber = document.getElementById('drawer-preview-scrub');
  if (scrubContainer && liveScrubber) {
    scrubContainer.style.display = 'flex';
    stateText.textContent = 'Playing Preview';
    timeText.textContent = '0:00 / 0:00';

    previewingAudioNode.addEventListener('timeupdate', () => {
      if (!previewingAudioNode) return;
      const cur = previewingAudioNode.currentTime;
      const dur = previewingAudioNode.duration || 0;
      liveScrubber.value = dur > 0 ? (cur / dur) * 100 : 0;

      const curMin = Math.floor(cur / 60);
      const curSec = Math.floor(cur % 60);
      const durMin = Math.floor(dur / 60);
      const durSec = Math.floor(dur % 60);
      timeText.textContent = `${curMin}:${String(curSec).padStart(2, '0')} / ${durMin}:${String(durSec).padStart(2, '0')}`;
    });

    liveScrubber.addEventListener('input', (e) => {
      if (previewingAudioNode && previewingAudioNode.duration) {
        previewingAudioNode.currentTime = (e.target.value / 100) * previewingAudioNode.duration;
      }
    });
  }

  previewingAudioNode.addEventListener('play', () => {
    playBtnElement.textContent = '⏸️';
    if (playBtnElement.tagName === 'BUTTON') playBtnElement.innerHTML = '⏸️ Pause Track';
    if (stateText) stateText.textContent = 'Playing Preview';
  });

  previewingAudioNode.addEventListener('pause', () => {
    playBtnElement.textContent = '▶️';
    if (playBtnElement.tagName === 'BUTTON') playBtnElement.innerHTML = '▶️ Listen Track';
    if (stateText) stateText.textContent = 'Paused';
  });

  previewingAudioNode.addEventListener('ended', () => {
    playBtnElement.textContent = '▶️';
    if (playBtnElement.tagName === 'BUTTON') playBtnElement.innerHTML = '▶️ Listen Track';
    previewingTrackId = null;
    previewingAudioNode = null;
    resetScrubber();
  });

  previewingAudioNode.play()
    .catch(err => {
      console.error('Track preview failed:', err);
      showNotification('Failed to play preview. Ensure file is valid.', 'error');
    });
}

// === TRACK EDIT DRAWER OVERRIDES ===
function setupTrackDrawer() {
  const drawer = document.getElementById('edit-drawer');
  const closeBtn = document.getElementById('btn-close-drawer');
  const form = document.getElementById('drawer-form');
  const coverImg = document.getElementById('drawer-cover');
  const coverInput = document.getElementById('cover-file-input');

  const drawerPreviewBtn = document.getElementById('btn-drawer-preview');

  closeBtn.addEventListener('click', () => {
    drawer.classList.remove('open');
    if (previewingAudioNode) {
      previewingAudioNode.pause();
      previewingAudioNode = null;
      previewingTrackId = null;
      drawerPreviewBtn.innerHTML = '▶️ Listen Track';
    }
  });

  drawerPreviewBtn.addEventListener('click', () => {
    const trackId = parseInt(document.getElementById('drawer-track-id').value);
    if (trackId) toggleTrackPreview(trackId, drawerPreviewBtn);
  });

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
    .catch(err => showNotification(err.message, 'error'));
  });

  // Save changes form
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('drawer-track-id').value;
    
    // Gather selected categories
    const checkedCategories = Array.from(document.querySelectorAll('input[name="drawer-categories"]:checked'))
      .map(input => parseInt(input.value));

    const body = {
      title: document.getElementById('drawer-input-title').value,
      artist: document.getElementById('drawer-input-artist').value,
      album: document.getElementById('drawer-input-album').value,
      fileType: document.getElementById('drawer-select-type').value,
      cueStart: document.getElementById('drawer-cue-start').value,
      cueEnd: document.getElementById('drawer-cue-end').value,
      volumeTrim: document.getElementById('drawer-vol-trim').value,
      fadeDuration: document.getElementById('drawer-fade-duration').value || null,
      categoryIds: checkedCategories
    };

    apiFetch(`/tracks/${id}`, {
      method: 'PATCH',
      body
    })
    .then(() => {
      drawer.classList.remove('open');
      loadLibraryTracks();
      showNotification('Track overrides saved successfully!', 'success');
    })
    .catch(err => showNotification(err.message, 'error'));
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

  // If custom cover art URL is available, use it; otherwise fallback
  document.getElementById('drawer-cover').src = track.coverArtUrl || `/covers/${track.fileHash}.jpg` || '/covers/default-vinyl.svg';

  // Populate category checkboxes
  const categoriesContainer = document.getElementById('drawer-categories-list');
  categoriesContainer.innerHTML = '';
  categoriesList.forEach(cat => {
    const isChecked = track.categories && track.categories.some(c => c.id === cat.id);
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.cursor = 'pointer';
    label.style.fontSize = '13px';
    label.innerHTML = `
      <input type="checkbox" name="drawer-categories" value="${cat.id}" ${isChecked ? 'checked' : ''}>
      <span>${cat.name}</span>
    `;
    categoriesContainer.appendChild(label);
  });

  drawer.classList.add('open');
}

// === CREATE CATEGORY/FOLDER MODAL ===
function setupCategoryModal() {
  const modal = document.getElementById('category-modal');
  const triggerBtn = document.getElementById('btn-create-category');
  const closeBtn = document.getElementById('btn-close-category');
  const form = document.getElementById('category-form');
  const parentSelect = document.getElementById('category-select-parent');

  triggerBtn.addEventListener('click', () => {
    // Populate parent selection list
    parentSelect.innerHTML = '<option value="">Root / None</option>';
    categoriesList.forEach(cat => {
      parentSelect.innerHTML += `<option value="${cat.id}">${cat.name}</option>`;
    });

    // Default select currently active folder as parent
    if (activeFolderId !== null) {
      parentSelect.value = activeFolderId;
    } else {
      parentSelect.value = "";
    }

    modal.style.display = 'flex';
  });

  closeBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('category-input-name').value;
    const parentId = parentSelect.value;

    apiFetch('/categories', {
      method: 'POST',
      body: {
        name,
        parentId: parentId ? parseInt(parentId) : null
      }
    })
    .then(() => {
      modal.style.display = 'none';
      document.getElementById('category-input-name').value = '';
      loadLibraryFolders();
      showNotification('Folder created successfully!', 'success');
    })
    .catch(err => showNotification(err.message, 'error'));
  });
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
      if (data.results.success.length > 0) {
        showNotification(`Successfully uploaded ${data.results.success.length} tracks.`, 'success');
      } else {
        showNotification(`Upload complete. No new tracks added (${data.results.skipped.length} duplicates skipped).`, 'warning');
      }
    } else {
      progressText.textContent = 'Upload failed.';
      showNotification('Bulk upload failed. Please try again.', 'error');
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
    const bgVal = data.theme.background || '#0d101f';
    
    document.documentElement.style.setProperty('--primary-color', data.theme.primary);
    document.documentElement.style.setProperty('--secondary-color', data.theme.secondary);
    document.documentElement.style.setProperty('--primary-glow', primaryGlow);
    document.documentElement.style.setProperty('--secondary-glow', secondaryGlow);
    
    document.documentElement.style.setProperty('--bg-dark', bgVal);
    document.documentElement.style.setProperty('--bg-main', bgVal);
    document.body.style.backgroundColor = bgVal;

    // Apply favicon
    if (data.theme.faviconUrl) {
      document.getElementById('app-favicon').href = data.theme.faviconUrl;
    }
    
    document.getElementById('station-logo').src = data.theme.logoUrl;
    document.getElementById('station-name').textContent = data.station_info.name;

    // Fill settings form values
    document.getElementById('settings-station-name').value = data.station_info.name;
    document.getElementById('settings-color-primary').value = data.theme.primary;
    document.getElementById('settings-color-secondary').value = data.theme.secondary;
    document.getElementById('settings-color-background').value = bgVal;

    // Fill SEO fields
    if (data.seo) {
      document.getElementById('settings-seo-title').value = data.seo.title || '';
      document.getElementById('settings-seo-desc').value = data.seo.metaDescription || '';
      document.getElementById('settings-og-title').value = data.seo.openGraphTitle || '';
      document.getElementById('settings-og-desc').value = data.seo.openGraphDescription || '';
    }

    // Fill Broadcast fields
    if (data.broadcast) {
      document.getElementById('settings-broadcast-host').textContent = data.broadcast.host;
      document.getElementById('settings-broadcast-port').textContent = data.broadcast.port;
      document.getElementById('settings-broadcast-mount').textContent = data.broadcast.mount;
      document.getElementById('settings-broadcast-username').textContent = data.broadcast.username;
    }
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
    const background = document.getElementById('settings-color-background').value;
    const name = document.getElementById('settings-station-name').value;
    
    const seoTitle = document.getElementById('settings-seo-title').value;
    const seoDesc = document.getElementById('settings-seo-desc').value;
    const ogTitle = document.getElementById('settings-og-title').value;
    const ogDesc = document.getElementById('settings-og-desc').value;

    // Save Theme settings
    apiFetch('/settings', {
      method: 'POST',
      body: {
        key: 'theme',
        value: { 
          primary, 
          secondary, 
          background, 
          logoUrl: document.getElementById('station-logo').src,
          faviconUrl: document.getElementById('app-favicon').getAttribute('href')
        }
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
      // Save SEO settings
      return apiFetch('/settings', {
        method: 'POST',
        body: {
          key: 'seo',
          value: {
            title: seoTitle,
            metaDescription: seoDesc,
            openGraphTitle: ogTitle,
            openGraphDescription: ogDesc,
            openGraphImageUrl: document.getElementById('station-logo').src
          }
        }
      });
    })
    .then(() => {
      loadThemeSettings();
      showNotification('Branding settings saved and applied!', 'success');
    })
    .catch(err => showNotification(err.message, 'error'));
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
      showNotification('Logo uploaded and applied!', 'success');
    })
    .catch(err => showNotification(err.message, 'error'));
  });

  // Favicon upload form submission
  document.getElementById('favicon-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('favicon-file');
    if (!fileInput.files[0]) return;

    const formData = new FormData();
    formData.append('favicon', fileInput.files[0]);

    apiFetch('/settings/favicon', {
      method: 'POST',
      body: formData
    })
    .then(data => {
      document.getElementById('app-favicon').href = data.faviconUrl;
      showNotification('Favicon uploaded successfully!', 'success');
      fileInput.value = '';
    })
    .catch(err => showNotification(err.message, 'error'));
  });

  // OG Image upload form submission
  document.getElementById('og-image-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('og-image-file');
    if (!fileInput.files[0]) return;

    const formData = new FormData();
    formData.append('ogImage', fileInput.files[0]);

    apiFetch('/settings/og-image', {
      method: 'POST',
      body: formData
    })
    .then(data => {
      showNotification('Open Graph Image uploaded successfully!', 'success');
      fileInput.value = '';
    })
    .catch(err => showNotification(err.message, 'error'));
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

// === BOTTOM WEB AUDIO PLAYER (persistent footer mini-player) ===
function setupAudioPlayer() {
  const playBtn     = document.getElementById('btn-player-play');
  const volSlider   = document.getElementById('player-volume');
  const bpTitle     = document.getElementById('bp-title');
  const bpArtist    = document.getElementById('bp-artist');
  const bpCover     = document.getElementById('bp-cover');
  const bpProgress  = document.getElementById('bp-progress');
  const bpStatusDot = document.getElementById('bp-status-dot');
  const bpCanvas    = document.getElementById('bp-vis-canvas');

  if (!playBtn) return;

  const STREAM_URL = '/stream.mp3';
  let bpAudio      = null;
  let bpPlaying    = false;
  let bpAudioCtx, bpAnalyser, bpSource, bpAnimId;

  // ── Mini canvas visualizer ───────────────────────────────────
  let bpCtx = null;
  if (bpCanvas) {
    bpCtx = bpCanvas.getContext('2d');
    function resizeBpCanvas() {
      const r = bpCanvas.parentElement.getBoundingClientRect();
      bpCanvas.width  = r.width  * (window.devicePixelRatio || 1);
      bpCanvas.height = r.height * (window.devicePixelRatio || 1);
    }
    window.addEventListener('resize', resizeBpCanvas);
    resizeBpCanvas();

    // Idle sine animation
    let bpIdleId = null;
    function drawBpIdle() {
      if (bpPlaying) return;
      const W = bpCanvas.width, H = bpCanvas.height;
      bpCtx.clearRect(0, 0, W, H);
      const count = 30, dpr = window.devicePixelRatio || 1;
      const gap = 2.5 * dpr, barW = (W - (count - 1) * gap) / count;
      const t = Date.now() / 700;
      for (let i = 0; i < count; i++) {
        const val  = (Math.sin(t + i * 0.45) * 0.5 + 0.5) * 0.2 + 0.04;
        const barH = val * H, x = i * (barW + gap), y = H - barH;
        bpCtx.fillStyle = 'rgba(255,255,255,0.05)';
        bpCtx.beginPath();
        bpCtx.roundRect(x, y, barW, barH, 1 * dpr);
        bpCtx.fill();
      }
      bpIdleId = requestAnimationFrame(drawBpIdle);
    }
    drawBpIdle();

    function drawBpLive() {
      if (!bpPlaying) return;
      bpAnimId = requestAnimationFrame(drawBpLive);
      const W = bpCanvas.width, H = bpCanvas.height;
      bpCtx.clearRect(0, 0, W, H);
      if (!bpAnalyser) return;
      const buf = new Uint8Array(bpAnalyser.frequencyBinCount);
      bpAnalyser.getByteFrequencyData(buf);
      const count = Math.min(buf.length, 30), dpr = window.devicePixelRatio || 1;
      const gap = 2.5 * dpr, barW = (W - (count - 1) * gap) / count;
      for (let i = 0; i < count; i++) {
        const val  = buf[i] / 255;
        const barH = Math.max(2 * dpr, val * H * 0.9);
        const x = i * (barW + gap), y = H - barH;
        const hue = 185 + (i / count) * 100;
        const g = bpCtx.createLinearGradient(0, y, 0, H);
        g.addColorStop(0, `hsla(${hue},100%,65%,0.85)`);
        g.addColorStop(1, `hsla(${hue},100%,45%,0.15)`);
        bpCtx.fillStyle = g;
        bpCtx.beginPath();
        bpCtx.roundRect(x, y, barW, barH, [Math.min(barW / 2, 2 * dpr), Math.min(barW / 2, 2 * dpr), 0, 0]);
        bpCtx.fill();
      }
    }

    // Expose drawBpIdle/Live for play toggle below
    window._bpDrawIdle = drawBpIdle;
    window._bpDrawLive = drawBpLive;
    window._bpIdleId   = () => bpIdleId;
    window._stopBpIdle = () => { if (bpIdleId) { cancelAnimationFrame(bpIdleId); bpIdleId = null; } };
  }

  // ── Volume ───────────────────────────────────────────────────
  volSlider.addEventListener('input', () => {
    if (bpAudio) bpAudio.volume = parseFloat(volSlider.value);
  });

  // ── Play / Pause ─────────────────────────────────────────────
  playBtn.addEventListener('click', () => {
    if (bpPlaying && bpAudio) {
      bpAudio.pause();
      bpAudio.src = '';
      bpPlaying = false;
      playBtn.textContent = '▶️';
      if (bpAnimId) { cancelAnimationFrame(bpAnimId); bpAnimId = null; }
      if (window._bpDrawIdle) window._bpDrawIdle();
      return;
    }

    // Init Web Audio on first play (requires user gesture)
    if (!bpAudioCtx) {
      try {
        bpAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        bpAnalyser = bpAudioCtx.createAnalyser();
        bpAnalyser.fftSize = 64;
        bpAnalyser.smoothingTimeConstant = 0.8;
      } catch(e) {}
    }

    if (!bpAudio) { bpAudio = new Audio(); bpAudio.crossOrigin = 'anonymous'; }

    // Connect to analyser if not already done
    if (bpAudioCtx && bpAnalyser && !bpSource) {
      try {
        bpSource = bpAudioCtx.createMediaElementSource(bpAudio);
        bpSource.connect(bpAnalyser);
        bpAnalyser.connect(bpAudioCtx.destination);
      } catch(e) {}
    }

    if (bpAudioCtx && bpAudioCtx.state === 'suspended') bpAudioCtx.resume();

    bpAudio.src = STREAM_URL + '?_t=' + Date.now();
    bpAudio.volume = parseFloat(volSlider.value);
    playBtn.textContent = '⏳';

    bpAudio.play()
      .then(() => {
        bpPlaying = true;
        playBtn.textContent = '⏸️';
        if (window._stopBpIdle) window._stopBpIdle();
        if (window._bpDrawLive) window._bpDrawLive();
      })
      .catch(err => {
        console.error('[BottomPlayer] Stream error:', err);
        playBtn.textContent = '▶️';
        showNotification('Could not connect to live stream. Is the stream active?', 'error');
      });

    bpAudio.addEventListener('error', () => {
      bpPlaying = false;
      playBtn.textContent = '▶️';
      if (window._bpDrawIdle) window._bpDrawIdle();
      bpStatusDot.className = 'bp-dot bp-dot--offline';
    }, { once: false });
  });

  // ── Format time helper ────────────────────────────────────────
  function fmtBpTime(s) {
    if (!s || isNaN(s)) return '';
    s = Math.floor(s);
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  }

  // ── Now-playing poll — runs from page load, no play required ──
  async function pollBpNowPlaying() {
    try {
      const res = await fetch('/api/public/now-playing');
      if (!res.ok) throw new Error('offline');
      const data = await res.json();
      const np = data.now_playing;

      if (np && np.title) {
        // Stream is reachable — mark LIVE
        bpStatusDot.className = 'bp-dot bp-dot--live';
        bpStatusDot.title = '● Stream LIVE';

        bpTitle.textContent  = np.title  || '—';
        bpArtist.textContent = np.artist ? '— ' + np.artist : '';

        // Cover art
        if (np.coverArtUrl) {
          const target = np.coverArtUrl;
          if (!bpCover.src.endsWith(target)) {
            bpCover.src = target;
            bpCover.onerror = () => { bpCover.src = '/covers/default-vinyl.svg'; };
          }
        }

        // Progress
        const elapsed = np.elapsed || 0;
        const dur = np.duration;
        if (dur) bpProgress.style.width = Math.min(100, (elapsed / dur) * 100) + '%';

      } else {
        bpStatusDot.className = 'bp-dot bp-dot--offline';
        bpTitle.textContent   = 'Stream Active';
        bpArtist.textContent  = '';
      }
    } catch(e) {
      bpStatusDot.className = 'bp-dot bp-dot--offline';
      bpTitle.textContent   = 'Station Offline';
      bpArtist.textContent  = '';
      bpProgress.style.width = '0%';
    }
  }

  // Start polling immediately on page load
  pollBpNowPlaying();
  setInterval(pollBpNowPlaying, 4000);
}

// === SYSTEM & AUDIT LOGS MANAGEMENT ===
let activeLogType = 'activity';

// Bind Logs UI Listeners
document.getElementById('select-log-type').addEventListener('change', (e) => {
  activeLogType = e.target.value;
  loadLogs();
});

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  const typeLabel = activeLogType === 'activity' ? 'System Activity Logs' : 'Playout Server Logs';
  showConfirm(
    'Clear Logs',
    `Are you sure you want to clear all ${typeLabel}? This action is permanent and cannot be undone.`,
    () => {
      const method = 'DELETE';
      const url = activeLogType === 'activity' ? '/logs/activity' : '/logs/system';
      
      apiFetch(url, { method })
        .then(() => {
          loadLogs();
          showNotification(`${typeLabel} cleared successfully.`, 'success');
        })
        .catch(err => showNotification(err.message, 'error'));
    }
  );
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
    .catch(err => showNotification(err.message, 'error'));
}


/* ═══════════════════════════════════════════════════════════════
   LIVE MONITOR MODULE
   Web Audio API spectrum visualizer + live stream player
   embedded in the Studio Desk section.
   ═══════════════════════════════════════════════════════════════ */
(function initLiveMonitor() {
  const STREAM_URL    = '/stream.mp3';
  const NP_URL        = '/api/public/now-playing';

  const audio         = document.getElementById('monitor-audio');
  const btnPlay       = document.getElementById('btn-monitor-play');
  const playIcon      = document.getElementById('monitor-play-icon');
  const volSlider     = document.getElementById('monitor-vol');
  const coverImg      = document.getElementById('monitor-cover');
  const titleEl       = document.getElementById('monitor-title');
  const artistEl      = document.getElementById('monitor-artist');
  const upNextEl      = document.getElementById('monitor-upnext');
  const progressFill  = document.getElementById('monitor-progress');
  const elapsedEl     = document.getElementById('monitor-elapsed');
  const durationEl    = document.getElementById('monitor-duration');
  const eqDot         = document.getElementById('monitor-eq');
  const trackLabel    = document.getElementById('monitor-track-label');
  const visHint       = document.getElementById('monitor-vis-hint');
  const canvas        = document.getElementById('monitor-vis-canvas');
  const btnCopy       = document.getElementById('btn-monitor-copy-url');

  if (!audio || !canvas) return; // Elements not in DOM yet

  const ctx2d = canvas.getContext('2d');
  let isPlaying   = false;
  let audioCtx, analyser, mediaSource, animFrameId;

  const PLAY_PATH  = 'M8 5v14l11-7z';
  const PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';

  // ── Volume ──────────────────────────────────────────────────
  if (audio) {
    audio.volume = parseFloat(volSlider.value);
    volSlider.addEventListener('input', () => {
      audio.volume = parseFloat(volSlider.value);
    });
  }

  // ── Canvas sizing ───────────────────────────────────────────
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width  = rect.width  * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ── Idle waveform animation (no audio) ─────────────────────
  let idleAnimId = null;
  function drawIdle() {
    if (isPlaying) return;
    const W = canvas.width, H = canvas.height;
    ctx2d.clearRect(0, 0, W, H);
    const barCount = 52;
    const dpr = window.devicePixelRatio || 1;
    const gap = 2.5 * dpr;
    const barW = (W - (barCount - 1) * gap) / barCount;
    const t = Date.now() / 600;
    for (let i = 0; i < barCount; i++) {
      const val = (Math.sin(t + i * 0.38) * 0.5 + 0.5) * 0.18 + 0.03;
      const barH = val * H;
      const x = i * (barW + gap);
      const y = H - barH;
      ctx2d.fillStyle = 'rgba(255,255,255,0.055)';
      ctx2d.beginPath();
      ctx2d.roundRect(x, y, barW, barH, 1.5 * dpr);
      ctx2d.fill();
    }
    idleAnimId = requestAnimationFrame(drawIdle);
  }
  drawIdle();

  // ── Live visualizer ─────────────────────────────────────────
  function drawLive() {
    if (!isPlaying) return;
    animFrameId = requestAnimationFrame(drawLive);
    const W = canvas.width, H = canvas.height;
    ctx2d.clearRect(0, 0, W, H);
    if (!analyser) return;

    const bufLen = analyser.frequencyBinCount;
    const data   = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data);

    const barCount = Math.min(bufLen, 52);
    const dpr = window.devicePixelRatio || 1;
    const gap  = 2.5 * dpr;
    const barW = (W - (barCount - 1) * gap) / barCount;

    for (let i = 0; i < barCount; i++) {
      const val  = data[i] / 255;
      const barH = Math.max(2 * dpr, val * H * 0.92);
      const x    = i * (barW + gap);
      const y    = H - barH;
      const hue  = 185 + (i / barCount) * 110;

      const grad = ctx2d.createLinearGradient(0, y, 0, H);
      grad.addColorStop(0, `hsla(${hue},100%,65%,0.9)`);
      grad.addColorStop(1, `hsla(${hue},100%,45%,0.2)`);
      ctx2d.fillStyle = grad;
      ctx2d.beginPath();
      ctx2d.roundRect(x, y, barW, barH, [Math.min(barW / 2, 2.5 * dpr), Math.min(barW / 2, 2.5 * dpr), 0, 0]);
      ctx2d.fill();
    }
  }

  // ── Web Audio setup ─────────────────────────────────────────
  function initAudioCtx() {
    if (audioCtx) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.82;
      mediaSource = audioCtx.createMediaElementSource(audio);
      mediaSource.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (e) {
      console.warn('[LiveMonitor] Web Audio API unavailable:', e);
    }
  }

  // ── Play / Pause ────────────────────────────────────────────
  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      if (!isPlaying) {
        initAudioCtx();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        // Bypass browser cache with timestamp to force fresh stream connection
        audio.src = STREAM_URL + '?_t=' + Date.now();
        audio.play().catch(e => {
          console.error('[LiveMonitor] Play error:', e);
          showNotification('Could not connect to live stream. Check stream status.', 'error');
        });
        isPlaying = true;
        playIcon.setAttribute('d', PAUSE_PATH);
        coverImg.classList.add('spinning');
        eqDot.classList.add('active');
        visHint.style.display = 'none';
        if (idleAnimId) { cancelAnimationFrame(idleAnimId); idleAnimId = null; }
        drawLive();
      } else {
        audio.pause();
        audio.src = '';
        isPlaying = false;
        playIcon.setAttribute('d', PLAY_PATH);
        coverImg.classList.remove('spinning');
        eqDot.classList.remove('active');
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        drawIdle();
      }
    });
  }

  audio.addEventListener('error', () => {
    isPlaying = false;
    if (playIcon) playIcon.setAttribute('d', PLAY_PATH);
    if (coverImg) coverImg.classList.remove('spinning');
    if (eqDot)   eqDot.classList.remove('active');
    showNotification('Live stream connection lost. Stream may be offline.', 'warning');
  });

  // ── Copy URL ────────────────────────────────────────────────
  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      const url = document.getElementById('monitor-stream-url').value;
      navigator.clipboard.writeText(url).then(() => {
        showNotification('Stream URL copied to clipboard!', 'success');
      }).catch(() => {
        document.getElementById('monitor-stream-url').select();
        document.execCommand('copy');
        showNotification('Stream URL copied!', 'success');
      });
    });
  }

  // ── Format seconds ──────────────────────────────────────────
  function fmtTime(s) {
    if (!s || isNaN(s)) return '—';
    s = Math.floor(s);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ── Now-playing sync (shares data with deck poller) ─────────
  // We piggyback on the existing studio poll; register a hook.
  // Falls back to its own interval if the hook isn't available.
  function syncFromNowPlaying(data) {
    if (!data) return;
    const np = data.now_playing;
    if (!np) return;

    // Update metadata
    titleEl.textContent  = np.title  || 'Unknown Track';
    artistEl.textContent = np.artist || 'Unknown Artist';

    const typeMap = { SONG:'🎵 NOW PLAYING', AD:'💰 AD BREAK', JINGLE:'🎤 JINGLE', STATION_ID:'📻 STATION ID', FILLER:'🎵 NOW PLAYING' };
    trackLabel.textContent = typeMap[np.fileType] || '🎵 NOW PLAYING';

    // Cover art
    if (np.coverArtUrl) {
      const target = np.coverArtUrl;
      if (!coverImg.src.endsWith(target)) {
        coverImg.src = target;
        coverImg.onerror = () => { coverImg.src = '/covers/default-vinyl.svg'; };
      }
    }

    // Progress
    const elapsed = np.elapsed || 0;
    const dur     = np.duration;
    elapsedEl.textContent  = fmtTime(elapsed);
    durationEl.textContent = dur ? fmtTime(dur) : '—';
    if (dur) progressFill.style.width = Math.min(100, (elapsed / dur) * 100) + '%';

    // Up next
    if (data.up_next && data.up_next.length > 0) {
      const nx = data.up_next[0];
      upNextEl.textContent = `${nx.title}${nx.artist ? ' — ' + nx.artist : ''}`;
    }
  }

  // Standalone poll (runs every 4s; the deck section also polls)
  async function pollMonitorNP() {
    try {
      const res = await fetch(NP_URL);
      if (!res.ok) return;
      const data = await res.json();
      syncFromNowPlaying(data);
    } catch(e) {}
  }
  pollMonitorNP();
  setInterval(pollMonitorNP, 4000);

})(); // end initLiveMonitor IIFE


// ═══════════════════════════════════════════════════════════════
// SYSTEM MONITORING MODULE (Task Manager Style)
// ═══════════════════════════════════════════════════════════════
let systemPollInterval = null;
let cpuHistory = Array(30).fill(0);
let ramHistory = Array(30).fill(0);

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  let parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function startSystemMonitoring() {
  if (systemPollInterval) clearInterval(systemPollInterval);
  
  // Reset history line graphs
  cpuHistory = Array(30).fill(0);
  ramHistory = Array(30).fill(0);

  // Initial poll
  pollSystemStatus();
  
  // Set interval to poll every 3 seconds
  systemPollInterval = setInterval(pollSystemStatus, 3000);
}

function stopSystemMonitoring() {
  if (systemPollInterval) {
    clearInterval(systemPollInterval);
    systemPollInterval = null;
  }
}

async function pollSystemStatus() {
  try {
    const data = await apiFetch('/system/status');
    
    // 1. Update CPU
    document.getElementById('sys-cpu-val').textContent = `${data.cpu.usagePercentage}%`;
    document.getElementById('sys-cpu-cores').textContent = `${data.cpu.cores} Cores`;
    document.getElementById('sys-cpu-model').textContent = data.cpu.model;
    
    // 2. Update RAM
    document.getElementById('sys-ram-val').textContent = `${data.ram.usagePercentage}%`;
    document.getElementById('sys-ram-details').textContent = `${(data.ram.used / 1024/1024/1024).toFixed(1)} GB / ${(data.ram.total / 1024/1024/1024).toFixed(1)} GB`;
    
    // 3. Update Disk
    document.getElementById('sys-disk-val').textContent = `${data.disk.usagePercentage}%`;
    document.getElementById('sys-disk-details').textContent = `${(data.disk.used / 1024/1024/1024).toFixed(1)} GB / ${(data.disk.total / 1024/1024/1024).toFixed(1)} GB`;
    document.getElementById('sys-disk-progress').style.width = `${data.disk.usagePercentage}%`;
    document.getElementById('sys-disk-free').textContent = `${(data.disk.free / 1024/1024/1024).toFixed(1)} GB available`;
    
    // 4. Update Library Size
    document.getElementById('sys-lib-size').textContent = formatBytes(data.audioSpace.bytesUsed);
    document.getElementById('sys-lib-tracks').textContent = `${data.audioSpace.tracksCount} tracks`;
    
    // 5. Update OS & Host Info
    document.getElementById('sys-os-platform').textContent = data.os.platform.toUpperCase();
    document.getElementById('sys-os-release').textContent = data.os.release;
    document.getElementById('sys-hostname').textContent = data.network.hostname;
    document.getElementById('sys-uptime').textContent = formatUptime(data.os.uptime);
    document.getElementById('sys-process-uptime').textContent = formatUptime(data.process.uptime);
    document.getElementById('sys-process-rss').textContent = formatBytes(data.process.memoryUsage);
    
    // 6. Update Connectivity Status
    const netStatus = document.getElementById('sys-network-connectivity');
    if (data.network.connected) {
      netStatus.className = 'live-pill';
      netStatus.style.background = 'rgba(0, 255, 102, 0.12)';
      netStatus.style.borderColor = 'rgba(0, 255, 102, 0.35)';
      netStatus.style.color = '#00ff66';
      netStatus.textContent = '● Online / Active';
    } else {
      netStatus.className = 'live-pill';
      netStatus.style.background = 'rgba(255, 60, 60, 0.12)';
      netStatus.style.borderColor = 'rgba(255, 60, 60, 0.35)';
      netStatus.style.color = '#ff5c5c';
      netStatus.textContent = '● Offline / Disconnected';
    }
    
    // 7. Update Network Interfaces list
    const interfacesContainer = document.getElementById('sys-network-interfaces');
    interfacesContainer.innerHTML = '';
    
    Object.keys(data.network.interfaces).forEach(ifaceName => {
      const addresses = data.network.interfaces[ifaceName];
      const activeAddresses = addresses.filter(addr => !addr.internal);
      if (activeAddresses.length === 0) return;
      
      const card = document.createElement('div');
      card.style.background = 'rgba(255,255,255,0.02)';
      card.style.border = '1px solid rgba(255,255,255,0.05)';
      card.style.borderRadius = '6px';
      card.style.padding = '10px 12px';
      
      let addrList = activeAddresses.map(addr => `
        <div style="display:flex; justify-content:space-between; margin-top:4px; font-family:monospace;">
          <span style="color:var(--text-muted); font-size:11px;">${addr.family}</span>
          <span style="color:var(--text-main); font-weight:600; font-size:11.5px;">${addr.address}</span>
        </div>
      `).join('');
      
      card.innerHTML = `
        <div style="font-weight:600; color:var(--primary-color); display:flex; align-items:center; gap:6px; font-size:12px;">
          <span>🌐</span> ${ifaceName}
        </div>
        <div style="margin-top:6px;">${addrList}</div>
      `;
      interfacesContainer.appendChild(card);
    });
    
    if (interfacesContainer.children.length === 0) {
      interfacesContainer.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">No public active interfaces found</div>';
    }

    // 8. Update history and draw charts
    cpuHistory.push(data.cpu.usagePercentage);
    cpuHistory.shift();
    ramHistory.push(data.ram.usagePercentage);
    ramHistory.shift();
    
    drawSystemSparkline('sys-cpu-chart', cpuHistory, 'rgba(0, 240, 255, 1)');
    drawSystemSparkline('sys-ram-chart', ramHistory, 'rgba(255, 0, 255, 1)');
    
  } catch (err) {
    console.error('Failed to poll system status:', err);
  }
}

function drawSystemSparkline(canvasId, history, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  
  // Background grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1 * dpr;
  const gridSpacing = 15 * dpr;
  for (let x = 0; x < W; x += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y < H; y += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  
  if (history.length < 2) return;
  const step = W / (history.length - 1);
  
  // Fill gradient
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i < history.length; i++) {
    const val = history[i] / 100;
    const x = i * step;
    const y = H - (val * H * 0.85 + 2 * dpr);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color.replace('1)', '0.12)'));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fill();
  
  // Outline stroke
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const val = history[i] / 100;
    const x = i * step;
    const y = H - (val * H * 0.85 + 2 * dpr);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
}


// ═══════════════════════════════════════════════════════════════
// USER DIRECTORY & MANAGEMENT CONTROLLER
// ═══════════════════════════════════════════════════════════════
function loadSettingsUsers() {
  if (!currentUser || currentUser.role !== 'ADMIN') return;

  apiFetch('/auth')
    .then(users => {
      const tbody = document.getElementById('settings-users-list');
      if (!tbody) return;
      tbody.innerHTML = '';

      users.forEach(user => {
        const tr = document.createElement('tr');
        const isSelf = user.id === currentUser.id;

        tr.innerHTML = `
          <td style="font-weight:600; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">${user.email} ${isSelf ? '<span class="live-pill" style="font-size:9px; background:rgba(0,240,255,0.1); border-color:rgba(0,240,255,0.3); color:var(--primary-color); margin-left:6px; padding:1px 6px;">YOU</span>' : ''}</td>
          <td style="padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">
            <span class="live-pill" style="font-size:10px; background:rgba(255,255,255,0.05); border-color:rgba(255,255,255,0.1); color:var(--text-main); padding:2px 8px;">
              ${user.role}
            </span>
          </td>
          <td style="text-align: right; padding: 10px 14px 10px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">
            ${isSelf ? '' : `<button class="queue-item-btn remove-btn user-delete-btn" data-id="${user.id}" title="Delete User">✕</button>`}
          </td>
        `;
        tbody.appendChild(tr);
      });

      // Bind delete buttons
      tbody.querySelectorAll('.user-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const userId = btn.dataset.id;
          showConfirm('Delete User Account', 'Are you sure you want to permanently delete this user from the system?', () => {
            apiFetch(`/auth/${userId}`, { method: 'DELETE' })
              .then(() => {
                loadSettingsUsers();
                showNotification('User account deleted successfully', 'success');
              })
              .catch(err => showNotification(err.message, 'error'));
          });
        });
      });
    })
    .catch(err => console.error('Failed to load users directory:', err));
}

// Register form submission listener
(function initUserMgmtForm() {
  const form = document.getElementById('settings-create-user-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('new-user-email').value;
    const password = document.getElementById('new-user-password').value;
    const role = document.getElementById('new-user-role').value;

    apiFetch('/auth/register', {
      method: 'POST',
      body: { email, password, role }
    })
    .then(() => {
      document.getElementById('new-user-email').value = '';
      document.getElementById('new-user-password').value = '';
      loadSettingsUsers();
      showNotification('User account registered successfully', 'success');
    })
    .catch(err => showNotification(err.message, 'error'));
  });
})();
