/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { IpcMainInvokeEvent } from "electron";

const API_BASE = "https://api.anachter.dev/api/favanime";
const JIKAN_API = "https://api.jikan.moe/v4";

// ==================== Server Sync ====================

export async function syncAnimeList(
    _: IpcMainInvokeEvent,
    userId: string,
    token: string,
    favorites: any[],
    hated: any[]
): Promise<{ success: boolean; error?: string; }> {
    try {
        const res = await fetch(`${API_BASE}/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, token, favorites, hated }),
        });
        if (res.ok) return { success: true };
        // Only parse body on error to get error message
        try {
            const data = await res.json();
            return { success: false, error: data.error ?? `HTTP ${res.status}` };
        } catch {
            return { success: false, error: `HTTP ${res.status}` };
        }
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Reconstruct full AnimeData shape from flat server entry */
function reconstructAnime(a: any): any {
    if (!a || typeof a !== "object") return null;
    if (!Number.isInteger(a.mal_id) || a.mal_id <= 0) return null;
    if (typeof a.title !== "string" || !a.title) return null;
    const image_url = typeof a.image_url === "string" ? a.image_url : "";
    return {
        mal_id: a.mal_id,
        title: a.title,
        title_english: null,
        images: { jpg: { image_url, small_image_url: image_url, large_image_url: image_url } },
        score: a.score ?? null,
        episodes: a.episodes ?? null,
        type: a.type ?? "TV",
        status: a.status ?? "",
        synopsis: null,
        year: a.year ?? null,
        genres: [],
    };
}

export async function fetchAnimeList(
    _: IpcMainInvokeEvent,
    userId: string
): Promise<{ favorites: any[]; hated: any[]; }> {
    try {
        const res = await fetch(`${API_BASE}/${userId}`);
        if (!res.ok) return { favorites: [], hated: [] };
        const cl = res.headers.get("content-length");
        if (cl && parseInt(cl, 10) > MAX_RESPONSE_BYTES) return { favorites: [], hated: [] };
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) return { favorites: [], hated: [] };
        const data = JSON.parse(text);
        return {
            favorites: (data.favorites ?? []).map(reconstructAnime).filter(Boolean),
            hated: (data.hated ?? []).map(reconstructAnime).filter(Boolean),
        };
    } catch {
        return { favorites: [], hated: [] };
    }
}

// ==================== Jikan / MAL API ====================

export async function searchAnime(
    _: IpcMainInvokeEvent,
    query: string
): Promise<any[]> {
    if (!query.trim()) return [];
    if (query.length > 200) return [];
    try {
        const res = await fetch(
            `${JIKAN_API}/anime?q=${encodeURIComponent(query)}&limit=12&sfw=true`
        );
        if (!res.ok) return [];
        const cl = res.headers.get("content-length");
        if (cl && parseInt(cl, 10) > MAX_RESPONSE_BYTES) return [];
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) return [];
        const json = JSON.parse(text);
        return json.data ?? [];
    } catch {
        return [];
    }
}

export async function fetchUserFavorites(
    _: IpcMainInvokeEvent,
    username: string
): Promise<any[]> {
    if (!username.trim()) return [];
    if (username.length > 100) return [];
    try {
        const res = await fetch(
            `${JIKAN_API}/users/${encodeURIComponent(username)}/favorites`
        );
        if (!res.ok) return [];
        const cl = res.headers.get("content-length");
        if (cl && parseInt(cl, 10) > MAX_RESPONSE_BYTES) return [];
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) return [];
        const json = JSON.parse(text);
        return (json.data?.anime ?? []).map((a: any) => ({
            mal_id: a.mal_id,
            title: a.title,
            title_english: null,
            images: a.images,
            score: null,
            episodes: null,
            type: a.type ?? "Anime",
            status: "",
            synopsis: null,
            year: a.start_year ?? null,
            genres: [],
        }));
    } catch {
        return [];
    }
}

// ==================== Image Proxy ====================

const ALLOWED_IMAGE_HOSTS = ["https://cdn.myanimelist.net/", "https://myanimelist.net/images/"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

function isAllowedImageUrl(url: string): boolean {
    return ALLOWED_IMAGE_HOSTS.some(host => url.startsWith(host));
}

export async function fetchImage(
    _: IpcMainInvokeEvent,
    url: string
): Promise<string> {
    // SSRF protection — only allow MAL image URLs
    if (typeof url !== "string" || !isAllowedImageUrl(url)) return "";
    try {
        const res = await fetch(url, {
            redirect: "follow",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Referer": "https://myanimelist.net/",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            }
        });
        if (!res.ok) return "";
        // Validate final URL after redirects to prevent redirect-based SSRF
        if (!isAllowedImageUrl(res.url)) return "";
        // Content-type must be an image
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) return "";
        // Guard against response size bombs
        const contentLength = res.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) return "";
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) return "";
        const buffer = Buffer.from(arrayBuffer);
        return `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch {
        return "";
    }
}
