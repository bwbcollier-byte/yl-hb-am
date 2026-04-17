import * as dotenv from 'dotenv';
dotenv.config();

import { supabase } from './supabase';
import * as cheerio from 'cheerio';

const MAX_PAGES  = parseInt(process.env.MAX_PAGES  || '1');  // blog listing pages to check
const WORKFLOW_ID = process.env.WORKFLOW_ID ? parseInt(process.env.WORKFLOW_ID) : null;

const BASE_URL   = 'https://www.allmusic.com';
const BLOG_URL   = `${BASE_URL}/blog`;
const FETCH_DELAY = 500; // ms — polite crawling

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlogPostStub {
    title:   string;
    link:    string;    // absolute URL
    img:     string | null;
    author:  string | null;
    dateStr: string | null;
}

interface ArticleFull extends BlogPostStub {
    description: string | null;
    published:   string | null;   // ISO string
    section:     string | null;   // e.g. "Features", "Interviews"
    mnIds:       string[];        // AllMusic artist mn IDs found in article body
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchHtml(url: string, extraHeaders?: Record<string, string>): Promise<string | null> {
    await new Promise(r => setTimeout(r, FETCH_DELAY));
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

// Parse AllMusic's non-standard datePublished: "2026-04-07UTC07:02:00-05:00" → ISO string
function parseAllmusicDate(raw: string | null): string | null {
    if (!raw) return null;
    try {
        const iso = raw.replace(/UTC/, 'T');
        const d = new Date(iso);
        return isNaN(d.valueOf()) ? null : d.toISOString();
    } catch { return null; }
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
// Step 1 — Parse blog listing page → article stubs
// ---------------------------------------------------------------------------

async function fetchBlogPage(pageUrl: string): Promise<BlogPostStub[]> {
    const html = await fetchHtml(pageUrl, { 'Referer': BASE_URL });
    if (!html) return [];

    const $ = cheerio.load(html);
    const stubs: BlogPostStub[] = [];

    $('.blogArticle').each((_, el) => {
        const $el    = $(el);
        const href   = $el.find('.articleTitle a').attr('href');
        const title  = $el.find('.articleTitle a').text().trim();
        const img    = $el.find('img[data-src]').attr('data-src') || null;
        const byline = $el.find('.articleByline').text().trim();
        const author = byline.replace(/^By\s+/i, '').trim() || null;
        const dateStr = $el.find('.articleDate').text().trim() || null;

        if (!href || !title) return;
        const link = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        stubs.push({ title, link, img, author, dateStr });
    });

    return stubs;
}

// ---------------------------------------------------------------------------
// Step 2 — Fetch full article page → metadata + artist mn IDs
// ---------------------------------------------------------------------------

async function fetchArticleFull(stub: BlogPostStub): Promise<ArticleFull> {
    const html = await fetchHtml(stub.link, { 'Referer': BLOG_URL });
    if (!html) return { ...stub, description: null, published: null, section: null, mnIds: [] };

    const $ = cheerio.load(html);

    // JSON-LD is the most reliable source for structured metadata
    let jsonLd: any = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const parsed = JSON.parse($(el).html() || '');
            if (parsed['@type'] === 'NewsArticle') jsonLd = parsed;
        } catch { /* malformed JSON-LD, skip */ }
    });

    const description = jsonLd?.description || $('meta[name="description"]').attr('content') || null;
    const published   = parseAllmusicDate(jsonLd?.datePublished || null);
    const section     = jsonLd?.articleSection || null;

    // Prefer JSON-LD author over byline text (more structured)
    let author = stub.author;
    if (jsonLd?.author) {
        author = Array.isArray(jsonLd.author)
            ? jsonLd.author.map((a: any) => a.name).join(', ')
            : (jsonLd.author?.name || author);
    }

    // Prefer JSON-LD image, then data-src from listing, then first article body img
    let img = stub.img;
    const ldImg = jsonLd?.image;
    if (typeof ldImg === 'string') img = ldImg;
    else if (ldImg?.url) img = ldImg.url;
    if (!img) {
        const heroSrc = $('article img, .article-content img, .blog-content img').first().attr('src') || null;
        if (heroSrc) img = heroSrc.startsWith('http') ? heroSrc : `${BASE_URL}${heroSrc}`;
    }

    // Collect mn IDs from artist links in article body
    // AllMusic URL patterns: /artist/pearl-jam-mn0000037730  or  /artist/mn0000037730
    const mnIds: string[] = [];
    $('a[href*="/artist/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/mn\d+/i);
        if (m) mnIds.push(m[0].toLowerCase());
    });

    return { ...stub, img, author, description, published, section, mnIds: [...new Set(mnIds)] };
}

// ---------------------------------------------------------------------------
// Step 3 — Resolve mn IDs → hb_talent UUIDs via hb_socials
// ---------------------------------------------------------------------------

async function resolveMnIdsToUuids(mnIds: string[]): Promise<Record<string, string>> {
    if (mnIds.length === 0) return {};

    const [byUrl, byIdentifier] = await Promise.all([
        supabase
            .from('hb_socials')
            .select('social_url, linked_talent')
            .not('linked_talent', 'is', null)
            .in('social_url', mnIds.map(id => `${BASE_URL}/artist/${id}`)),
        supabase
            .from('hb_socials')
            .select('identifier, linked_talent')
            .not('linked_talent', 'is', null)
            .in('identifier', mnIds),
    ]);

    const mnToUuid: Record<string, string> = {};
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
    return mnToUuid;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeBlog(): Promise<void> {
    const startTime = Date.now();
    console.log('=== AllMusic Blog News Scraper ===');
    console.log(`Checking ${MAX_PAGES} blog page(s)\n`);

    await logWorkflowRun('running');

    // -- Collect article stubs from blog listing pages --
    const allStubs: BlogPostStub[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        // AllMusic blog pagination uses ?page=N (1-indexed)
        const pageUrl = page === 1 ? BLOG_URL : `${BLOG_URL}?page=${page}`;
        console.log(`Fetching blog page ${page}: ${pageUrl}`);
        const stubs = await fetchBlogPage(pageUrl);
        console.log(`  Found ${stubs.length} article(s)`);
        if (stubs.length === 0) break; // no more pages
        allStubs.push(...stubs);
    }

    console.log(`\nTotal articles found: ${allStubs.length}`);
    if (allStubs.length === 0) {
        await logWorkflowRun('success', 0);
        return;
    }

    // -- De-dupe against news table by source_link --
    const { data: existing } = await supabase
        .from('news')
        .select('source_link')
        .in('source_link', allStubs.map(s => s.link));

    const existingLinks = new Set((existing || []).map(e => e.source_link));
    const newStubs = allStubs.filter(s => !existingLinks.has(s.link));

    console.log(`Already in DB: ${allStubs.length - newStubs.length} | New to process: ${newStubs.length}\n`);

    if (newStubs.length === 0) {
        console.log('Nothing new — all articles already in the database.');
        await logWorkflowRun('success', Math.round((Date.now() - startTime) / 1000));
        return;
    }

    // -- Fetch full metadata and insert each new article --
    let insertedCount = 0;
    let failedCount   = 0;

    for (const stub of newStubs) {
        console.log(`[FETCH] ${stub.title}`);
        const article = await fetchArticleFull(stub);
        console.log(`  artists found: [${article.mnIds.join(', ')}]`);

        // Resolve mn IDs to hb_talent UUIDs
        const mnToUuid    = await resolveMnIdsToUuids(article.mnIds);
        const talentUuids = [...new Set(article.mnIds.map(id => mnToUuid[id]).filter(Boolean))];
        console.log(`  linked talent UUIDs: ${talentUuids.length}`);

        const notes: string[] = [];
        if (!article.img) notes.push('image:no_thumbnail');

        const record = {
            article_title:     article.title,
            article_heading:   article.section,
            article:           article.description,
            source_name:       article.author ? `AllMusic — ${article.author}` : 'AllMusic',
            source_link:       article.link,
            image_primary:     article.img,
            published:         article.published,
            status:            'in progress',
            public_visible:    true,
            tagged_talent:     talentUuids,
            tagged_media:      [],
            linked_talent_ids: article.mnIds,
            linked_media_ids:  [],
            internal_notes:    notes,
        };

        const { error } = await supabase.from('news').insert(record);
        if (error) {
            console.error(`  [ERR] ${error.message}`);
            failedCount++;
        } else {
            console.log(`  [INS] OK — tagged ${talentUuids.length} artist(s)`);
            insertedCount++;
        }
    }

    const durationSecs = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n=== Done in ${durationSecs}s | Inserted: ${insertedCount} | Failed: ${failedCount} ===`);

    await logWorkflowRun(
        failedCount > 0 ? 'partial' : 'success',
        durationSecs,
        failedCount > 0 ? `${failedCount} inserts failed` : undefined,
    );
}

scrapeBlog().catch(async (e) => {
    console.error('Fatal:', e);
    await logWorkflowRun('failure', 0, e.message);
    process.exit(1);
});
