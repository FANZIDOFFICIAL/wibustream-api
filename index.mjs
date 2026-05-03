import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import * as cheerio from 'cheerio';

const app = express();
const cache = new NodeCache({ stdTTL: 1800 });
const PORT = process.env.PORT || 3000;

app.use(cors());

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
};

async function jikanGet(path) {
    const res = await fetch(`https://api.jikan.moe/v4${path}`, { headers: HEADERS });
    return res.json();
}

async function gogoSearch(title) {
    const ck = 'gogo:' + title;
    if (cache.has(ck)) return cache.get(ck);
    const url = `https://gogoanimes.cv/search.html?keyword=${encodeURIComponent(title)}`;
    const res = await fetch(url, { headers: { ...HEADERS, Referer: 'https://gogoanimes.cv/' } });
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];
    $('.items li').each((_, el) => {
        const a = $(el).find('.name a');
        const id = a.attr('href')?.replace('/category/', '').trim();
        const name = a.text().trim();
        if (id) results.push({ id, name });
    });
    if (results.length) cache.set(ck, results, 86400);
    return results;
}

async function gogoEpisodes(animeId) {
    const ck = 'eplist:' + animeId;
    if (cache.has(ck)) return cache.get(ck);
    const res = await fetch(`https://gogoanimes.cv/category/${animeId}`, { headers: { ...HEADERS, Referer: 'https://gogoanimes.cv/' } });
    const html = await res.text();
    const $ = cheerio.load(html);
    const movieId = $('#movie_id').attr('value') || $('input#movie_id').val();
    const epStart = $('#episode_page a').first().attr('ep_start') || '0';
    const epEnd = $('#episode_page a').last().attr('ep_end') || '0';
    if (!movieId) return [];

    const listRes = await fetch(`https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=${epStart}&ep_end=${epEnd}&id=${movieId}`, {
        headers: { ...HEADERS, Referer: 'https://gogoanimes.cv/' }
    });
    const listHtml = await listRes.text();
    const $2 = cheerio.load(listHtml);
    const eps = [];
    $2('#episode_related li').each((_, el) => {
        const href = $2(el).find('a').attr('href')?.trim();
        const num = parseInt($2(el).find('.name').text().replace('EP', '').trim());
        if (href && !isNaN(num)) eps.push({ id: href.replace('/', ''), number: num });
    });
    eps.sort((a, b) => a.number - b.number);
    if (eps.length) cache.set(ck, eps, 3600);
    return eps;
}

async function gogoStream(epId) {
    const res = await fetch(`https://gogoanimes.cv/${epId}`, { headers: { ...HEADERS, Referer: 'https://gogoanimes.cv/' } });
    const html = await res.text();
    const $ = cheerio.load(html);
    const embedUrl = $('.play-video iframe').attr('src') || $('iframe').attr('src') || '';
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
    const epNum = parseInt(m?.[2] ?? '1');
    if (!malId) return { sources: [], error: 'ID tidak valid' };

    const ck = 'watch:' + malId + ':' + epNum;
    if (cache.has(ck)) return cache.get(ck);

    try {
        const slug = await malToGogoSlug(malId);
        if (!slug) throw new Error('Anime tidak ditemukan di GogoAnime');

        const episodes = await gogoEpisodes(slug);
        const ep = episodes.find(e => e.number === epNum) || episodes[epNum - 1];
        if (!ep) throw new Error('Episode tidak ditemukan');

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

app.listen(PORT, () => console.log(`WibuStream API on port ${PORT}`));
