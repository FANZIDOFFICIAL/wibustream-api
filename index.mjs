import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import puppeteer from 'puppeteer';

const app = express();
const cache = new NodeCache({ stdTTL: 1800 });
const PORT = process.env.PORT || 3000;

app.use(cors());

const BASE = 'https://hianime.to';

let browser = null;
async function getBrowser() {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
        });
    }
    return browser;
}

async function fetchWithPage(url, isJson = false) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'X-Requested-With': 'XMLHttpRequest', 'Accept': isJson ? 'application/json' : 'text/html' });
        
        // Visit homepage first to get cookies
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
        
        // Now fetch target
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const text = await res.text();
        return isJson ? JSON.parse(text) : text;
    } finally {
        await page.close();
    }
}

async function malToHianimeId(malId) {
    const ck = 'hianime:' + malId;
    if (cache.has(ck)) return cache.get(ck);

    const jikan = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
    const jData = await jikan.json();
    const title = jData?.data?.title_english || jData?.data?.title || '';
    if (!title) return null;

    const html = await fetchWithPage(`${BASE}/search?keyword=${encodeURIComponent(title)}`);
    const match = html.match(/href="\/([a-z0-9-]+-\d+)"/);
    if (!match) return null;

    cache.set(ck, match[1], 86400);
    return match[1];
}

async function getEpisodes(animeId) {
    const ck = 'eps:' + animeId;
    if (cache.has(ck)) return cache.get(ck);

    const numericId = animeId.match(/(\d+)$/)?.[1];
    if (!numericId) return [];

    const data = await fetchWithPage(`${BASE}/ajax/v2/episode/list/${numericId}`, true);
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
    const data = await fetchWithPage(`${BASE}/ajax/v2/episode/servers?episodeId=${epId}`, true);
    const serverHtml = data?.html || '';
    const serverMatch = serverHtml.match(/data-id="(\d+)"/);
    if (!serverMatch) return null;

    const srcData = await fetchWithPage(`${BASE}/ajax/v2/episode/sources?id=${serverMatch[1]}`, true);
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
        if (!episodes.length) throw new Error('Episode list kosong');

        const ep = episodes.find(e => e.number === epNum);
        if (!ep) throw new Error(`Episode ${epNum} tidak ditemukan dari ${episodes.length} ep`);

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

getBrowser().then(() => console.log('Browser ready'));
app.listen(PORT, () => console.log(`WibuStream API on port ${PORT}`));
