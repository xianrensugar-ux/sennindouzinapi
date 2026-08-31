import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Requested-With']
}));

const memoryCache = new Map();
async function getCryptoKey(hexKey) {
    const keyBytes = new Uint8Array(hexKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    return await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-CBC' },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptBuffer(arrayBuffer, keyHex) {
    const key = await getCryptoKey(keyHex);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv },
        key,
        arrayBuffer
    );
    
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    return result;
}

async function decryptBuffer(encryptedBytes, keyHex) {
    const key = await getCryptoKey(keyHex);
    const iv = encryptedBytes.slice(0, 16);
    const data = encryptedBytes.slice(16);
    
    return await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv },
        key,
        data
    );
}

// 画像キャッシュ登録処理
async function registerImageProxy(url, env, baseUrl) {
    if (!url) return null;
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://momon-ga.com/'
            }
        });

        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await response.arrayBuffer();
        
        const keyHex = env.ENCRYPTION_KEY_HEX || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const encryptedBytes = await encryptBuffer(arrayBuffer, keyHex);

        const imageId = crypto.randomUUID().replace(/-/g, '');

        // KVがバインドされている場合はKVを使用、なければメモリ領域に保持
        if (env.IMAGE_CACHE) {
            await env.IMAGE_CACHE.put(imageId, encryptedBytes, {
                expirationTtl: 180, // 3分間保持
                metadata: { contentType }
            });
        } else {
            memoryCache.set(imageId, {
                buffer: encryptedBytes,
                contentType: contentType
            });
            setTimeout(() => memoryCache.delete(imageId), 180000);
        }

        return `${baseUrl}/api/image/${imageId}`;

    } catch (e) {
        console.error(`Image Cache Error: ${url}`, e.message);
        return null;
    }
}

// 検索 API
app.get('/api/search', async (c) => {
    const query = c.req.query('q');
    if (!query) return c.json({ result: [] });

    try {
        const targetUrl = `https://momon-ga.com/?s=${encodeURIComponent(query)}`;
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
            }
        });

        const html = await response.text();
        const tasks = [];
        const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img src="([^"]+)"[\s\S]*?alt="([^"]+)"/g;

        let match;
        const originUrl = new URL(c.req.url).origin;

        while ((match = postRegex.exec(html)) !== null) {
            const id = match[1];
            const imgUrl = match[2];
            const title = match[3];

            tasks.push((async () => {
                const proxyImageUrl = await registerImageProxy(imgUrl, c.env, originUrl);
                return {
                    id: id,
                    image: proxyImageUrl,
                    title: title,
                    rule: ""
                };
            })());
        }

        const results = await Promise.all(tasks);
        return c.json({ result: results });

    } catch (error) {
        console.error("Search API Error:", error.message);
        return c.json({ error: "Search failed" }, 500);
    }
});

// 詳細取得 API
app.get('/api/proxy-details', async (c) => {
    const id = c.req.query('id');
    if (!id) return c.text("ID is required", 400);

    const targetUrl = `https://momon-ga.com/fanzine/${id}`;

    try {
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const htmlString = await response.text();
        const imgUrls = [];
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;

        let match;
        while ((match = galleryRegex.exec(htmlString)) !== null) {
            let src = match[1];
            if (src.startsWith('/')) {
                src = 'https://momon-ga.com' + src;
            }
            imgUrls.push(src);
        }

        const uniqueImgUrls = [...new Set(imgUrls)];
        const originUrl = new URL(c.req.url).origin;

        const proxyImageUrls = await Promise.all(
            uniqueImgUrls.map(url => registerImageProxy(url, c.env, originUrl))
        );

        const filteredImages = proxyImageUrls.filter(img => img !== null);

        const titleMatch = htmlString.match(/<h1[^>]*>(.*?)<\/h1>/);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>?/gm, '').trim() : "No Title";

        // メタ情報スクレイピング
        const circleMatch = htmlString.match(/制作サークル\s*:\s*(?:<[^>]+>\s*)*<a[^>]*>([^<]+)<\/a>/i);
        const circle = circleMatch ? circleMatch[1].trim() : "不明";

        const authorMatch = htmlString.match(/作者\s*:\s*(?:<[^>]+>\s*)*<a[^>]*>([^<]+)<\/a>/i);
        const author = authorMatch ? authorMatch[1].trim() : "不明";

        const pagesMatch = htmlString.match(/ページ数\s*:\s*(?:<[^>]+>\s*)*(\d+)\s*ページ/i);
        const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;

        const dateMatch = htmlString.match(/公開\/投稿日時\s*:\s*(?:<[^>]+>\s*)*<time[^>]*>([^<]+)<\/time>/i);
        const postDate = dateMatch ? dateMatch[1].trim() : "不明";

        // タグ取得
        const tags = [];
        const tagRegex = /<a\s+href="https:\/\/momon-ga\.com\/tag\/[^"]+"[^>]*>([^<]+)<\/a>/gi;
        let tagMatch;
        while ((tagMatch = tagRegex.exec(htmlString)) !== null) {
            tags.push(tagMatch[1].trim());
        }

        // コメント取得
        const comments = [];
        const commentRegex = /<div\s+class="comment\s+[^"]*id="comment-(\d+)"[^>]*>([\s\S]*?)(?=<div\s+class="comment\s+|<div\s+id="respond"|<\/div>\s*<\/li>|$)/gi;
        let commentBlockMatch;
        while ((commentBlockMatch = commentRegex.exec(htmlString)) !== null) {
            const block = commentBlockMatch[2];

            const numMatch = block.match(/<span\s+class="comment_num">([^<]+)<\/span>/);
            const authorMatch = block.match(/<span\s+class="comment_author">([^<]+)<\/span>/);
            const dateMatch = block.match(/<span\s+class="comment_date">([^<]+)<\/span>/);
            const textMatch = block.match(/<p>([\s\S]*?)<\/p>/);
            const likesMatch = block.match(/data-ulike-counter-value="([^"]+)"/);

            const num = numMatch ? numMatch[1].replace(/[^\d]/g, '').trim() : "";
            const authorName = authorMatch ? authorMatch[1].trim() : "";
            const date = dateMatch ? dateMatch[1].trim() : "";
            const text = textMatch ? textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>?/gm, '').trim() : "";
            const likes = likesMatch ? likesMatch[1].trim() : "";

            if (text || authorName) {
                comments.push({ num, author: authorName, date, text, likes });
            }
        }

        // 関連作品取得
        const relatedTasks = [];
        const relatedRegex = /<a\s+href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?(?:<div\s+class="post-list-wpulike">([^<]+)<\/div>)?[\s\S]*?<\/a>/gi;
        let relatedMatch;
        while ((relatedMatch = relatedRegex.exec(htmlString)) !== null) {
            const relId = relatedMatch[1];
            const relImgUrl = relatedMatch[2];
            const relTitle = relatedMatch[3];
            const relLikes = relatedMatch[4] ? relatedMatch[4].trim() : "";

            relatedTasks.push((async () => {
                const proxyImageUrl = await registerImageProxy(relImgUrl, c.env, originUrl);
                return { id: relId, title: relTitle, image: proxyImageUrl, likes: relLikes };
            })());
        }
        const related = await Promise.all(relatedTasks);

        return c.json({
            title,
            images: filteredImages,
            circle,
            author,
            pages,
            postDate,
            tags,
            comments,
            related
        });

    } catch (e) {
        console.error(e.message);
        return c.text("Detail fetch error", 500);
    }
});

// 暗号化画像の配信 API
app.get('/api/image/:id', async (c) => {
    const imageId = c.req.param('id');
    let encryptedBytes;
    let contentType = 'image/jpeg';

    if (c.env.IMAGE_CACHE) {
        const { value, metadata } = await c.env.IMAGE_CACHE.getWithMetadata(imageId, { type: 'arrayBuffer' });
        if (!value) return c.text("Image not found or expired", 404);
        encryptedBytes = new Uint8Array(value);
        if (metadata?.contentType) contentType = metadata.contentType;
    } else {
        const cached = memoryCache.get(imageId);
        if (!cached) return c.text("Image not found or expired", 404);
        encryptedBytes = cached.buffer;
        contentType = cached.contentType;
    }

    try {
        const keyHex = c.env.ENCRYPTION_KEY_HEX || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const decryptedBuffer = await decryptBuffer(encryptedBytes, keyHex);

        return new Response(decryptedBuffer, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400'
            }
        });
    } catch (e) {
        console.error("Decryption error details:", e.message);
        return c.text("Decryption error", 500);
    }
});

// ダイレクト画像プロキシ API
app.get('/api/image-proxy', async (c) => {
    const imageUrl = c.req.query('url');
    if (!imageUrl) return c.text("URL is required", 400);

    try {
        const response = await fetch(imageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://momon-ga.com/'
            }
        });

        if (!response.ok) return c.text("Failed to fetch image", 502);

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const imageBuffer = await response.arrayBuffer();

        return new Response(imageBuffer, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400'
            }
        });
    } catch (e) {
        console.error(e.message);
        return c.text("Image proxy error", 500);
    }
});

export default app;
