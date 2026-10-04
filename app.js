const CLIENT_ID = '41fe4feba0d949dfa05027199cc715e9'; // Reemplaza con tu Client ID
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = 'user-read-currently-playing user-read-playback-state';

let currentTrackId = null;
let lyricsData = [];
let currentProgress = 0;
let isPlaying = false;
let lastCheckTime = 0;

// PKCE AUTH
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

// OBTENER LETRAS DE LRCLIB
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

// REPRODUCCIÓN Y SINCRONIZACIÓN
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

        if (data.item.id !== currentTrackId) {
            currentTrackId = data.item.id;
            document.getElementById('track-title').innerText = data.item.name;
            document.getElementById('artist-name').innerText = data.item.artists.map(a => a.name).join(', ');
            document.getElementById('album-cover').src = data.item.album.images[0].url;

            lyricsData = await fetchLyrics(data.item.name, data.item.artists[0].name, data.item.album.name, data.item.duration_ms);
            renderLyrics(lyricsData);
        }

        currentProgress = data.progress_ms / 1000;
        isPlaying = data.is_playing;
        lastCheckTime = performance.now();
    } catch (e) {
        console.error(e);
    }
}

function renderLyrics(lyrics) {
    const container = document.getElementById('lyrics-container');
    if (!lyrics.length) {
        container.innerHTML = '<p class="placeholder">Letra sincronizada no disponible para este tema.</p>';
        return;
    }
    container.innerHTML = lyrics.map((l, i) => `<div class="lyric-line" id="line-${i}">${l.text}</div>`).join('');
}

function updateLyricsPosition() {
    if (lyricsData.length && isPlaying) {
        const elapsed = (performance.now() - lastCheckTime) / 1000;
        const now = currentProgress + elapsed;

        let activeIndex = -1;
        for (let i = 0; i < lyricsData.length; i++) {
            if (now >= lyricsData[i].time) activeIndex = i;
            else break;
        }

        document.querySelectorAll('.lyric-line').forEach((line, index) => {
            if (index === activeIndex) {
                if (!line.classList.contains('active')) {
                    line.classList.add('active');
                    line.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            } else {
                line.classList.remove('active');
            }
        });
    }
    requestAnimationFrame(updateLyricsPosition);
}

// INICIALIZACIÓN
handleCallback().then(() => {
    setInterval(checkPlayback, 3000);
    checkPlayback();
    requestAnimationFrame(updateLyricsPosition);
});
