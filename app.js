const CLIENT_ID = '41fe4feba0d949dfa05027199cc715e9';
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative';

let currentTrackId = null;
let lyricsData = [];
let currentProgress = 0;
let trackDuration = 0;
let isPlaying = false;
let isShuffle = false;
let repeatState = 'off';
let lastCheckTime = 0;
let isKaraokeMode = false;
let lastKaraokeText = '';

let favoritePlaylists = JSON.parse(localStorage.getItem('fav_playlists') || '["37i9dQZF1DXcBWIGoYBM5M"]');

// --- GESTO PINCH-TO-ZOOM ---
let initialPinchDist = 0;
let initialFontSize = 28;

document.querySelectorAll('.zoom-target').forEach(container => {
    container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            initialPinchDist = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            const currentSizeStr = getComputedStyle(document.documentElement).getPropertyValue('--base-font-size');
            initialFontSize = parseFloat(currentSizeStr) || 28;
        }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && initialPinchDist > 0) {
            const currentDist = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            const scale = currentDist / initialPinchDist;
            const newSize = Math.max(16, Math.min(90, initialFontSize * scale));
            document.documentElement.style.setProperty('--base-font-size', `${newSize}px`);
            localStorage.setItem('pref_font_size', newSize);
        }
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) initialPinchDist = 0;
    }, { passive: true });
});

// --- PKCE AUTH & TOKEN REFRESH ROBUSTO ---
function generateRandomString(length) {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = crypto.getRandomValues(new Uint8Array(length));
    return values.reduce((acc, x) => acc + possible[x % possible.length], "");
}

async function sha256(plain) {
    const encoder = new TextEncoder();
    return window.crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

function base64encode(input) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(input)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function redirectToSpotify() {
    // Limpiamos únicamente credenciales de autenticación sin tocar preferencias ni favoritos
    localStorage.removeItem('spotify_token');
    localStorage.removeItem('spotify_refresh_token');
    localStorage.removeItem('token_expiry');
    localStorage.removeItem('code_verifier');

    const verifier = generateRandomString(64);
    const challenge = base64encode(await sha256(verifier));
    localStorage.setItem('code_verifier', verifier);

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        redirect_uri: REDIRECT_URI,
    });
    window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function handleCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    if (!code) return;

    const verifier = localStorage.getItem('code_verifier');
    if (!verifier) return;

    try {
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                code_verifier: verifier,
            })
        });
        const data = await res.json();
        if (data.access_token) {
            localStorage.setItem('spotify_token', data.access_token);
            if (data.refresh_token) {
                localStorage.setItem('spotify_refresh_token', data.refresh_token);
            }
            // Los tokens de Spotify expiran en 3600 segundos (1 hora)
            localStorage.setItem('token_expiry', Date.now() + (data.expires_in || 3600) * 1000);
            window.history.replaceState({}, document.title, REDIRECT_URI);
        }
    } catch (err) {
        console.error("Error en handleCallback:", err);
    }
}

// Obtiene un token válido, renovándolo automáticamente con el Refresh Token si ha caducado
async function getValidToken() {
    let token = localStorage.getItem('spotify_token');
    let expiry = localStorage.getItem('token_expiry');
    let refreshToken = localStorage.getItem('spotify_refresh_token');

    // Si el token expira en menos de 1 minuto o ya expiró, intentamos refrescarlo de forma silenciosa
    if ((!token || (expiry && Date.now() > parseInt(expiry) - 60000)) && refreshToken) {
        try {
            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken
                })
            });
            const data = await res.json();
            if (data.access_token) {
                localStorage.setItem('spotify_token', data.access_token);
                if (data.refresh_token) {
                    localStorage.setItem('spotify_refresh_token', data.refresh_token);
                }
                localStorage.setItem('token_expiry', Date.now() + (data.expires_in || 3600) * 1000);
                return data.access_token;
            }
        } catch (err) {
            console.error("Error renovando token automáticamente:", err);
        }
    }
    return token;
}

// --- CONTROLES Y API SPOTIFY ---
async function togglePlayPause(e) {
    if (e) e.stopPropagation();
    const token = await getValidToken();
    if (!token) return redirectToSpotify();

    const endpoint = isPlaying ? 'pause' : 'play';
    try {
        const res = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok || res.status === 204) {
            isPlaying = !isPlaying;
            updatePlayButtonUI();
            setTimeout(checkPlayback, 300);
        }
    } catch (err) { console.error(err); }
}

async function controlPlayback(action, e) {
    if (e) e.stopPropagation();
    const token = await getValidToken();
    if (!token) return redirectToSpotify();

    try {
        const res = await fetch(`https://api.spotify.com/v1/me/player/${action}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok || res.status === 204) {
            setTimeout(checkPlayback, 500);
        }
    } catch (err) { console.error(err); }
}

async function toggleShuffle(e) {
    if (e) e.stopPropagation();
    const token = await getValidToken();
    if (!token) return redirectToSpotify();

    isShuffle = !isShuffle;
    try {
        await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=${isShuffle}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        updateShuffleRepeatUI();
    } catch (err) { console.error(err); }
}

async function toggleRepeat(e) {
    if (e) e.stopPropagation();
    const token = await getValidToken();
    if (!token) return redirectToSpotify();

    if (repeatState === 'off') repeatState = 'context';
    else if (repeatState === 'context') repeatState = 'track';
    else repeatState = 'off';

    try {
        await fetch(`https://api.spotify.com/v1/me/player/repeat?state=${repeatState}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        updateShuffleRepeatUI();
    } catch (err) { console.error(err); }
}

function updatePlayButtonUI() {
    const svgContainer = document.getElementById('play-pause-svg');
    if (svgContainer) {
        if (isPlaying) {
            svgContainer.innerHTML = '<path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
        } else {
            svgContainer.innerHTML = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
        }
    }
}

function updateShuffleRepeatUI() {
    const shuffleBtn = document.getElementById('shuffle-btn');
    const repeatBtn = document.getElementById('repeat-btn');
    if (shuffleBtn) {
        if (isShuffle) shuffleBtn.classList.add('active-state');
        else shuffleBtn.classList.remove('active-state');
    }
    if (repeatBtn) {
        if (repeatState !== 'off') {
            repeatBtn.classList.add('active-state');
        } else {
            repeatBtn.classList.remove('active-state');
        }
    }
}

// --- QUICK MENU DOCK DE PLAYLISTS ---
async function loadPlaylistsDock() {
    const token = await getValidToken();
    const container = document.getElementById('playlists-scroll-container');
    if (!token || !container) return;

    try {
        const userPlRes = await fetch('https://api.spotify.com/v1/me/playlists?limit=25', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (userPlRes.ok) {
            const userPlData = await userPlRes.json();
            userPlData.items.forEach(pl => {
                if (pl && pl.id && !favoritePlaylists.includes(pl.id)) {
                    favoritePlaylists.push(pl.id);
                }
            });
            localStorage.setItem('fav_playlists', JSON.stringify(favoritePlaylists));
        }
    } catch (e) { console.error(e); }

    container.innerHTML = '';
    for (const plId of favoritePlaylists) {
        try {
            const res = await fetch(`https://api.spotify.com/v1/playlists/${plId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const plData = await res.json();
                const img = plData.images && plData.images[0] ? plData.images[0].url : '';
                const pill = document.createElement('div');
                pill.className = 'playlist-pill';
                pill.innerHTML = `<img src="${img}" alt=""><span>${plData.name}</span>`;
                pill.onclick = () => {
                    window.open(plData.external_urls.spotify, '_blank');
                };
                container.appendChild(pill);
            }
        } catch (e) { console.error(e); }
    }
}

function openAddPlaylistModal(e) {
    if (e) e.stopPropagation();
    document.getElementById('add-playlist-modal').classList.remove('hidden');
}

function closeAddPlaylistModal() {
    document.getElementById('add-playlist-modal').classList.add('hidden');
}

async function saveNewPlaylist() {
    const input = document.getElementById('playlist-uri-input').value.trim();
    if (!input) return;
    let id = input;
    
    if (input.includes('spotify.com/playlist/')) {
        id = input.split('playlist/')[1].split('?')[0];
    } else if (input.includes('playlist:')) {
        id = input.split('playlist:')[1];
    }

    if (id && !favoritePlaylists.includes(id)) {
        favoritePlaylists.push(id);
        localStorage.setItem('fav_playlists', JSON.stringify(favoritePlaylists));
        loadPlaylistsDock();
    }
    closeAddPlaylistModal();
    document.getElementById('playlist-uri-input').value = '';
}

// --- API LETRAS & REFRESCAR MANUAL ---
async function fetchLyrics(track, artist, album, duration) {
    const durationSec = Math.round(duration / 1000);
    const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}&album_name=${encodeURIComponent(album)}&duration=${durationSec}`;
    try {
        let res = await fetch(url);
        if (!res.ok) {
            const searchRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + track)}`);
            const searchData = await searchRes.json();
            if (searchData && searchData.length > 0) {
                return parseLRC(searchData[0].syncedLyrics || '');
            }
            return [];
        }
        const data = await res.json();
        return parseLRC(data.syncedLyrics || '');
    } catch { return []; }
}

function manualSyncLyrics(e) {
    if (e) e.stopPropagation();
    if (!currentTrackId) return;
    checkPlayback(true);
}

function parseLRC(lrcText) {
    const lines = lrcText.split('\n');
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
    for (let line of lines) {
        const match = timeRegex.exec(line);
        if (match) {
            const min = parseInt(match[1], 10);
            const sec = parseInt(match[2], 10);
            const ms = parseInt(match[3].padEnd(3, '0'), 10);
            const time = min * 60 + sec + ms / 1000;
            const text = line.replace(timeRegex, '').trim();
            if (text) result.push({ time, text });
        }
    }
    return result;
}

function updateKaraokeText(text) {
    if (text !== lastKaraokeText) {
        lastKaraokeText = text;
        const elem = document.getElementById('karaoke-current');
        elem.classList.add('roll-up');
        setTimeout(() => {
            elem.innerText = text;
            elem.classList.remove('roll-up');
        }, 150);
    }
}

async function checkPlayback(forceLyrics = false) {
    const token = await getValidToken();
    if (!token) {
        document.getElementById('login-btn').classList.remove('hidden');
        document.getElementById('player-container').classList.add('hidden');
        return;
    }

    document.getElementById('login-btn').classList.add('hidden');
    document.getElementById('player-container').classList.remove('hidden');

    try {
        const res = await fetch('https://api.spotify.com/v1/me/player', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 204) return;
        if (res.status === 401) {
            redirectToSpotify();
            return;
        }
        const data = await res.json();
        if (!data.item) return;

        trackDuration = data.item.duration_ms / 1000;
        currentProgress = data.progress_ms / 1000;
        isPlaying = data.is_playing;
        isShuffle = data.shuffle_state;
        repeatState = data.repeat_state;
        lastCheckTime = performance.now();
        updatePlayButtonUI();
        updateShuffleRepeatUI();

        if (data.context && data.context.type === 'playlist') {
            const plUri = data.context.uri;
            const plId = plUri.split(':')[2];
            fetch(`https://api.spotify.com/v1/playlists/${plId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => r.json()).then(plInfo => {
                const ctxLabel = document.getElementById('playlist-context-label');
                ctxLabel.innerText = `"${plInfo.name}"`;
                ctxLabel.classList.remove('hidden');
            }).catch(() => {});
        } else {
            document.getElementById('playlist-context-label').classList.add('hidden');
        }

        if (data.item.id !== currentTrackId || forceLyrics) {
            currentTrackId = data.item.id;
            const coverUrl = data.item.album.images[0].url;

            document.getElementById('track-title').innerText = data.item.name;
            document.getElementById('artist-name').innerText = data.item.artists.map(a => a.name).join(', ');
            document.getElementById('album-name').innerText = data.item.album.name;
            document.getElementById('album-cover').src = coverUrl;
            document.getElementById('bg-blur').style.backgroundImage = `url(${coverUrl})`;

            lyricsData = await fetchLyrics(data.item.name, data.item.artists[0].name, data.item.album.name, data.item.duration_ms);
            renderLyrics(lyricsData);
        }
    } catch (e) {
        console.error("Error en checkPlayback:", e);
    }
}

function renderLyrics(lyrics) {
    const container = document.getElementById('lyrics-container');
    if (!lyrics.length) {
        container.innerHTML = '<p class="placeholder">Letra sincronizada no disponible para este tema.</p>';
        document.getElementById('karaoke-current').innerText = 'Sin letra disponible';
        document.getElementById('karaoke-next').innerText = '';
        return;
    }
    container.innerHTML = lyrics.map((l, i) => `<div class="lyric-line" id="line-${i}">${l.text}</div>`).join('');
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateUI() {
    if (isPlaying && trackDuration > 0) {
        const elapsed = (performance.now() - lastCheckTime) / 1000;
        const now = Math.min(currentProgress + elapsed, trackDuration);
        const remaining = trackDuration - now;

        document.getElementById('time-elapsed').innerText = formatTime(now);
        document.getElementById('time-remaining').innerText = `-${formatTime(remaining)}`;
        const pct = (now / trackDuration) * 100;
        document.getElementById('progress-bar-fill').style.width = `${pct}%`;

        if (lyricsData.length) {
            let activeIndex = -1;
            for (let i = 0; i < lyricsData.length; i++) {
                if (now >= lyricsData[i].time) activeIndex = i;
                else break;
            }

            if (isKaraokeMode) {
                if (activeIndex >= 0) {
                    updateKaraokeText(lyricsData[activeIndex].text);
                    const nextLine = lyricsData[activeIndex + 1];
                    document.getElementById('karaoke-next').innerText = nextLine ? nextLine.text : '---';
                }
            } else {
                const container = document.getElementById('lyrics-container');
                document.querySelectorAll('.lyric-line').forEach((line, index) => {
                    if (index === activeIndex) {
                        if (!line.classList.contains('active')) {
                            line.classList.add('active');
                            const containerHeight = container.clientHeight;
                            const lineTop = line.offsetTop;
                            const lineHeight = line.clientHeight;
                            const targetScroll = lineTop - (containerHeight / 2) + (lineHeight / 2);
                            container.scrollTo({ top: targetScroll, behavior: 'smooth' });
                        }
                    } else {
                        line.classList.remove('active');
                    }
                });
            }
        }
    }
    requestAnimationFrame(updateUI);
}

function toggleSettings(e) {
    if (e) e.stopPropagation();
    document.getElementById('settings-panel').classList.toggle('hidden');
}

function toggleKaraokeMode(e) {
    if (e) e.stopPropagation();
    isKaraokeMode = !isKaraokeMode;
    const scrollContainer = document.getElementById('lyrics-container');
    const karaokeContainer = document.getElementById('karaoke-container');
    const btn = document.getElementById('mode-btn');

    if (isKaraokeMode) {
        scrollContainer.classList.add('hidden');
        karaokeContainer.classList.remove('hidden');
        btn.innerText = 'Ver Letra Completa 📜';
    } else {
        scrollContainer.classList.remove('hidden');
        karaokeContainer.classList.add('hidden');
        btn.innerText = 'Activar Modo Karaoke 🎤';
    }
    localStorage.setItem('pref_karaoke', isKaraokeMode);
}

function setTheme(themeName, e) {
    if (e) e.stopPropagation();
    document.body.className = themeName;
    localStorage.setItem('pref_theme', themeName);
}

function toggleFullscreen(e) {
    if (e) e.stopPropagation();
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen().catch(() => {});
    }
}

function loadPreferences() {
    const savedTheme = localStorage.getItem('pref_theme');
    if (savedTheme) setTheme(savedTheme);

    const savedSize = localStorage.getItem('pref_font_size');
    if (savedSize) {
        document.documentElement.style.setProperty('--base-font-size', `${savedSize}px`);
    }

    const savedKaraoke = localStorage.getItem('pref_karaoke');
    if (savedKaraoke === 'true') {
        toggleKaraokeMode();
    }
}

loadPreferences();
handleCallback().then(() => {
    loadPlaylistsDock();
    setInterval(checkPlayback, 2500);
    checkPlayback();
    requestAnimationFrame(updateUI);
});
