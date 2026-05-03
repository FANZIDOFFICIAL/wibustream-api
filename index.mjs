import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';

puppeteer.use(StealthPlugin());

const app = express();
const cache = new NodeCache({ stdTTL: 1800 });
const PORT = process.env.PORT || 3000;
const BASE = 'https://kuronime.sbs';

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

async function fetchHtml(url) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        return await page.content();
    } finally {
        await page.close();
    }
}

async function searchKuronime(title) {
    const ck = 'search:' + title;
    if (cache.has(ck)) return cache.get(ck);

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const b = await getBrowser();
    const page = await b.newPage();
    const results = [];
    try {
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(`${BASE}/search/${encodeURIComponent(slug)}/`, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('.bsx', { timeout: 5000 }).catch(() => {});
        const html = await page.content();
        const $ = cheerio.load(html);
        $('.bsx a').each((_, el) => {
            const href = $(el).attr('href') || '';
            const name = $(el).attr('title') || $(el).text().trim();
            if (href.includes('kuronime.sbs') && !href.includes('/genres/') && !href.includes('/season/')) {
                results.push({ href, name });
            }
        });
    } finally {
        await page.close();
    }

    if (results.length) cache.set(ck, results, 86400);
    return results;
}

async function getEpisodeUrl(animeUrl, epNum) {
    const ck = 'epurl:' + animeUrl + ':' + epNum;
    if (cache.has(ck)) return cache.get(ck);

    const b = await getBrowser();
    const page = await b.newPage();
    let epUrl = null;
    try {
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(animeUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('.eplister', { timeout: 5000 }).catch(() => {});
        const html = await page.content();
        const $ = cheerio.load(html);
        $('.eplister li').each((_, el) => {
            const num = parseInt($(el).find('.epl-num').text().trim());
            if (num === epNum) {
                epUrl = $(el).find('a').attr('href') || null;
            }
        });
    } finally {
        await page.close();
    }

    if (epUrl) cache.set(ck, epUrl, 3600);
    return epUrl;
}

async function getEmbed(epUrl) {
    const html = await fetchHtml(epUrl);
    const $ = cheerio.load(html);
    const iframe = $('iframe[src]').first().attr('src') ||
                   $('.player-embed iframe').attr('src') ||
                   $('iframe').first().attr('src') || null;
    return iframe;
}

async function malToKuronime(malId) {
    const ck = 'kuro:' + malId;
    if (cache.has(ck)) return cache.get(ck);

    const jikan = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
    const text = await jikan.text();
    let jData;
    try { jData = JSON.parse(text); } catch(e) { throw new Error('Jikan API error: ' + text.substring(0, 100)); }
    const title = jData?.data?.title || '';
    if (!title) return null;

    const results = await searchKuronime(title);
    if (!results.length) return null;

    cache.set(ck, results[0].href, 86400);
    return results[0].href;
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
        const animeUrl = await malToKuronime(malId);
        if (!animeUrl) throw new Error('Anime tidak ditemukan di Kuronime');

        const epUrl = await getEpisodeUrl(animeUrl, epNum);
        if (!epUrl) throw new Error(`Episode ${epNum} tidak ditemukan`);

        const embedUrl = await getEmbed(epUrl);
        if (!embedUrl) throw new Error('Embed tidak ditemukan');

        const result = { sources: [{ url: embedUrl, label: 'Kuronime', isM3U8: false }] };
        cache.set(ck, result, 1800);
        return result;
    } catch(e) {
        return { sources: [], error: e.message };
    }
}

app.get('/debug-search', async (req, res) => {
    const q = req.query.q || 'naruto';
    try {
        const html = await fetchHtml(`${BASE}/?s=${encodeURIComponent(q)}`);
        const $ = cheerio.load(html);
        const links = [];
        $('a[href*="kuronime"]').each((_, el) => {
            links.push({ href: $(el).attr('href'), text: $(el).text().trim().substring(0, 50) });
        });
        // Find anime result containers
        const containers = [];
        $('article, .bs, .bsx, .searchlist, .result').each((_, el) => {
            containers.push($(el).attr('class') || $(el).prop('tagName'));
        });
        res.json({ total: links.length, links: links.slice(0, 10), containers: [...new Set(containers)].slice(0, 20), snippet: html.substring(3000, 4500) });
    } catch(e) {
        res.json({ error: e.message });
    }
});

app.get('/debug-ep', async (req, res) => {
    const malId = req.query.mal || '20';
    const epNum = parseInt(req.query.ep || '1');
    try {
        const jikan = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
        const text = await jikan.text();
        let jData;
        try { jData = JSON.parse(text); } catch(e) { return res.json({ error: 'Jikan error: ' + text.substring(0, 200) }); }
        const title = jData?.data?.title || '';
        const results = await searchKuronime(title);
        const animeUrl = results[0]?.href || null;
        let epUrl = null;
        if (animeUrl) epUrl = await getEpisodeUrl(animeUrl, epNum);
        res.json({ title, results: results.slice(0, 3), animeUrl, epUrl });
    } catch(e) {
        res.json({ error: e.message });
    }
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/watch', async (req, res) => {
    const id = req.query.id ?? '';
    if (!id) return res.json({ error: 'id required' });
    res.json(await getWatchSources(id));
});

app.get('/debug', async (req, res) => {
    const url = req.query.url || BASE;
    try {
        const html = await fetchHtml(url);
        res.json({ snippet: html.substring(0, 1000) });
    } catch(e) {
        res.json({ error: e.message });
    }
});

getBrowser().then(() => console.log('Browser ready'));
app.listen(PORT, () => console.log(`WibuStream API on port ${PORT}`));
