/*
 * FavAnime Cloudflare Worker — anachter.dev
 *
 * KV Namespace binding: FAVANIME_KV
 *
 * Data structure (per user):
 *   Key: "user:<discordUserId>"
 *   Value: JSON { token, favorites: AnimeEntry[], hated: AnimeEntry[], updatedAt }
 *
 *   AnimeEntry: { mal_id, title, image_url, score?, episodes?, status?, year? }
 *
 * API:
 *   GET  /api/favanime/:userId   — Public read, returns { favorites, hated }
 *   POST /api/favanime/sync      — Write with token auth
 *        Body: { userId, token, favorites: AnimeEntry[], hated: AnimeEntry[] }
 */

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

/** Keep only the fields we care about, discard the rest */
function slimAnime(a) {
    if (!a || typeof a !== "object") return null;
    // Support both flat image_url and nested images.jpg.image_url (sent by client)
    const image_url = (typeof a.image_url === "string" && a.image_url)
        ? a.image_url
        : (a.images?.jpg?.image_url ?? "");
    const entry = { mal_id: a.mal_id, title: a.title, image_url };
    if (a.score != null) entry.score = a.score;
    if (a.episodes != null) entry.episodes = a.episodes;
    if (a.status != null) entry.status = a.status;
    if (a.type != null) entry.type = a.type;
    if (a.year != null) entry.year = a.year;
    return entry;
}

/** Validate a slim anime entry */
function isValidEntry(a) {
    if (!a || typeof a !== "object") return false;
    // mal_id must be a positive integer
    if (!Number.isInteger(a.mal_id) || a.mal_id <= 0 || a.mal_id > 1_000_000) return false;
    if (typeof a.title !== "string" || a.title.length === 0 || a.title.length > 300) return false;
    // Restrict image URLs to MAL CDN only — prevents SSRF via Native.fetchImage
    if (typeof a.image_url !== "string") return false;
    if (a.image_url.length > 512) return false;
    if (!/^https:\/\/(cdn\.)?myanimelist\.net\/images\//.test(a.image_url)) return false;
    if (a.score != null && (typeof a.score !== "number" || isNaN(a.score) || a.score < 0 || a.score > 10)) return false;
    if (a.episodes != null && (!Number.isInteger(a.episodes) || a.episodes < 0 || a.episodes > 10_000)) return false;
    if (a.status != null && (typeof a.status !== "string" || a.status.length > 50)) return false;
    if (a.type != null && (typeof a.type !== "string" || a.type.length > 50)) return false;
    if (a.year != null && (!Number.isInteger(a.year) || a.year < 1900 || a.year > 2200)) return false;
    return true;
}

export default {
    async fetch(request, env) {
        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        // GET /api/favanime/:userId — public read
        const getMatch = path.match(/^\/api\/favanime\/(\d{17,20})$/);
        if (getMatch && request.method === "GET") {
            const userId = getMatch[1];
            const raw = await env.FAVANIME_KV.get(`user:${userId}`, "json");
            if (!raw) {
                return json({ favorites: [], hated: [] });
            }
            // Re-validate stored entries in case of old format or corruption
            const favs = Array.isArray(raw.favorites) ? raw.favorites.filter(isValidEntry) : [];
            const hateds = Array.isArray(raw.hated) ? raw.hated.filter(isValidEntry) : [];
            return json({ favorites: favs, hated: hateds });
        }

        // POST /api/favanime/sync — write with token
        if (path === "/api/favanime/sync" && request.method === "POST") {
            // Reject oversized bodies early (100 KB limit)
            const contentLength = request.headers.get("content-length");
            if (contentLength && parseInt(contentLength, 10) > 100 * 1024) {
                return json({ error: "Request body too large" }, 413);
            }

            let body;
            try {
                const text = await request.text();
                if (text.length > 100 * 1024) return json({ error: "Request body too large" }, 413);
                body = JSON.parse(text);
            } catch {
                return json({ error: "Invalid JSON body" }, 400);
            }

            // JSON.parse can return null, a number, etc. — must be a plain object
            if (!body || typeof body !== "object" || Array.isArray(body)) {
                return json({ error: "Body must be a JSON object" }, 400);
            }

            const { userId, token, favorites, hated } = body;

            // Validate input
            if (!userId || typeof userId !== "string" || !/^\d{17,20}$/.test(userId)) {
                return json({ error: "Invalid userId" }, 400);
            }
            if (!token || typeof token !== "string" || token.length < 16 || token.length > 128) {
                return json({ error: "Invalid token" }, 400);
            }
            if (!Array.isArray(favorites) || !Array.isArray(hated)) {
                return json({ error: "favorites and hated must be arrays" }, 400);
            }

            // Check raw size BEFORE processing to avoid wasted CPU on huge inputs
            if (favorites.length > 100 || hated.length > 100) {
                return json({ error: "Maximum 100 items per list" }, 400);
            }

            // Validate and slim entries
            const slimFavs = favorites.map(slimAnime).filter(isValidEntry);
            const slimHated = hated.map(slimAnime).filter(isValidEntry);

            // Check existing record
            const existing = await env.FAVANIME_KV.get(`user:${userId}`, "json");

            if (existing && existing.token !== token) {
                // Token mismatch — someone else already claimed this userId
                return json({ error: "Unauthorized: token mismatch" }, 403);
            }

            // Save
            const record = {
                token,
                favorites: slimFavs,
                hated: slimHated,
                updatedAt: new Date().toISOString(),
            };

            await env.FAVANIME_KV.put(`user:${userId}`, JSON.stringify(record));

            return json({ success: true });
        }

        // 404 fallback
        return json({ error: "Not found" }, 404);
    },
};

// im just saying token for id, not discord token
