const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 1800 });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const CONSUMET = 'https://consumet-api.onrender.com';
const JIKAN = 'https://api.jikan.moe/v4';

async function malToGogoSlug(malId) {
    const ck = 'slug:' + malId;
    if (cache.has(ck)) return cache.get(ck);
    try {
        const info = await axios.get(`${JIKAN}/anime/${malId}`, { timeout: 10000 });
        const title = info.data?.data?.title_english || info.data?.data?.title || '';
        if (!title) return null;

        const search = await axios.get(`${CONSUMET}/anime/gogoanime/${encodeURIComponent(title)}`, { timeout: 10000 });
        const results = search.data?.results || [];
        if (!results.length) return null;

        const match = results.find(r => !r.id.includes('-dub')) || results[0];
        cache.set(ck, match.id, 86400);
        return match.id;
    } catch (e) {
        return null;
    }
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

        const epListRes = await axios.get(`${CONSUMET}/anime/gogoanime/info/${encodeURIComponent(slug)}`, { timeout: 15000 });
        const episodes = epListRes.data?.episodes || [];
        const ep = episodes.find(e => e.number === epNum) || episodes[epNum - 1];
        if (!ep) throw new Error('Episode tidak ditemukan');

        const streamRes = await axios.get(`${CONSUMET}/anime/gogoanime/watch/${encodeURIComponent(ep.id)}`, { timeout: 15000 });
        const sources = (streamRes.data?.sources || []).map(s => ({
            url: s.url,
            label: s.quality || 'Auto',
            isM3U8: s.isM3U8 ?? s.url.includes('.m3u8')
        }));

        const result = { sources };
        if (sources.length) cache.set(ck, result);
        return result;

    } catch (e) {
        return { sources: [], error: e.message };
    }
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/watch', async (req, res) => {
    const id = req.query.id ?? '';
    if (!id) return res.json({ error: 'id required' });
    const data = await getWatchSources(id);
    res.json(data);
});

app.listen(PORT, () => console.log(`WibuStream API on port ${PORT}`));
