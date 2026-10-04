const CLIENT_ID = '41fe4feba0d949dfa05027199cc715e9';
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';

let currentTrackId = null;
let lyricsData = [];
let currentProgress = 0;
let trackDuration = 0;
let isPlaying = false;
let lastCheckTime = 0;
let isKaraokeMode = false;
let lastKaraokeText = '';

let isUserInteracting = false;
let interactionTimeout = null;
let fadeTimeout = null;
let hideTimeout = null;

let initialPinchDist = 0;
let initialFontSize = 24;

const lyricsContainer = document.getElementById('lyrics-container');

lyricsContainer.addEventListener('touchstart', (e) => {
    resetInactivityTimer();
    if (e.touches.length === 2) {
        initialPinchDist = Math.hypot(
            e.touches[0].pageX - e.touches[1].pageX,
            e.touches[0].pageY - e.touches[1].pageY
        );
        const currentSizeStr = getComputedStyle(document.documentElement).getPropertyValue('--base-font-size');
        initialFontSize = parseFloat(currentSizeStr) || 24;
    }
}, { passive: true });

lyricsContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && initialPinchDist > 0) {
        const currentDist = Math.hypot(
            e.touches[0].pageX - e.touches[1].pageX,
            e.touches[0].pageY - e.touches[1].pageY
        );
        const scale = currentDist / initialPinchDist;
        const newSize = Math.max(16, Math.min(60, initialFontSize * scale));
        document.documentElement.style.setProperty('--base-font-size', `${newSize}px`);
        localStorage.setItem('pref_font_size', newSize);
    }
}, { passive: true });

lyricsContainer.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) initialPinchDist = 0;
}, { passive: true });

function resetInactivityTimer(e) {
    if (window.innerWidth > window.innerHeight && e && e.clientX) {
        if (e.clientX > window.innerWidth * 0.35) {
            return; // Si se pulsa en la derecha (letras o botones), no despertar el menú
        }
    }

    const topBar = document.getElementById('top-bar');
    const progressWrapper = document.getElementById('progress-wrapper');
    if (!topBar) return;

    topBar.classList.remove('faded', 'hidden-bar');
    if (progressWrapper) progressWrapper.classList.remove('faded', 'hidden-bar');

    isUserInteracting = true;

    clearTimeout(interactionTimeout);
    clearTimeout(fadeTimeout);
    clearTimeout(hideTimeout);

    interactionTimeout = setTimeout(() => {
        isUserInteracting = false;
    }, 1500);

    fadeTimeout = setTimeout(() => {
        topBar.classList.add('faded');
        if (progressWrapper) progressWrapper.classList.add('faded');

        hideTimeout = setTimeout(() => {
            topBar.classList.add('hidden-bar');
            if (progressWrapper) progressWrapper.classList.add('hidden-bar');
            if (isKaraokeMode && lastKaraokeText) {
                setTimeout(() => fitKaraokeText(lastKaraokeText), 450);
            }
        }, 1000);
    }, 3000);
}

window.addEventListener('touchstart', (e) => {
    const touchX = e.touches[0] ? e.touches[0].clientX : 0;
    resetInactivityTimer({ clientX: touchX });
}, { passive: true });

window.addEventListener('click', (e) => {
    resetInactivityTimer({ clientX: e.clientX });
}, { passive: true });

window.addEventListener('wheel', resetInactivityTimer, { passive: true });
window.addEventListener('resize', () => {
    if (isKaraokeMode && lastKaraokeText) fitKaraokeText(lastKaraokeText);
});

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
    localStorage.clear();
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
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) return;

    const verifier = localStorage.getItem('code_verifier');
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
        window.history.replaceState({}, document.title, REDIRECT_URI);
    }
}

async function togglePlayPause(e) {
    if (e) e.stopPropagation();
    const token = localStorage.getItem('spotify_token');
    if (!token) return;

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
    } catch (err) {
        console.error('Error al cambiar reproducción', err);
    }
}

async function controlPlayback(action, e) {
    if (e) e.stopPropagation();
    const token = localStorage.getItem('spotify_token');
    if (!token) return;

    try {
        const res = await fetch(`https://api.spotify.com/v1/me/player/${action}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok || res.status === 204) {
            setTimeout(checkPlayback, 500);
        }
    } catch (err) {
        console.error(`Error en ${action}`, err);
    }
}

function updatePlayButtonUI() {
    const playBtn = document.getElementById('play-pause-btn');
    const floatPlayBtn = document.getElementById('float-play-btn');
    const symbol = isPlaying ? '⏸' : '▶';
    
    if (playBtn) playBtn.innerText = symbol;
    if (floatPlayBtn) floatPlayBtn.innerText = symbol;
}

async function fetchLyrics(track, artist, album, duration) {
    const durationSec = Math.round(duration / 1000);
    const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}&album_name=${encodeURIComponent(artist)}&duration=${durationSec}`;
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
    } catch {
        return [];
    }
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

function fitKaraokeText(text) {
    const elem = document.getElementById('karaoke-current');
    const container = document.getElementById('karaoke-container');
    const nextElem = document.getElementById('karaoke-next');
    if (!elem || !container) return;

    elem.innerText = text;
    if (!text) return;

    const isLandscape = window.innerWidth > window.innerHeight;
    const nextHeight = (nextElem && nextElem.innerText) ? nextElem.offsetHeight + 24 : 30;
    
    const maxW = container.clientWidth * 0.96;
    const maxH = Math.max(60, container.clientHeight - nextHeight - 20);

    let low = 18;
    let high = isLandscape ? Math.min(window.innerHeight * 0.58, window.innerWidth * 0.28) : Math.min(window.innerHeight * 0.28, window.innerWidth * 0.14);
    let bestSize = low;

    while (low <= high) {
        let mid = Math.floor((low + high) / 2);
        elem.style.fontSize = mid + 'px';

        if (elem.scrollWidth <= maxW && elem.scrollHeight <= maxH) {
            bestSize = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    elem.style.fontSize = bestSize + 'px';
}

function updateKaraokeText(text) {
    if (text !== lastKaraokeText) {
        const elem = document.getElementById('karaoke-current');
        elem.classList.add('roll-up');
        setTimeout(() => {
            lastKaraokeText = text;
            fitKaraokeText(text);
            elem.classList.remove('roll-up');
        }, 150);
    }
}

async function checkPlayback() {
    const token = localStorage.getItem('spotify_token');
    if (!token) return;

    document.getElementById('login-btn').classList.add('hidden');
    document.getElementById('player-container').classList.remove('hidden');

    try {
        const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 204) return;
        const data = await res.json();
        if (!data.item) return;

        trackDuration = data.item.duration_ms / 1000;
        currentProgress = data.progress_ms / 1000;
        isPlaying = data.is_playing;
        lastCheckTime = performance.now();
        updatePlayButtonUI();

        if (data.item.id !== currentTrackId) {
            currentTrackId = data.item.id;
            const coverUrl = data.item.album.images[0].url;

            document.getElementById('track-title').innerText = data.item.name;
            document.getElementById('artist-name').innerText = data.item.artists.map(a => a.name).join(', ');
            document.getElementById('album-cover').src = coverUrl;
            document.getElementById('bg-blur').style.backgroundImage = `url(${coverUrl})`;

            lyricsData = await fetchLyrics(data.item.name, data.item.artists[0].name, data.item.album.name, data.item.duration_ms);
            renderLyrics(lyricsData);
        }
    } catch (e) {
        console.error(e);
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

                            if (!isUserInteracting) {
                                const containerHeight = container.clientHeight;
                                const lineTop = line.offsetTop;
                                const lineHeight = line.clientHeight;
                                const targetScroll = lineTop - (containerHeight / 2) + (lineHeight / 2);
                                container.scrollTo({ top: targetScroll, behavior: 'smooth' });
                            }
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
        if (lastKaraokeText) fitKaraokeText(lastKaraokeText);
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

    const savedKaraoke = localStorage.getItem('pref_karaoke');
    if (savedKaraoke === 'true') {
        toggleKaraokeMode();
    }
}

loadPreferences();
handleCallback().then(() => {
    setInterval(checkPlayback, 2500);
    checkPlayback();
    requestAnimationFrame(updateUI);
});
