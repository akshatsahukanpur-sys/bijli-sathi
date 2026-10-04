/**
 * Geo search proxy — merges Nominatim + Photon (both keyless) server-side.
 * Backend proxy avoids browser UA/rate issues; Kanpur-biased.
 */
const express = require('express');
const router = express.Router();

const UA = 'BijliSathi/1.0 (KESCO Kanpur complaint platform; contact: helpline@bijlisathi.com)';

async function fetchJson(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 120).trim();
  const lim = Math.min(8, Math.max(1, parseInt(req.query.limit) || 8));
  if (q.length < 2) return res.json({ success: true, results: [] });

  // Improved: Kanpur viewbox boost (bounded=0 -> prioritizes Kanpur but allows India-wide), plus higher limit and dedupe
  const kanpurViewbox = 'viewbox=79.9,26.9,80.7,26.2&bounded=0';
  const [nominatim, photon] = await Promise.all([
    fetchJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=${lim}&accept-language=en&addressdetails=1&countrycodes=in&${kanpurViewbox}&dedupe=1`),
    fetchJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${lim}&bbox=68.0,6.0,97.0,35.0`),
  ]);

  const merged = [];
  const seen = new Set();
  const push = (name, lat, lon, type) => {
    if (!name || lat == null || lon == null) return;
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ display_name: name, lat: String(lat), lon: String(lon), type: type || 'place' });
  };

  for (const r of Array.isArray(nominatim) ? nominatim : []) {
    push(r.display_name, parseFloat(r.lat), parseFloat(r.lon), r.type);
  }
  for (const f of photon?.features || []) {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    const name = [p.name, p.street, p.district || p.county, p.city || p.state].filter(Boolean).join(', ');
    push(name, lat, lon, p.osm_value || 'place');
  }

  res.json({ success: true, results: merged.slice(0, 8) });
});

router.get('/reverse', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return res.json({ success: false, area: '' });
    const data = await fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1&accept-language=en`);
    if (!data?.address) return res.json({ success: false, area: '' });
    const a = data.address;
    const area = [a.neighbourhood || a.suburb || a.hamlet || a.village || a.road, a.city || a.town || a.county || 'Kanpur'].filter(Boolean).join(', ');
    res.json({ success: true, area: area || String(data.display_name || '').slice(0, 80) });
  } catch (e) {
    res.json({ success: false, area: '' });
  }
});

module.exports = router;
