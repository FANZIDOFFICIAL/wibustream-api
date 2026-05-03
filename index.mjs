import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import * as cheerio from 'cheerio';

const app = express();
const cache = new NodeCache({ stdTTL: 1800 });
const PORT = process.env.PORT || 3000;

app.use(cors());

const BASE = 'https://gogoanimes.cv';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Referer': BASE + '/',
};

async function fetchHtml(url) {
    const res = await fetch(url, { headers: HEADERS });
    return res.text();
}

async function jikanGet(path) {
    const res = await fetch(`https://api.jikan.moe/v4${path}`);
    return res.json();
}

async function gogoSearch(title) {
    const ck = 'gogo:' + title;
    if (cache.has(ck)) return cache.get(ck);
    const html = await fetchHtml(`${BASE}/search.html?keyword=${encodeURIComponent(title)}`);
    const $ = cheerio.load(html);
    const results = [];
    $('.items li').each((_, el) => {
        const a = $(el).find('.name a');
        const id = a.attr('href')?.replace('/category/', '').trim();
        const name = a.text().trim();
        if (id) results.push({ id, name });
    });
    // fallback selector
    if (!results.length) {
        $('ul.items li, .anime_list_body li').each((_, el) => {
            const a = $(el).find('a');
            const href = a.attr('href') || '';
            const id = href.replace('/category/', '').replace('/', '').trim();
            const name = a.text().trim();
            if (id && href.includes('/category/')) results.push({ id, name });
        });
    }
    if (results.length) cache.set(ck, results, 86400);
    return results;
}

async function gogoEpisodes(animeId) {
    const ck = 'eplist:' + animeId;
    if (cache.has(ck)) return cache.get(ck);
    const html = await fetchHtml(`${BASE}/category/${animeId}`);
    const $ = cheerio.load(html);

    const movieId = $('#movie_id').val() || $('[name="movie_id"]').val() || '';
    const epStart = $('#episode_page a').first().attr('ep_start') || '0';
    const epEnd = $('#episode_page a').last().attr('ep_end') || '0';

    if (!movieId) return { error: 'movieId not found', html: html.substring(0, 800) };

    const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=${epStart}&ep_end=${epEnd}&id=${movieId}`;
    const listRes = await fetch(ajaxUrl, { headers: HEADERS });
    const listHtml = await listRes.text();
    const $2 = cheerio.load(listHtml);
    const eps = [];
    $2('#episode_related li').each((_, el) => {
        const href = $2(el).find('a').attr('href')?.trim();
        const num = parseFloat($2(el).find('.name').text().replace(/EP\s*/i, '').trim());
        if (href && !isNaN(num)) eps.push({ id: href.replace('/', ''), number: num });
    });
    eps.sort((a, b) => a.number - b.number);
    if (eps.length) cache.set(ck, eps, 3600);
    return eps;
}

async function gogoStream(epId) {
    const html = await fetchHtml(`${BASE}/${epId}`);
    const $ = cheerio.load(html);
    const embedUrl = $('.play-video iframe').attr('src') || $('iframe[src*="gogoanime"], iframe[src*="gogocdn"], iframe[src*="rapid"]').attr('src') || $('iframe').first().attr('src') || '';
    return embedUrl || null;
}

async function malToGogoSlug(malId) {
    const ck = 'slug:' + malId;
    if (cache.has(ck)) return cache.get(ck);
    const data = await jikanGet(`/anime/${malId}`);
    const title = data?.data?.title_english || data?.data?.title || '';
    if (!title) return null;
    const results = await gogoSearch(title);
    if (!results.length) return null;
    const slug = results.find(r => !r.id.includes('-dub'))?.id || results[0].id;
    cache.set(ck, slug, 86400);
    return slug;
}

async function getWatchSources(epId) {
    const [realId] = (epId + '|jikan').split('|');
    const m = realId.match(/mal-(\d+)-(\d+)/);
    const malId = m?.[1] ?? '';
    const epNum = parseFloat(m?.[2] ?? '1');
    if (!malId) return { sources: [], error: 'ID tidak valid' };

    const ck = 'watch:' + malId + ':' + epNum;
    if (cache.has(ck)) return cache.get(ck);

    try {
        const slug = await malToGogoSlug(malId);
        if (!slug) throw new Error('Anime tidak ditemukan');

        const episodes = await gogoEpisodes(slug);
        if (episodes?.error) throw new Error('gogoEpisodes: ' + episodes.error);

        const ep = episodes.find(e => e.number === epNum) || episodes[epNum - 1];
        if (!ep) throw new Error(`Episode ${epNum} tidak ditemukan dari ${episodes.length} ep`);

        const embedUrl = await gogoStream(ep.id);
        if (!embedUrl) throw new Error('Stream tidak ditemukan');

        const result = { sources: [{ url: embedUrl, label: 'GogoAnime', isM3U8: false }] };
        cache.set(ck, result);
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

app.get('/debug', async (req, res) => {
    const slug = req.query.slug || 'naruto';
    try {
        const html = await fetchHtml(`${BASE}/category/${slug}`);
        const $ = cheerio.load(html);
        const movieId = $('#movie_id').val() || $('[name="movie_id"]').val() || 'NOT FOUND';
        const epPages = [];
        $('#episode_page a').each((_, el) => epPages.push({ s: $(el).attr('ep_start'), e: $(el).attr('ep_end') }));
        const allInputs = [];
        $('input').each((_, el) => allInputs.push({ name: $(el).attr('name'), id: $(el).attr('id'), val: $(el).val() }));
        res.json({ movieId, epPages, allInputs, snippet: html.substring(0, 1000) });
    } catch(e) {
        res.json({ error: e.message });
    }
});

app.get('/debug-search', async (req, res) => {
    const q = req.query.q || 'naruto';
    try {
        const html = await fetchHtml(`${BASE}/search.html?keyword=${encodeURIComponent(q)}`);
        const $ = cheerio.load(html);
        const results = [];
        $('a[href*="/category/"]').each((_, el) => {
            results.push({ href: $(el).attr('href'), text: $(el).text().trim() });
        });
        res.json({ results: results.slice(0, 10), snippet: html.substring(0, 500) });
    } catch(e) {
        res.json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`WibuStream API on port ${PORT}`));
