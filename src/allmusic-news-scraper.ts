import * as dotenv from 'dotenv';
dotenv.config();

import { supabase } from './supabase';
import * as cheerio from 'cheerio';

const CONCURRENCY   = parseInt(process.env.CONCURRENCY   || '5');
const PROFILE_LIMIT = parseInt(process.env.PROFILE_LIMIT || '0'); // 0 = all profiles
const WORKFLOW_ID   = process.env.WORKFLOW_ID ? parseInt(process.env.WORKFLOW_ID) : null;

const BASE_URL    = 'https://www.allmusic.com';
const FETCH_DELAY = 300; // ms between requests per worker — polite crawling

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SocialProfile {
    id: string;
    identifier: string | null;
    social_url: string | null;
    linked_talent: string | null;
    checked_allmusic_news: string | null;
}

interface ArticleStub {
    title: string;
    link: string; // absolute allmusic.com URL
}

interface ArticleFull extends ArticleStub {
    description: string | null;
    author: string | null;
    published: string | null;   // ISO string
    section: string | null;     // e.g. "Features", "Interviews"
    img: string | null;
    mnIds: string[];            // mn artist IDs found in article body links
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Normalise any AllMusic identifier format to lowercase mn{digits}
// Handles: full URL, bare ID (upper or lower case), slug-prefixed IDs
function extractMnId(identifier: string | null, socialUrl: string | null): string | null {
    for (const s of [socialUrl, identifier]) {
        if (!s) continue;
        const m = s.match(/mn\d+/i);
        if (m) return m[0].toLowerCase();
    }
    return null;
}

// Parse AllMusic's non-standard datePublished from JSON-LD:
// "2026-04-07UTC07:02:00-05:00" → valid ISO "2026-04-07T07:02:00-05:00"
function parseAllmusicDate(raw: string | null): string | null {
    if (!raw) return null;
    try {
        const iso = raw.replace(/UTC/, 'T');
        const d = new Date(iso);
        return isNaN(d.valueOf()) ? null : d.toISOString();
    } catch { return null; }
}

// Inline concurrency limiter
function createLimiter(concurrency: number) {
    let active = 0;
    const queue: (() => void)[] = [];
    return function limit<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            const run = async () => {
                active++;
                try   { resolve(await fn()); }
                catch (e) { reject(e); }
                finally {
                    active--;
                    if (queue.length > 0) queue.shift()!();
                }
            };
            active < concurrency ? run() : queue.push(run);
        });
    };
}

// Polite fetch with a User-Agent and small delay
async function fetchHtml(url: string, extraHeaders?: Record<string, string>): Promise<string | null> {
    await new Promise(r => setTimeout(r, FETCH_DELAY));
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                ...extraHeaders,
            },
        });
        if (!res.ok) {
            console.warn(`  [HTTP ${res.status}] ${url}`);
            return null;
        }
        return await res.text();
    } catch (e: any) {
        console.warn(`  [FETCH ERR] ${url}: ${e.message}`);
        return null;
    }
}

async function logWorkflowRun(status: string, durationSecs?: number, lastError?: string) {
    if (!WORKFLOW_ID) return;
    try {
        await supabase.rpc('log_workflow_run', {
            p_workflow_id:   WORKFLOW_ID,
            p_status:        status,
            p_duration_secs: durationSecs ?? null,
            p_last_error:    lastError    ?? null,
        });
    } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Step 1 — Fetch /articlesAjax endpoint, extract article stubs
// ---------------------------------------------------------------------------
// AllMusic dynamically loads the articles tab content via AJAX.
// The endpoint returns a plain HTML fragment — no JS execution needed.
// URL pattern: https://www.allmusic.com/artist/{mn}/articlesAjax
// Response contains: <div id="relatedArticles"><div class="blogEntry"><a href="/blog/post/...">
// ---------------------------------------------------------------------------

async function fetchArticleStubs(mnId: string): Promise<ArticleStub[]> {
    const artistUrl = `${BASE_URL}/artist/${mnId}`;
    const ajaxUrl   = `${artistUrl}/articlesAjax`;

    const html = await fetchHtml(ajaxUrl, {
        'Referer': artistUrl,
        'X-Requested-With': 'XMLHttpRequest',
    });
    if (!html) return [];

    const $ = cheerio.load(html);
    const stubs: ArticleStub[] = [];

    // Response fragment: #relatedArticles > .blogEntry > a
    // Fallback: any /blog/post/ link in case markup changes
    $('a[href*="/blog/post/"]').each((_, el) => {
        const href  = $(el).attr('href') || '';
        const title = $(el).text().trim();
        if (!title || !href) return;
        const link = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        stubs.push({ title, link });
    });

    return stubs;
}

// ---------------------------------------------------------------------------
// Step 2 — Fetch article page, extract full metadata via JSON-LD + hero image
// ---------------------------------------------------------------------------

async function fetchArticleFull(stub: ArticleStub): Promise<ArticleFull> {
    const html = await fetchHtml(stub.link);
    if (!html) return { ...stub, description: null, author: null, published: null, section: null, img: null, mnIds: [] };

    const $ = cheerio.load(html);

    // JSON-LD is the most reliable source for structured data
    let jsonLd: any = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const parsed = JSON.parse($(el).html() || '');
            if (parsed['@type'] === 'NewsArticle') jsonLd = parsed;
        } catch { /* malformed JSON-LD, skip */ }
    });

    const description  = jsonLd?.description   || $('meta[name="description"]').attr('content') || null;
    const author       = Array.isArray(jsonLd?.author)
        ? jsonLd.author.map((a: any) => a.name).join(', ')
        : (jsonLd?.author?.name || null);
    const published    = parseAllmusicDate(jsonLd?.datePublished || null);
    const section      = jsonLd?.articleSection || null;

    // Hero image — try JSON-LD image first, then first <img> in article body
    let img: string | null = null;
    const ldImg = jsonLd?.image;
    if (typeof ldImg === 'string') img = ldImg;
    else if (ldImg?.url) img = ldImg.url;
    if (!img) {
        const heroSrc = $('article img, .article-content img, .blog-content img').first().attr('src') || null;
        if (heroSrc) img = heroSrc.startsWith('http') ? heroSrc : `${BASE_URL}${heroSrc}`;
    }

    // Collect mn IDs from artist links in the article body
    // AllMusic artist link patterns: /artist/pearl-jam-mn0000037730 OR /artist/mn0000037730
    const mnIds: string[] = [];
    $('a[href*="/artist/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/mn\d+/i);
        if (m) mnIds.push(m[0].toLowerCase());
    });

    return {
        ...stub,
        description,
        author,
        published,
        section,
        img,
        mnIds: [...new Set(mnIds)],
    };
}

// ---------------------------------------------------------------------------
// Per-profile scrape
// ---------------------------------------------------------------------------

async function scrapeProfile(profile: SocialProfile): Promise<void> {
    const mnId = extractMnId(profile.identifier, profile.social_url);
    if (!mnId) {
        console.log(`[SKIP] No mn ID for linked_talent=${profile.linked_talent}`);
        await supabase.from('hb_socials')
            .update({ checked_allmusic_news: new Date().toISOString() })
            .eq('id', profile.id);
        return;
    }

    console.log(`[START] ${mnId} (last checked: ${profile.checked_allmusic_news || 'never'})`);

    try {
        // Step 1: get up to 10 article stubs from artist page
        const stubs = await fetchArticleStubs(mnId);
        console.log(`  [FOUND] ${mnId}: ${stubs.length} article links`);

        if (stubs.length === 0) return;

        // Step 2: batch-check which links are already in the news table
        const allLinks = stubs.map(s => s.link);
        const { data: existingRows } = await supabase
            .from('news')
            .select('id, source_link, tagged_talent, linked_talent_ids, internal_notes')
            .in('source_link', allLinks);

        const existingMap: Record<string, any> = Object.fromEntries(
            (existingRows || []).map(e => [e.source_link, e])
        );

        const newStubs = stubs.filter(s => !existingMap[s.link]);
        console.log(`  [NEW]   ${mnId}: ${newStubs.length} to fetch`);

        if (newStubs.length === 0) return;

        // Step 3: fetch full metadata for new articles only
        const fullArticles: ArticleFull[] = [];
        for (const stub of newStubs) {
            const full = await fetchArticleFull(stub);
            fullArticles.push(full);
        }

        // Step 4: batch-resolve mn IDs found in article bodies → talent UUIDs
        const allMnIds = [...new Set(fullArticles.flatMap(a => a.mnIds))];
        const mnToUuid: Record<string, string> = {};

        if (allMnIds.length > 0) {
            // Match by exact social_url ending in /artist/{mnId}
            // and by identifier field containing the mn number
            const [byUrl, byIdentifier] = await Promise.all([
                supabase
                    .from('hb_socials')
                    .select('social_url, linked_talent')
                    .not('linked_talent', 'is', null)
                    .in('social_url', allMnIds.map(id => `${BASE_URL}/artist/${id}`)),
                supabase
                    .from('hb_socials')
                    .select('identifier, linked_talent')
                    .not('linked_talent', 'is', null)
                    .in('identifier', allMnIds),
            ]);

            for (const row of (byUrl.data || [])) {
                const m = (row.social_url || '').match(/mn\d+/i);
                if (m && row.linked_talent) mnToUuid[m[0].toLowerCase()] = row.linked_talent;
            }
            for (const row of (byIdentifier.data || [])) {
                const m = (row.identifier || '').match(/mn\d+/i);
                if (m && row.linked_talent && !mnToUuid[m[0].toLowerCase()]) {
                    mnToUuid[m[0].toLowerCase()] = row.linked_talent;
                }
            }
        }

        // Step 5: build insert records
        const toInsert = fullArticles.map(article => {
            const talentUuids = article.mnIds.map(id => mnToUuid[id]).filter(Boolean);
            const taggedTalent = [...new Set([
                ...(profile.linked_talent ? [profile.linked_talent] : []),
                ...talentUuids,
            ])];

            const notes: string[] = [];
            if (!article.img) notes.push('image:no_thumbnail');

            return {
                article_title:     article.title,
                article_heading:   article.section,   // e.g. "Features", "Interviews"
                article:           article.description,
                source_name:       article.author ? `AllMusic — ${article.author}` : 'AllMusic',
                source_link:       article.link,
                image_primary:     article.img,
                published:         article.published,
                status:            'in progress',
                public_visible:    true,
                tagged_talent:     taggedTalent,
                tagged_media:      [],
                linked_talent_ids: article.mnIds,
                linked_media_ids:  [],
                internal_notes:    notes,
            };
        });

        if (toInsert.length > 0) {
            const { error } = await supabase.from('news').insert(toInsert);
            if (error) console.error(`  [ERR] ${mnId} insert:`, error.message);
            else       console.log(`  [INS] ${mnId}: inserted ${toInsert.length} articles`);
        }

        // Step 6: merge tags on existing articles that may now have this talent added
        const existingToUpdate = stubs
            .filter(s => existingMap[s.link])
            .map(s => existingMap[s.link])
            .filter(e => profile.linked_talent && !(e.tagged_talent || []).includes(profile.linked_talent));

        for (const e of existingToUpdate) {
            const combined = [...new Set([...(e.tagged_talent || []), profile.linked_talent!])];
            await supabase.from('news')
                .update({ tagged_talent: combined })
                .eq('id', e.id);
        }
        if (existingToUpdate.length > 0) {
            console.log(`  [UPD] ${mnId}: merged talent tag on ${existingToUpdate.length} existing articles`);
        }

    } catch (e: any) {
        console.error(`[FAIL] ${mnId}:`, e.message);
        throw e;
    } finally {
        await supabase.from('hb_socials')
            .update({ checked_allmusic_news: new Date().toISOString() })
            .eq('id', profile.id);
        console.log(`[DONE] ${mnId} — timestamp updated`);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeNews(): Promise<void> {
    const startTime = Date.now();
    console.log('=== AllMusic News Scraper ===');
    console.log(`Concurrency: ${CONCURRENCY} | Batch: ${PROFILE_LIMIT > 0 ? PROFILE_LIMIT : 'all'} profiles\n`);

    await logWorkflowRun('running');

    // Fetch profiles ordered by least-recently checked.
    // Filter by type IN ('allmusic', 'ALLMUSIC') so Postgres uses the btree index on `type`
    // (~36k rows) rather than doing a full 2.96M-row sequential scan via ILIKE on social_url.
    // PostgREST caps each request at 1000 rows, so paginate when PROFILE_LIMIT=0 (all).
    const BATCH_SIZE = 1000;
    const profiles: SocialProfile[] = [];

    if (PROFILE_LIMIT > 0) {
        const { data, error } = await supabase
            .from('hb_socials')
            .select('id, identifier, social_url, linked_talent, checked_allmusic_news')
            .in('type', ['allmusic', 'ALLMUSIC'])
            .order('checked_allmusic_news', { ascending: true, nullsFirst: true })
            .limit(PROFILE_LIMIT);

        if (error) {
            console.error('Error fetching profiles:', error);
            await logWorkflowRun('failure', 0, error.message);
            return;
        }
        profiles.push(...(data as SocialProfile[]));
    } else {
        // Paginate through all profiles
        let page = 0;
        while (true) {
            const { data, error } = await supabase
                .from('hb_socials')
                .select('id, identifier, social_url, linked_talent, checked_allmusic_news')
                .in('type', ['allmusic', 'ALLMUSIC'])
                .order('checked_allmusic_news', { ascending: true, nullsFirst: true })
                .range(page * BATCH_SIZE, (page + 1) * BATCH_SIZE - 1);

            if (error) {
                console.error(`Error fetching profiles (page ${page}):`, error);
                await logWorkflowRun('failure', 0, error.message);
                return;
            }
            if (!data || data.length === 0) break;
            profiles.push(...(data as SocialProfile[]));
            console.log(`  Fetched page ${page + 1}: ${data.length} profiles (running total: ${profiles.length})`);
            if (data.length < BATCH_SIZE) break; // last page
            page++;
        }
    }

    console.log(`Fetched ${profiles.length} AllMusic profiles.\n`);

    const limit = createLimiter(CONCURRENCY);
    let successCount = 0;
    let failureCount = 0;

    await Promise.all((profiles as SocialProfile[]).map(profile =>
        limit(async () => {
            try   { await scrapeProfile(profile); successCount++; }
            catch { failureCount++; }
        })
    ));

    const durationSecs = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n=== Done in ${durationSecs}s (${successCount} ok, ${failureCount} failed) ===`);

    await logWorkflowRun(
        failureCount > 0 ? 'partial' : 'success',
        durationSecs,
        failureCount > 0 ? `${failureCount} profiles failed` : undefined
    );
}

scrapeNews().catch(async (e) => {
    console.error('Fatal:', e);
    await logWorkflowRun('failure', 0, e.message);
    process.exit(1);
});
