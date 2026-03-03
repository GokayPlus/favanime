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

import "./style.css";

import { get as DataStoreGet, set as DataStoreSet } from "@api/DataStore";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { PluginNative } from "@utils/types";
import { User } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { Button, Forms, React, ScrollerThin, Text, TextInput, Toasts, useCallback, useEffect, UserStore, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.FavAnime as PluginNative<typeof import("./native")>;

const ProfileListClasses = findCssClassesLazy("empty", "textContainer", "connectionIcon");
const TabBarClasses = findCssClassesLazy("tabPanelScroller", "tabBarPanel");

// ==================== Constants ====================

const STORE_KEY_FAV = "FavAnime_favorites";
const STORE_KEY_HATE = "FavAnime_hated";
const STORE_KEY_TOKEN = "FavAnime_syncToken";
const logger = new Logger("FavAnime");

type ListMode = "fav" | "hate";

// ==================== Types ====================

interface AnimeData {
    mal_id: number;
    title: string;
    title_english: string | null;
    images: {
        jpg: {
            image_url: string;
            small_image_url: string;
            large_image_url: string;
        };
    };
    score: number | null;
    episodes: number | null;
    type: string;
    status: string;
    synopsis: string | null;
    year: number | null;
    genres: Array<{ mal_id: number; name: string; }>;
}

// ==================== Data Layer ====================

let cachedFavorites: AnimeData[] = [];
let cachedHated: AnimeData[] = [];

// Cache for remote users' full anime data fetched from server (keyed by Discord user ID)
const REMOTE_CACHE_MAX = 200;
const remoteAnimeCache = new Map<string, { favs: AnimeData[]; hated: AnimeData[]; fetchedAt: number; }>();
const REMOTE_CACHE_TTL = 120_000; // 2 minutes

function remoteCacheSet(userId: string, value: { favs: AnimeData[]; hated: AnimeData[]; fetchedAt: number; }) {
    if (remoteAnimeCache.size >= REMOTE_CACHE_MAX) {
        remoteAnimeCache.delete(remoteAnimeCache.keys().next().value!);
    }
    remoteAnimeCache.set(userId, value);
}

// Helper to slim down anime data before syncing (removes heavy fields)
function slimAnime(a: AnimeData): AnimeData {
    return {
        mal_id: a.mal_id,
        title: a.title,
        title_english: a.title_english,
        images: { jpg: { image_url: a.images.jpg.image_url, small_image_url: a.images.jpg.small_image_url, large_image_url: a.images.jpg.large_image_url } },
        score: a.score,
        episodes: a.episodes,
        type: a.type,
        status: a.status,
        synopsis: null,
        year: a.year,
        genres: [],
    };
}

async function loadFavorites(): Promise<AnimeData[]> {
    try {
        const data = await DataStoreGet(STORE_KEY_FAV) as AnimeData[] | undefined;
        cachedFavorites = data ?? [];
    } catch (e) {
        logger.error("Failed to load favorites:", e);
        cachedFavorites = [];
    }
    return cachedFavorites;
}

async function loadHated(): Promise<AnimeData[]> {
    try {
        const data = await DataStoreGet(STORE_KEY_HATE) as AnimeData[] | undefined;
        cachedHated = data ?? [];
    } catch (e) {
        logger.error("Failed to load hated:", e);
        cachedHated = [];
    }
    return cachedHated;
}

async function addFavorite(anime: AnimeData) {
    if (cachedFavorites.some(f => f.mal_id === anime.mal_id)) return;
    cachedFavorites = [...cachedFavorites, anime];
    await DataStoreSet(STORE_KEY_FAV, cachedFavorites);
    scheduleSyncToServer();
}

async function removeFavorite(malId: number) {
    cachedFavorites = cachedFavorites.filter(f => f.mal_id !== malId);
    await DataStoreSet(STORE_KEY_FAV, cachedFavorites);
    scheduleSyncToServer();
}

async function addHated(anime: AnimeData) {
    if (cachedHated.some(f => f.mal_id === anime.mal_id)) return;
    cachedHated = [...cachedHated, anime];
    await DataStoreSet(STORE_KEY_HATE, cachedHated);
    scheduleSyncToServer();
}

async function removeHated(malId: number) {
    cachedHated = cachedHated.filter(f => f.mal_id !== malId);
    await DataStoreSet(STORE_KEY_HATE, cachedHated);
    scheduleSyncToServer();
}

// ==================== Server Sync ====================

let syncToken: string | null = null;
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a sync after a short delay — resets if called again quickly (e.g. adding multiple anime) */
function scheduleSyncToServer() {
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null;
        syncToServer().catch(() => { });
    }, 2000);
}

async function loadSyncToken(): Promise<string> {
    if (syncToken) return syncToken;
    let token = await DataStoreGet(STORE_KEY_TOKEN) as string | undefined;
    if (!token) {
        // Generate a random token on first use
        const arr = new Uint8Array(24);
        crypto.getRandomValues(arr);
        token = Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
        await DataStoreSet(STORE_KEY_TOKEN, token);
    }
    syncToken = token;
    return token;
}

async function syncToServer(): Promise<boolean> {
    try {
        const token = await loadSyncToken();
        const userId = UserStore.getCurrentUser()?.id;
        if (!userId) { logger.error("Sync: no current user"); return false; }

        logger.info("Syncing to server...", { userId, favCount: cachedFavorites.length, hateCount: cachedHated.length });

        const result = await Native.syncAnimeList(
            userId,
            token,
            cachedFavorites.map(slimAnime),
            cachedHated.map(slimAnime),
        );

        if (!result.success) {
            logger.error("Sync failed:", result.error);
            return false;
        }
        return true;
    } catch (e) {
        logger.error("Sync exception:", e);
        return false;
    }
}

async function fetchRemoteAnimeList(userId: string): Promise<{ favs: AnimeData[]; hated: AnimeData[]; } | null> {
    const cached = remoteAnimeCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < REMOTE_CACHE_TTL) return cached;

    try {
        const data = await Native.fetchAnimeList(userId);
        const favs: AnimeData[] = data.favorites ?? [];
        const hated: AnimeData[] = data.hated ?? [];
        if (favs.length === 0 && hated.length === 0) return null;

        const result = { favs, hated, fetchedAt: Date.now() };
        remoteCacheSet(userId, result);
        return result;
    } catch (e) {
        logger.error(`Failed to fetch remote anime for ${userId}:`, e);
        return null;
    }
}

// ==================== MAL API ==

async function searchAnime(query: string): Promise<AnimeData[]> {
    if (!query.trim()) return [];
    try {
        const data = await Native.searchAnime(query);
        return (data ?? []) as AnimeData[];
    } catch (e) {
        logger.error("MAL search failed:", e);
        return [];
    }
}

async function fetchUserFavorites(username: string): Promise<AnimeData[]> {
    if (!username.trim()) return [];
    try {
        const data = await Native.fetchUserFavorites(username);
        return (data ?? []) as AnimeData[];
    } catch (e) {
        logger.error("MAL user favorites fetch failed:", e);
        return [];
    }
}

// ==================== Helpers ====================

function getAnimeTabText(favCount: number, hateCount: number) {
    const total = favCount + hateCount;
    return `Anime List (${total})`;
}

function useDebounce<T>(value: T, delay: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return debounced;
}

// ==================== Components ====================

// In-memory cache for proxied image data URLs (max 150 entries — base64 images are large)
const IMAGE_CACHE_MAX = 150;
const imageCache = new Map<string, string>();
function imageCacheSet(key: string, value: string) {
    if (imageCache.size >= IMAGE_CACHE_MAX) {
        // Evict oldest entry (Map preserves insertion order)
        imageCache.delete(imageCache.keys().next().value!);
    }
    imageCache.set(key, value);
}

// In-flight fetch deduplication — prevents N IPC calls for the same URL when a grid renders
const imageInflight = new Map<string, Promise<string>>();

function ProxiedImage({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
    const [dataUrl, setDataUrl] = useState<string>(imageCache.get(src ?? "") ?? "");

    useEffect(() => {
        if (!src) return;
        const cached = imageCache.get(src);
        if (cached) { setDataUrl(cached); return; }

        // Reuse existing in-flight promise for the same URL
        let promise = imageInflight.get(src);
        if (!promise) {
            promise = Native.fetchImage(src).catch(() => "");
            imageInflight.set(src, promise);
            promise.finally(() => imageInflight.delete(src));
        }
        let cancelled = false;
        promise.then(result => {
            if (!cancelled && result) {
                imageCacheSet(src, result);
                setDataUrl(result);
            }
        });
        return () => { cancelled = true; };
    }, [src]);

    if (!dataUrl) return <div style={{ width: "100%", height: "100%", background: "var(--background-secondary)" }} />;
    return <img src={dataUrl} alt={alt} {...props} />;
}

function AnimeCard({ anime, onAdd, onRemove, added, compact, hate }: {
    anime: AnimeData;
    onAdd?: () => void;
    onRemove?: () => void;
    added?: boolean;
    compact?: boolean;
    hate?: boolean;
}) {
    const title = anime.title_english || anime.title;
    const imgUrl = compact
        ? anime.images.jpg.image_url
        : (anime.images.jpg.large_image_url || anime.images.jpg.image_url);

    return (
        <div
            className={`vc-favanime-card${compact ? " vc-favanime-card-compact" : ""}${hate ? " vc-favanime-card-hate" : ""}`}
            onClick={() => window.open(`https://myanimelist.net/anime/${anime.mal_id}`, "_blank", "noopener,noreferrer")}
        >
            <div className="vc-favanime-card-poster">
                <ProxiedImage src={imgUrl} alt={title} loading="eager" />
                {!hate && anime.score != null && anime.score > 0 && (
                    <span className="vc-favanime-badge-score">★ {anime.score}</span>
                )}
                {onRemove && (
                    <button
                        className="vc-favanime-btn-remove"
                        onClick={e => { e.stopPropagation(); onRemove(); }}
                        title="Remove"
                    >✕</button>
                )}
                {onAdd && (
                    <button
                        className={`vc-favanime-btn-add${hate ? " vc-favanime-btn-add-hate" : ""}${added ? " vc-favanime-btn-added" : ""}`}
                        onClick={e => { e.stopPropagation(); if (!added) onAdd(); }}
                        title={added ? "Already added" : (hate ? "Add to hate list" : "Add to favorites")}
                    >{added ? "✓" : (hate ? "💔" : "+")}</button>
                )}
            </div>
            <div className="vc-favanime-card-info">
                <span className="vc-favanime-card-title" title={title}>{title}</span>
                <span className="vc-favanime-card-meta">
                    {anime.type ?? "?"}{anime.episodes ? ` · ${anime.episodes} Ep` : ""}{anime.year ? ` · ${anime.year}` : ""}
                </span>
            </div>
        </div>
    );
}

function AnimeSearchModal({ rootProps, onChanged, mode }: {
    rootProps: any;
    onChanged: () => void;
    mode: ListMode;
}) {
    const isHate = mode === "hate";
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<AnimeData[]>([]);
    const [loading, setLoading] = useState(false);
    const [addedIds, setAddedIds] = useState<Set<number>>(
        new Set((isHate ? cachedHated : cachedFavorites).map(f => f.mal_id))
    );
    const debouncedQuery = useDebounce(query, 400);

    useEffect(() => {
        if (!debouncedQuery.trim()) {
            setResults([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        searchAnime(debouncedQuery).then(data => {
            if (!cancelled) {
                setResults(data);
                setLoading(false);
            }
        });
        return () => { cancelled = true; };
    }, [debouncedQuery]);

    const handleAdd = useCallback(async (anime: AnimeData) => {
        if (isHate) {
            await addHated(anime);
            setAddedIds(new Set(cachedHated.map(f => f.mal_id)));
        } else {
            await addFavorite(anime);
            setAddedIds(new Set(cachedFavorites.map(f => f.mal_id)));
        }
        onChanged();
    }, [isHate, onChanged]);

    return (
        <ModalRoot {...rootProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    {isHate ? "💔 Add to Hate List" : "Search Anime — MyAnimeList"}
                </Text>
                <ModalCloseButton onClick={rootProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <div className="vc-favanime-search-container">
                    <TextInput
                        placeholder={isHate ? "Find an anime you hate..." : "Search anime"}
                        value={query}
                        onChange={setQuery}
                        autoFocus
                    />
                    {loading && (
                        <div className="vc-favanime-loading">
                            <div className="vc-favanime-spinner" />
                            <Text variant="text-md/medium">Searching...</Text>
                        </div>
                    )}
                    {!loading && results.length === 0 && debouncedQuery.trim() && (
                        <div className="vc-favanime-empty">
                            <Text variant="text-md/medium">No results for "{debouncedQuery}"</Text>
                        </div>
                    )}
                    {!loading && !debouncedQuery.trim() && (
                        <div className="vc-favanime-empty">
                            <div className="vc-favanime-empty-icon">{isHate ? "💔" : "🔍"}</div>
                            <Text variant="text-md/medium" style={{ color: "var(--text-muted)" }}>
                                {isHate ? "Search for anime you despise" : "Type above to find your favorite anime"}
                            </Text>
                        </div>
                    )}
                    {!loading && results.length > 0 && (
                        <div className="vc-favanime-search-grid">
                            {results.map(anime => (
                                <AnimeCard
                                    key={anime.mal_id}
                                    anime={anime}
                                    onAdd={() => handleAdd(anime)}
                                    added={addedIds.has(anime.mal_id)}
                                    hate={isHate}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

function MALImportSection({ onImport }: { onImport: () => void; }) {
    const [username, setUsername] = useState("");
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState("");

    const handleImport = useCallback(async () => {
        if (!username.trim()) return;
        setLoading(true);
        setMessage("");
        try {
            const animes = await fetchUserFavorites(username);
            if (animes.length === 0) {
                setMessage("No favorite anime found for this user.");
            } else {
                // Bulk-add to avoid N separate DataStore writes
                const existing = new Set(cachedFavorites.map(f => f.mal_id));
                const newAnimes = animes.filter(a => !existing.has(a.mal_id));
                if (newAnimes.length > 0) {
                    cachedFavorites = [...cachedFavorites, ...newAnimes];
                    await DataStoreSet(STORE_KEY_FAV, cachedFavorites);
                }
                setMessage(`${newAnimes.length} anime imported (${animes.length - newAnimes.length} already in list).`);
                scheduleSyncToServer();
                onImport();
            }
        } catch {
            setMessage("Import failed. Please check the username.");
        }
        setLoading(false);
    }, [username, onImport]);

    return (
        <div className="vc-favanime-import-section">
            <Forms.FormTitle tag="h3">Import from MAL</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 8 }}>
                Enter your MyAnimeList username to automatically import your favorite anime(s).
            </Forms.FormText>
            <div className="vc-favanime-import-row">
                <TextInput
                    placeholder="MAL username"
                    value={username}
                    onChange={setUsername}
                    style={{ flex: 1 }}
                />
                <Button
                    onClick={handleImport}
                    disabled={loading || !username.trim()}
                    size={Button.Sizes.SMALL}
                >
                    {loading ? "Importing..." : "Import"}
                </Button>
            </div>
            {message && (
                <Text variant="text-sm/medium" style={{ marginTop: 8, color: "var(--text-muted)" }}>
                    {message}
                </Text>
            )}
        </div>
    );
}

function openSearchModal(mode: ListMode, onChanged: () => void) {
    openModal(props => (
        <AnimeSearchModal rootProps={props} mode={mode} onChanged={onChanged} />
    ));
}

// ==================== Settings Panel ====================

function AnimeListSection({ title, mode, list, onRefresh }: {
    title: string;
    mode: ListMode;
    list: AnimeData[];
    onRefresh: () => void;
}) {
    const isHate = mode === "hate";

    const handleRemove = useCallback(async (malId: number) => {
        if (isHate) await removeHated(malId);
        else await removeFavorite(malId);
        onRefresh();
    }, [isHate, onRefresh]);

    return (
        <Forms.FormSection>
            <Forms.FormTitle tag="h3">{title}</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 12 }}>
                {isHate
                    ? "Anime you can’t stand — shown on your profile as a separate tab."
                    : "Search and add anime from MyAnimeList — shown on your profile."
                }
            </Forms.FormText>
            <Button
                onClick={() => openSearchModal(mode, onRefresh)}
                size={Button.Sizes.SMALL}
                color={isHate ? Button.Colors.RED : Button.Colors.BRAND}
            >
                {isHate ? "💔 Add Hated Anime" : "❤️ Add Favourites Anime"}
            </Button>

            {list.length > 0 ? (
                <div className="vc-favanime-settings-grid">
                    {list.map(anime => (
                        <AnimeCard
                            key={anime.mal_id}
                            anime={anime}
                            onRemove={() => handleRemove(anime.mal_id)}
                            hate={isHate}
                        />
                    ))}
                </div>
            ) : (
                <div className="vc-favanime-settings-empty">
                    <div className="vc-favanime-empty-icon">{isHate ? "💔" : "🎬"}</div>
                    <Text variant="text-md/medium" style={{ color: "var(--text-muted)" }}>
                        {isHate ? "No hated anime added yet." : "No favorites added yet. Use the button above to get started!"}
                    </Text>
                </div>
            )}
        </Forms.FormSection>
    );
}

function CloudSyncStatus() {
    const [syncing, setSyncing] = useState(false);
    const [lastResult, setLastResult] = useState<string>("");

    const handleSync = useCallback(async () => {
        if (cachedFavorites.length === 0 && cachedHated.length === 0) {
            Toasts.show({
                type: Toasts.Type.FAILURE,
                message: "No anime in your lists to sync!",
                id: Toasts.genId(),
            });
            return;
        }
        setSyncing(true);
        setLastResult("");
        const ok = await syncToServer();
        setSyncing(false);
        if (ok) {
            setLastResult("Synced successfully! Other FavAnime users can now see your list.");
            Toasts.show({ type: Toasts.Type.SUCCESS, message: "Anime list synced!", id: Toasts.genId() });
        } else {
            setLastResult("Sync failed. Please try again later.");
            Toasts.show({ type: Toasts.Type.FAILURE, message: "Sync failed!", id: Toasts.genId() });
        }
    }, []);

    return (
        <div className="vc-favanime-import-section">
            <Forms.FormTitle tag="h3">Sync to Server</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 8 }}>
                If you have problems with automatic sync, you can sync your anime lists manually to anachter.dev so other users with FavAnime can see them on your profile.
            </Forms.FormText>
            <Button
                onClick={handleSync}
                size={Button.Sizes.SMALL}
                color={Button.Colors.BRAND}
                disabled={syncing}
            >
                {syncing ? "Syncing..." : "Sync Now"}
            </Button>
            {lastResult && (
                <Text variant="text-sm/medium" style={{ marginTop: 8, color: "var(--text-muted)" }}>
                    {lastResult}
                </Text>
            )}
        </div>
    );
}

function SettingsPanel() {
    const [favorites, setFavorites] = useState<AnimeData[]>(cachedFavorites);
    const [hated, setHated] = useState<AnimeData[]>(cachedHated);

    const refreshAll = useCallback(() => {
        Promise.all([loadFavorites(), loadHated()]).then(([favs, hates]) => {
            setFavorites([...favs]);
            setHated([...hates]);
        });
    }, []);

    useEffect(() => { refreshAll(); }, []);

    return (
        <div className="vc-favanime-settings">
            <AnimeListSection
                title="❤️ Your Favorite Anime"
                mode="fav"
                list={favorites}
                onRefresh={refreshAll}
            />
            <div style={{ marginTop: 24, borderTop: "1px solid var(--background-modifier-accent)", paddingTop: 24 }}>
                <AnimeListSection
                    title="💔 Anime You Hate"
                    mode="hate"
                    list={hated}
                    onRefresh={refreshAll}
                />
            </div>
            <div style={{ marginTop: 24, borderTop: "1px solid var(--background-modifier-accent)", paddingTop: 8 }}>
                <MALImportSection onImport={refreshAll} />
            </div>
            <div style={{ marginTop: 24, borderTop: "1px solid var(--background-modifier-accent)", paddingTop: 8 }}>
                <CloudSyncStatus />
            </div>
        </div>
    );
}

// ==================== Plugin Definition ====================

const IS_PATCHED = Symbol("FavAnime.Patched");

export default definePlugin({
    name: "FavAnime",
    description: "Show your favorite (and most hated) anime on your Discord profile — powered by MyAnimeList via JikanAPI.",
    authors: [{ name: "canplus", id: 852614422235971655n }],

    settingsAboutComponent: () => <SettingsPanel />,

    async start() {
        await Promise.all([loadFavorites(), loadHated()]);
    },

    patches: [
        // User Profile Modal (v1)
        {
            find: ".BOT_DATA_ACCESS?(",
            replacement: [
                {
                    match: /\i\.useEffect.{0,100}(\i)\[0\]\.section/,
                    replace: "$self.pushSection($1,arguments[0].user);$&"
                },
                {
                    match: /\(0,\i\.jsx\)\(\i,\{items:\i,section:(\i)/,
                    replace: "$1==='ANIME_LIST'?$self.renderAnimeBoard(arguments[0]):$&"
                },
                // Reduce tab bar gap so our custom tab stays visible
                {
                    match: /className:\i\.\i(?=,type:"top")/,
                    replace: '$& + " vc-favanime-modal-tab-bar"',
                    noWarn: true
                }
            ]
        },
        // User Profile Modal v2
        {
            find: ".WIDGETS?",
            replacement: [
                {
                    match: /items:(\i),.+?(?=return\(0,\i\.jsxs?\)\("div)/,
                    replace: "$&$self.pushSection($1,arguments[0].user);"
                },
                {
                    match: /children:(?=\(0,\i\.jsxs?\)\(\i,\{.{0,200}?section:(\i))/,
                    replace: "$&$1==='ANIME_LIST'?$self.renderAnimeBoard(arguments[0]):"
                },
                // Reduce tab bar gap so our custom tab stays visible
                {
                    match: /type:"top",/,
                    replace: '$&className:"vc-favanime-modal-v2-tab-bar",'
                },
            ]
        },
    ],

    pushSection(sections: any[], user: User) {
        try {
            if (sections[IS_PATCHED]) return;

            const currentUser = UserStore.getCurrentUser();
            const isCurrentUser = !!currentUser && user.id === currentUser.id;

            if (isCurrentUser) {
                if (cachedFavorites.length === 0 && cachedHated.length === 0) return;
                sections[IS_PATCHED] = true;
                sections.splice(1, 0, {
                    text: getAnimeTabText(cachedFavorites.length, cachedHated.length),
                    section: "ANIME_LIST",
                });
            } else {
                // Check if we have cached server data for this user
                const cached = remoteAnimeCache.get(user.id);
                if (cached && Date.now() - cached.fetchedAt < REMOTE_CACHE_TTL) {
                    const total = cached.favs.length + cached.hated.length;
                    if (total === 0) return;
                    sections[IS_PATCHED] = true;
                    sections.splice(1, 0, {
                        text: `Anime List (${total})`,
                        section: "ANIME_LIST",
                    });
                } else {
                    // Always show the tab — actual data will be fetched when tab is clicked
                    sections[IS_PATCHED] = true;
                    sections.splice(1, 0, {
                        text: "Anime List",
                        section: "ANIME_LIST",
                    });
                }
            }
        } catch (e) {
            logger.error("Failed to push anime section:", e);
        }
    },

    renderAnimeBoard: ErrorBoundary.wrap(({ user, onClose }: { user: User; onClose: () => void; }) => {
        const currentUser = UserStore.getCurrentUser();
        const isCurrentUser = !!currentUser && !!user && user.id === currentUser.id;

        const [favList, setFavList] = useState<AnimeData[]>(isCurrentUser ? cachedFavorites : []);
        const [hateList, setHateList] = useState<AnimeData[]>(isCurrentUser ? cachedHated : []);
        const [loading, setLoading] = useState(!isCurrentUser);
        const [syncing, setSyncing] = useState(false);

        useEffect(() => {
            if (isCurrentUser) {
                loadFavorites().then(setFavList);
                loadHated().then(setHateList);
            } else {
                setLoading(true);
                fetchRemoteAnimeList(user.id).then(data => {
                    if (data) {
                        setFavList(data.favs);
                        setHateList(data.hated);
                    }
                    setLoading(false);
                });
            }
        }, [user.id]);

        const handleSync = useCallback(async () => {
            setSyncing(true);
            const ok = await syncToServer();
            setSyncing(false);
            if (ok) {
                Toasts.show({ type: Toasts.Type.SUCCESS, message: "Anime list synced!", id: Toasts.genId() });
            } else {
                Toasts.show({ type: Toasts.Type.FAILURE, message: "Sync failed!", id: Toasts.genId() });
            }
        }, []);

        const handleRemoveFav = useCallback(async (malId: number) => {
            await removeFavorite(malId);
            setFavList([...cachedFavorites]);
        }, []);

        const handleRemoveHate = useCallback(async (malId: number) => {
            await removeHated(malId);
            setHateList([...cachedHated]);
        }, []);

        const handleAddFav = useCallback(() => {
            openSearchModal("fav", () => loadFavorites().then(setFavList));
        }, []);

        const handleAddHate = useCallback(() => {
            openSearchModal("hate", () => loadHated().then(setHateList));
        }, []);

        if (loading) {
            return (
                <ScrollerThin className={TabBarClasses.tabPanelScroller} fade={true} onClose={onClose}>
                    <div className="vc-favanime-loading">
                        <div className="vc-favanime-spinner" />
                        <Text variant="text-md/medium">Loading anime list...</Text>
                    </div>
                </ScrollerThin>
            );
        }

        const content = (
            <div className="vc-favanime-board-content">
                {/* Favorites section */}
                <div className="vc-favanime-board-header">
                    <Text variant="text-xs/semibold" style={{ color: "var(--header-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>
                        ❤️
                    </Text>
                    {isCurrentUser && (
                        <Button size={Button.Sizes.MIN} color={Button.Colors.PRIMARY} onClick={handleAddFav}>Add</Button>
                    )}
                </div>
                {favList.length > 0 ? (
                    <div className="vc-favanime-board-grid">
                        {favList.map(anime => (
                            <AnimeCard key={anime.mal_id} anime={anime}
                                onRemove={isCurrentUser ? () => handleRemoveFav(anime.mal_id) : undefined}
                                compact />
                        ))}
                    </div>
                ) : (
                    <div className={ProfileListClasses.empty} style={{ padding: "16px 0" }}>
                        <div className={ProfileListClasses.textContainer}>
                            <BaseText tag="h3" size="md" weight="medium" style={{ color: "var(--text-strong)" }}>
                                {isCurrentUser ? "No favorites added yet." : "No favorite anime."}
                            </BaseText>
                        </div>
                    </div>
                )}

                {/* Hate section */}
                <div className="vc-favanime-board-divider" />
                <div className="vc-favanime-board-header">
                    <Text variant="text-xs/semibold" style={{ color: "var(--header-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>
                        💔
                    </Text>
                    {isCurrentUser && (
                        <Button size={Button.Sizes.MIN} color={Button.Colors.PRIMARY} onClick={handleAddHate}>Add</Button>
                    )}
                </div>
                {hateList.length > 0 ? (
                    <div className="vc-favanime-board-grid">
                        {hateList.map(anime => (
                            <AnimeCard key={anime.mal_id} anime={anime}
                                onRemove={isCurrentUser ? () => handleRemoveHate(anime.mal_id) : undefined}
                                compact hate />
                        ))}
                    </div>
                ) : (
                    <div className={ProfileListClasses.empty} style={{ padding: "16px 0" }}>
                        <div className={ProfileListClasses.textContainer}>
                            <BaseText tag="h3" size="md" weight="medium" style={{ color: "var(--text-strong)" }}>
                                {isCurrentUser ? "No hated anime added yet." : "No hated anime."}
                            </BaseText>
                        </div>
                    </div>
                )}
                {isCurrentUser && (
                    <div className="vc-favanime-board-divider" />
                )}
                {isCurrentUser && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.PRIMARY}
                            onClick={handleSync}
                            disabled={syncing}
                        >
                            {syncing ? "Syncing..." : "Sync Now"}
                        </Button>
                    </div>
                )}
            </div>
        );

        return (
            <ScrollerThin className={TabBarClasses.tabPanelScroller} fade={true} onClose={onClose}>
                {content}
            </ScrollerThin>
        );
    }),
});

// im just saying token for id, not discord token
