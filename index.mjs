import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const app = express();
const cache = new NodeCache({ stdTTL: 1800 });
const PORT = process.env.PORT || 3000;
const BASE = 'https://hianime.to';

app.use(cors());

let browser = null;
async function getBrowser() {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
        });
    }
    return browser;
}

async function newPage() {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    return page;
}

async function fetchHtml(url) {
    const page = await newPage();
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        return await page.content();
    } finally {
        await page.close();
    }
}

async function fetchAjax(url) {
    const page = await newPage();
    try {
        // Load homepage first for cookies
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Fetch AJAX via evaluate
        const result = await page.evaluate(async (ajaxUrl) => {
            const res = await fetch(ajaxUrl, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            return res.text();
        }, url);
        return JSON.parse(result);
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

    const html = await fetchHtml(`${BASE}/search?keyword=${encodeURIComponent(title)}`);
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

    const data = await fetchAjax(`${BASE}/ajax/v2/episode/list/${numericId}`);
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
    const data = await fetchAjax(`${BASE}/ajax/v2/episode/servers?episodeId=${epId}`);
    const serverHtml = data?.html || '';
    const serverMatch = serverHtml.match(/data-id="(\d+)"/);
    if (!serverMatch) return null;

    const srcData = await fetchAjax(`${BASE}/ajax/v2/episode/sources?id=${serverMatch[1]}`);
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

getBrowser().then(() => console.log('Browser ready'));
app.listen(PORT, () => console.log(`WibuStream API on port ${PORT}`));
