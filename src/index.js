import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Requested-With']
}));

async function fetchAsBase64(url) {
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
        
    
        let binary = '';
        const bytes = new Uint8Array(arrayBuffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64String = btoa(binary);

        return `data:${contentType};base64,${base64String}`;
    } catch (e) {
        console.error(`Base64 Fetch Error: ${url}`, e.message);
        return null;
    }
}

app.get('/api/search', async (c) => {
    const query = c.req.query('q');
    if (!query) return c.json({ result: [] });

    try {
        const targetUrl = `https://momon-ga.com/?s=${encodeURIComponent(query)}`;
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = await response.text();
        const tasks = [];
        const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img src="([^"]+)"[\s\S]*?alt="([^"]+)"/g;

        let match;
        while ((match = postRegex.exec(html)) !== null) {
            const id = match[1];
            const imgUrl = match[2];
            const title = match[3];

            tasks.push((async () => {
                const base64Image = await fetchAsBase64(imgUrl);
                return {
                    id: id,
                    image: base64Image,
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

app.get('/api/proxy-details', async (c) => {
    const id = c.req.query('id');
    if (!id) return c.text("ID is required", 400);

    const targetUrl = `https://momon-ga.com/fanzine/${id}/`;

    try {
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const htmlString = await response.text();

        
        const titleMatch = htmlString.match(/<title>([\s\S]*?)<\/title>/i);
        const rawTitle = titleMatch ? titleMatch[1].trim() : "";

        
        const descMatch = htmlString.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
        const rawDescription = descMatch ? descMatch[1].trim() : "";

        
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
        const base64Images = await Promise.all(
            uniqueImgUrls.map(url => fetchAsBase64(url))
        );
        const filteredImages = base64Images.filter(img => img !== null);

       
        const getMetaVal = (label) => {
            const reg = new RegExp(`【${label}】\\s*([^【]+)`);
            const m = rawDescription.match(reg);
            return m ? m[1].trim() : "";
        };

        const parody = getMetaVal("パロディ");
        const character = getMetaVal("キャラクター");
        const circle = getMetaVal("サークル");
        const author = getMetaVal("作者");
        const tagsStr = getMetaVal("タグ");
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : [];

    
        const pagesMatch = htmlString.match(/ページ数\s*:\s*(?:<[^>]+>\s*)*(\d+)\s*ページ/i);
        const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;

        const dateMatch = htmlString.match(/公開\/投稿日時\s*:\s*(?:<[^>]+>\s*)*<time[^>]*>([^<]+)<\/time>/i);
        const postDate = dateMatch ? dateMatch[1].trim() : "不明";

      
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

    
        const relatedTasks = [];
        const relatedRegex = /<a\s+href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?(?:<div\s+class="post-list-wpulike">([^<]+)<\/div>)?[\s\S]*?<\/a>/gi;
        let relatedMatch;
        while ((relatedMatch = relatedRegex.exec(htmlString)) !== null) {
            const relId = relatedMatch[1];
            const relImgUrl = relatedMatch[2];
            const relTitle = relatedMatch[3];
            const relLikes = relatedMatch[4] ? relatedMatch[4].trim() : "";

            relatedTasks.push((async () => {
                const base64Img = await fetchAsBase64(relImgUrl);
                return { id: relId, title: relTitle, image: base64Img, likes: relLikes };
            })());
        }
        const related = await Promise.all(relatedTasks);

        return c.json({
            title: rawTitle,
            description: rawDescription,
            parody,
            character,
            circle,
            author,
            pages,
            postDate,
            tags,
            images: filteredImages,
            comments,
            related
        });

    } catch (e) {
        console.error(e.message);
        return c.text("Detail fetch error", 500);
    }
});


app.get('/api/image-proxy', async (c) => {
    const imageUrl = c.req.query('url');
    if (!imageUrl) return c.text("URL is required", 400);

    const base64Data = await fetchAsBase64(imageUrl);
    if (!base64Data) return c.text("Failed to fetch and convert image", 502);

    return c.json({ image: base64Data });
});

export default app;
