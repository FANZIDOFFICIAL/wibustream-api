import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import puppeteer from 'puppeteer';

const app = express();
const cache = new NodeCache({ stdTTL: 1800 });
const PORT = process.env.PORT || 3000;

app.use(cors());

let browser = null;
async function getBrowser() {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
            ]
        });
    }
    return browser;
}

async function fetchPage(url) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 10000 });
        return await page.content();
    } finally {
        await page.close();
    }
}

async function fetchJson(url) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36');
        const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        const text = await res.text();
        return JSON.parse(text);
    } finally {
        await page.close();
    }
}

const BASE = 'https://hianime.to';

async function malToHianimeId(malId) {
    const ck = 'hianime:' + malId;
    if (cache.has(ck)) return cache.get(ck);

    // Jikan → judul
    const jikan = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
    const jData = await jikan.json();
    const title = jData?.data?.title_english || jData?.data?.title || '';
    if (!title) return null;

    // Search HiAnime
    const html = await fetchPage(`${BASE}/search?keyword=${encodeURIComponent(title)}`);
    const match = html.match(/href="\/([a-z0-9-]+-\d+)"/);
    if (!match) return null;

    cache.set(ck, match[1], 86400);
    return match[1];
}

async function getEpisodes(animeId) {
    const ck = 'eps:' + animeId;
    if (cache.has(ck)) return cache.get(ck);

    const html = await fetchPage(`${BASE}/${animeId}`);
    const idMatch = animeId.match(/(\d+)$/);
    const numericId = idMatch?.[1];
    if (!numericId) return [];

    const data = await fetchJson(`${BASE}/ajax/v2/episode/list/${numericId}`);
    const epHtml = data?.html || '';
    const eps = [];
    const regex = /data-id="(\d+)"[^>]*data-number="(\d+)"/g;
    let m;
    while ((m = regex.exec(epHtml)) !== null) {
        eps.push({ id: m[1], number: parseInt(m[2]) });
    }

    if (eps.length) cache.set(ck, eps, 3600);
    return eps;
}

async function getStreamUrl(epId) {
    const data = await fetchJson(`${BASE}/ajax/v2/episode/servers?episodeId=${epId}`);
    const serverHtml = data?.html || '';
    const serverMatch = serverHtml.match(/data-id="(\d+)"/);
    if (!serverMatch) return null;

    const srcData = await fetchJson(`${BASE}/ajax/v2/episode/sources?id=${serverMatch[1]}`);
    return srcData?.link || null;
}

async function getWatchSources(epId) {
    const [realId] = (epId + '|jikan').split('|');
    const m = realId.match(/mal-(\d+)-(\d+)/);
    const malId = m?.[1] ?? '';
    const epNum = parseInt(m?.[2] ?? '1');
    if (!malId) return { sources: [], error: 'ID tidak valid' };

    const ck = 'watch:' + malId + ':' + epNum;
    if (cache.has(ck)) return cache.get(ck);

    try {
        const animeId = await malToHianimeId(malId);
        if (!animeId) throw new Error('Anime tidak ditemukan di HiAnime');

        const episodes = await getEpisodes(animeId);
        const ep = episodes.find(e => e.number === epNum);
        if (!ep) throw new Error(`Episode ${epNum} tidak ditemukan`);

        const streamUrl = await getStreamUrl(ep.id);
        if (!streamUrl) throw new Error('Stream URL tidak ditemukan');

        const result = { sources: [{ url: streamUrl, label: 'HiAnime', isM3U8: true }] };
        cache.set(ck, result, 1800);
        return result;
    } catch(e) {
        return { sources: [], error: e.message };
    }
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/watch', async (req, res) => {
    const id = req.query.id ?? '';
    if (!id) return res.json({ error: 'id required' });
    res.json(await getWatchSources(id));
});

// Init browser on startup
getBrowser().then(() => console.log('Browser ready'));
app.listen(PORT, () => console.log(`WibuStream API on port ${PORT}`));
