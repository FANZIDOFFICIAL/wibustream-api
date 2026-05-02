const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
    'Referer': 'https://otakudesu.cloud/',
};

async function get(url, json = false) {
    try {
        const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        return json ? res.data : res.data;
    } catch (e) {
        return null;
    }
}

// ── Sanka Vollerei proxy ──────────────────────────────────────────────────
async function sanka(path) {
    const url = 'https://www.sankavollerei.com' + path;
    const ck = 'sanka:' + path;
    if (cache.has(ck)) return cache.get(ck);
    try {
        const res = await axios.get(url, {
            headers: { ...HEADERS, Accept: 'application/json' },
            timeout: 15000
        });
        const data = res.data;
        if (!data || data.ok === false) return null;
        const result = data.data ?? data;
        cache.set(ck, result);
        return result;
    } catch (e) {
        return null;
    }
}

// ── Otakudesu scraper ─────────────────────────────────────────────────────
async function scrapeOtakudesu(epSlug) {
    const url = `https://otakudesu.cloud/episode/${epSlug}/`;
    const html = await get(url);
    if (!html) return null;
    const $ = cheerio.load(html);
    const sources = [];

    // Mirror links
    $('.mirrorstream ul li a').each((_, el) => {
        const href = $(el).attr('data-url') || $(el).attr('href') || '';
        const label = $(el).text().trim();
        if (href && href.startsWith('http')) {
            sources.push({ url: href, label: label || 'Mirror' });
        }
    });

    // Embed links from noembed/desustream
    $('iframe').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src && src.startsWith('http')) {
            sources.push({ url: src, label: 'Stream' });
        }
    });

    return sources.length ? sources : null;
}

// ── Resolve via Sanka then fallback scrape ────────────────────────────────
async function getWatchSources(epId) {
    const [realId, srcKey] = (epId + '|otakudesu').split('|');

    // MAL/Jikan fallback → AniList convert → embed
    if (realId.startsWith('mal-') || srcKey === 'jikan') {
        const m = realId.match(/mal-(\d+)-(\d+)/);
        const malId = m?.[1] ?? '';
        const epNum = m?.[2] ?? '1';

        // Konversi MAL → AniList
        let anilistId = malId;
        try {
            const gql = await axios.post('https://graphql.anilist.co', {
                query: `query{Media(idMal:${malId},type:ANIME){id}}`
            }, { headers: { 'Content-Type': 'application/json' } });
            anilistId = gql.data?.data?.Media?.id ?? malId;
        } catch (e) {}

        return {
            sources: [
                { url: `https://player.vidplus.to/embed/anime/${anilistId}/${epNum}`, label: 'VidPlus' },
                { url: `https://www.miruro.tv/watch?id=${anilistId}&ep=${epNum}`, label: 'Miruro' },
            ],
            notice: 'Menampilkan server alternatif.'
        };
    }

    // Coba Sanka dulu
    const pfx = srcKey === 'samehadaku' ? '/anime/samehadaku' : '/anime';
    const epData = await sanka(`${pfx}/episode/${realId}`);

    if (epData) {
        const serverList = epData.serverList ?? epData.server ?? epData.servers ?? [];
        const sources = [];
        for (const group of serverList) {
            const items = group.qualities ?? group.servers ?? [group];
            for (const srv of items) {
                const serverId = srv.serverId ?? srv.server_id ?? srv.id ?? '';
                const label = srv.serverName ?? srv.qualityLabel ?? srv.name ?? `Server ${sources.length + 1}`;
                if (serverId) {
                    const resolved = await sanka(`/anime/server/${serverId}`);
                    const url = resolved?.url ?? resolved?.embedUrl ?? resolved?.embed ?? '';
                    if (url) sources.push({ url, label });
                } else {
                    const url = srv.url ?? srv.streamUrl ?? '';
                    if (url) sources.push({ url, label });
                }
                if (sources.length >= 5) break;
            }
            if (sources.length >= 5) break;
        }
        if (sources.length) return { sources };
    }

    // Fallback: scrape langsung
    const scraped = await scrapeOtakudesu(realId);
    if (scraped) return { sources: scraped };

    return { sources: [], error: 'Gagal memuat episode' };
}

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/watch', async (req, res) => {
    const id = req.query.id ?? '';
    if (!id) return res.json({ error: 'id required' });

    const ck = 'watch:' + id;
    if (cache.has(ck)) return res.json(cache.get(ck));

    const data = await getWatchSources(id);
    if (data.sources?.length) cache.set(ck, data, 1800);
    res.json(data);
});

app.get('/proxy-sanka', async (req, res) => {
    const path = req.query.path ?? '';
    if (!path) return res.json({ error: 'path required' });
    const data = await sanka(path);
    res.json(data ?? { error: 'gagal' });
});

app.listen(PORT, () => console.log(`WibuStream API running on port ${PORT}`));
