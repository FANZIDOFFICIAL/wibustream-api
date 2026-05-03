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

async function jikanFetch(malId) {
    const ck = 'jikan:' + malId;
    if (cache.has(ck)) return cache.get(ck);
    const res = await fetch(`https://api.jikan.moe/v4/anime/${malId}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://myanimelist.net/',
        }
    });
    const text = await res.text();
    try {
        const data = JSON.parse(text);
        if (data?.data) cache.set(ck, data, 86400);
        return data;
    } catch(e) {
        throw new Error('Jikan error: ' + text.substring(0, 100));
    }
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

    const b = await getBrowser();
    const page = await b.newPage();
    const results = [];
    try {
        await page.setViewport({ width: 1280, height: 800 });
        // Kuronime pakai /?s= bukan /search/
        const searchUrl = `${BASE}/?s=${encodeURIComponent(title)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('.bsx', { timeout: 5000 }).catch(() => {});
        const html = await page.content();
        const $ = cheerio.load(html);

        // Coba berbagai selector hasil search kuronime
        const seen = new Set();
        const trySelectors = ['.bsx a', '.bs a', '.animes a', 'article a', '.searchlist a'];
        for (const sel of trySelectors) {
            $(sel).each((_, el) => {
                const href = $(el).attr('href') || '';
                const name = $(el).attr('title') || $(el).text().trim();
                if (
                    href.includes('kuronime.sbs/anime/') &&
                    !href.includes('/genres/') &&
                    !href.includes('/season/') &&
                    !href.includes('/episode') &&
                    name &&
                    !seen.has(href)
                ) {
                    seen.add(href);
                    results.push({ href, name });
                }
            });
            if (results.length > 0) break;
        }
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
        const html = await page.content();
        const $ = cheerio.load(html);

        // Try multiple selectors
        const selectors = [
            '.eplister li a', '.eplist li a', '.episodelist li a',
            '#episodelist li a', 'ul.episodelist a', '.epcurrent a',
            '.eps li a', '.ep-item a', '#episode_list li a',
            '.episodes li a', '.daftar-episode li a', 'ul.episodes a'
        ];
        for (const sel of selectors) {
            $(sel).each((_, el) => {
                const href = $(el).attr('href') || '';
                const text = $(el).text().trim();
                const numMatch = text.match(/(\d+)/);
                const num = numMatch ? parseInt(numMatch[1]) : null;
                if (num === epNum && href && !epUrl) epUrl = href;
            });
            if (epUrl) break;
        }

        // Fallback 1 & 2: cari link dengan pola episode-N yang EXACT
        // Pakai regex agar episode-1 tidak match episode-10, episode-100, dll
        if (!epUrl) {
            const epPattern = new RegExp('episode-0*' + epNum + '(?:[^0-9]|$)', 'i');
            $('a').each((_, el) => {
                const href = $(el).attr('href') || '';
                if (epPattern.test(href) && href.includes('kuronime') && !epUrl) {
                    epUrl = href;
                }
            });
        }

        // Fallback 3: cari dari teks link yang mengandung nomor episode exact
        if (!epUrl) {
            $('a').each((_, el) => {
                const href = $(el).attr('href') || '';
                const text = $(el).text().trim();
                // Match "Episode 1", "Ep 1", "1" yang berdiri sendiri
                const numMatch = text.match(/^(?:episode\s*)?(\d+)$/i);
                const num = numMatch ? parseInt(numMatch[1]) : null;
                if (num === epNum && href && href.includes('kuronime') && !epUrl) {
                    epUrl = href;
                }
            });
        }
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

    const jData = await jikanFetch(malId);
    const title = jData?.data?.title || '';
    const titleEn = jData?.data?.title_english || '';
    if (!title) return null;

    // Try direct URL first
    for (const t of [titleEn, title]) {
        if (!t) continue;
        const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const directUrl = `${BASE}/anime/${slug}/`;
        try {
            const html = await fetchHtml(directUrl);
            // Check it's not a 404/redirect by looking for anime-specific content
            if (!html.includes('Page Not Found') && !html.includes('404') && html.includes('episode')) {
                cache.set(ck, directUrl, 86400);
                return directUrl;
            }
        } catch(e) {}
    }

    // Fallback: search
    for (const t of [titleEn, title]) {
        if (!t) continue;
        const results = await searchKuronime(t);
        if (!results.length) continue;

        const q = t.toLowerCase().trim();

        // Scoring function — makin tinggi makin cocok
        function scoreMatch(r) {
            const rName = r.name.toLowerCase().trim();
            const rUrl  = r.href.toLowerCase();
            let score = 0;

            // Exact match nama → skor tertinggi
            if (rName === q || rName === q + ' (tv)') return 1000;

            // Nama dimulai dengan judul persis (misal "naruto kecil" starts with "naruto" → boleh)
            // Tapi hindari "boruto: naruto next generations"
            // Penalti besar kalau nama hasil LEBIH PANJANG dari query (kemungkinan judul lain)
            const extraWords = rName.replace(q, '').trim().split(/\s+/).filter(Boolean).length;
            score -= extraWords * 20;

            // Bonus kalau slug URL = slug query persis
            const slug = q.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            if (rUrl.includes('/' + slug + '/')) score += 200;

            // Bonus kalau nama mengandung semua kata query
            const words = q.split(/\s+/).filter(w => w.length > 1);
            const allWords = words.every(w => rName.includes(w));
            if (allWords) score += 50;

            // Bonus kalau panjang nama mirip dengan query (berarti lebih spesifik)
            const lenDiff = Math.abs(rName.length - q.length);
            score -= lenDiff * 2;

            // Penalti keras kalau nama mengandung kata yang TIDAK ada di query
            // dan kata itu adalah kata kunci (movie, next, generation, shippuden, dll)
            const extraKeywords = ['movie', 'next generations', 'shippuden', 'boruto', 'special', 'ova'];
            for (const kw of extraKeywords) {
                if (rName.includes(kw) && !q.includes(kw)) score -= 300;
            }

            return score;
        }

        // Sort by score descending, ambil yang terbaik
        const scored = results
            .map(r => ({ ...r, score: scoreMatch(r) }))
            .sort((a, b) => b.score - a.score);

        console.log('[malToKuronime] Scored results for "' + t + '":', scored.map(r => ({ name: r.name, score: r.score, href: r.href })));

        const best = scored[0];
        if (best && best.score > -100) {
            cache.set(ck, best.href, 86400);
            return best.href;
        }
    }
    return null;
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
        // Pakai searchKuronime yang sudah diperbaiki
        const results = await searchKuronime(q);

        // Juga test raw HTML untuk debug selector
        const html = await fetchHtml(`${BASE}/?s=${encodeURIComponent(q)}`);
        const $ = cheerio.load(html);
        const containers = [];
        $('article, .bs, .bsx, .searchlist, .result, .animes').each((_, el) => {
            containers.push($(el).attr('class') || $(el).prop('tagName'));
        });

        res.json({
            query: q,
            results,
            total: results.length,
            containers: [...new Set(containers)].slice(0, 20),
            searchUrl: `${BASE}/?s=${encodeURIComponent(q)}`
        });
    } catch(e) {
        res.json({ error: e.message });
    }
});

app.get('/debug-ep', async (req, res) => {
    const malId = req.query.mal || '20';
    const epNum = parseInt(req.query.ep || '1');
    try {
        const jData = await jikanFetch(malId);
        const title = jData?.data?.title || '';
        const titleEn = jData?.data?.title_english || '';

        // Search dengan title asli dan English
        const results = await searchKuronime(title);
        const resultsEn = titleEn ? await searchKuronime(titleEn) : [];
        const allResults = [...results, ...resultsEn].filter((r, i, arr) =>
            arr.findIndex(x => x.href === r.href) === i
        );

        // Pakai malToKuronime untuk matching yang lebih cerdas
        const animeUrl = await malToKuronime(malId);
        let epUrl = null;
        if (animeUrl) epUrl = await getEpisodeUrl(animeUrl, epNum);

        res.json({
            mal_id: malId,
            title,
            titleEn,
            searchResults: allResults.slice(0, 5),
            matchedAnimeUrl: animeUrl,
            epUrl,
            status: animeUrl ? 'found' : 'not_found'
        });
    } catch(e) {
        res.json({ error: e.message, stack: e.stack });
    }
});

app.get('/clear-cache', (_, res) => { cache.flushAll(); res.json({ ok: true }); });

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
