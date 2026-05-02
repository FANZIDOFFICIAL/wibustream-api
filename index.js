import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import { ANIME } from '@consumet/extensions';

const app = express();
const cache = new NodeCache({ stdTTL: 1800 });
const PORT = process.env.PORT || 3000;
const gogoanime = new ANIME.Gogoanime();

app.use(cors());
app.use(express.json());

async function malToGogoSlug(malId) {
    const ck = 'slug:' + malId;
    if (cache.has(ck)) return cache.get(ck);
    try {
        const res = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
        const data = await res.json();
        const title = data?.data?.title_english || data?.data?.title || '';
        if (!title) return null;

        const results = await gogoanime.search(title);
        if (!results?.results?.length) return null;

        const match = results.results.find(r => !r.id.includes('-dub')) || results.results[0];
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
        if (!slug) throw new Error('Anime tidak ditemukan');

        const info = await gogoanime.fetchAnimeInfo(slug);
        const episodes = info?.episodes || [];
        const ep = episodes.find(e => e.number === epNum) || episodes[epNum - 1];
        if (!ep) throw new Error('Episode tidak ditemukan');

        const stream = await gogoanime.fetchEpisodeSources(ep.id);
        const sources = (stream?.sources || []).map(s => ({
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
