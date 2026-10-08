/* 通用小工具 */
export const TAG = "[EPUB-MINI]";

export function displayName(path: string): string {
    let n = String(path).split("/").pop() || path;
    n = n.replace(/\.[A-Za-z0-9]+$/, "");
    try { n = decodeURIComponent(n); } catch (e) {}
    return n;
}

export function assetURL(path: string): string {
    if (/^(https?:)?\/\//i.test(path) || /^file:/i.test(path)) return path;
    /* 统一剥掉前导 assets/：各入口 path 形态不一（href="assets/x.epub"、标注引用 decode
     * 后也带前缀，而 assetURL 自身还会再拼一层），不剥会拼成 /assets/assets/x.epub →
     * 内核 404 → 被「已删除」检测误判成书没了。 */
    let p = String(path).replace(/^\.?\/?assets\//, "");
    const baseEl = document.getElementById("baseURL");
    const base = (baseEl && baseEl.getAttribute("href")) || (location.origin + "/");
    return base.replace(/\/+$/, "") + "/assets/" + encodeURI(p).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

export function escapeHTML(s: any): string {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---------- 取书字节：绕开内核 /assets/ 的 gzip 截断 ----------
 * 症状：大书报「书籍打开失败，文件可能已损坏」（JSZip: can't find end of central directory）。
 * 根因（实测，非插件问题）：内核对 /assets/*.epub 按 Accept-Encoding 做 gzip 时会截断
 *   响应体 —— 声明 chunked、实收字节少于文件真值，53MB 的书稳定少 20575 字节，且每次
 *   截断位置不同，故表现为「刚开始能开、后来打不开」的随机失败。小书或浏览器外
 *   （curl 默认不带 Accept-Encoding）正常。
 * 对策：Range 分块取，每块独立校验长度，坏块重试；拿到非 gzip 字节说明已解压，直接透传。 */
const CHUNK = 8 * 1024 * 1024;      // 分块大小：实测 8MB 内不截断
const CHUNK_RETRY = 3;              // 单块重试次数

function isGzipHead(b: ArrayBuffer): boolean {
    const h = new Uint8Array(b, 0, Math.min(2, b.byteLength));
    return h[0] === 0x1f && h[1] === 0x8b;
}

/* 把可能不完整的响应体解压；失败返回 null（交由上层走分块重取） */
async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer | null> {
    if (typeof DecompressionStream === "undefined") {
        throw new Error("浏览器无法解压 gzip 响应（缺 DecompressionStream）");
    }
    try {
        const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
    } catch (e) {
        return null;   // 流被截断 → 让上层重取
    }
}

/* 单块取回并保证解压后长度与请求区间一致（长度不符 = 被截断，判失败） */
async function fetchRange(url: string, start: number, end: number): Promise<Uint8Array> {
    let lastErr = "未知错误";
    const want = end - start + 1;
    for (let attempt = 0; attempt < CHUNK_RETRY; attempt++) {
        try {
            const resp = await fetch(url, {
                headers: { Range: "bytes=" + start + "-" + end },
                cache: "no-store",     // 书可能被替换过，别拿浏览器缓存里的旧字节
            });
            if (resp.status === 404 || resp.status === 403) {
                throw new Error("HTTP " + resp.status);
            }
            const raw = await resp.arrayBuffer();
            if (raw.byteLength < 1) throw new Error("空响应");
            const out = isGzipHead(raw) ? await gunzip(raw) : raw;
            if (!out) { lastErr = "gzip 流不完整"; continue; }
            const u = new Uint8Array(out);
            /* 必须等于请求区间长度才收——不能只判「不小于 raw 长度」：
             * 被截断的流解压后往往短一截，那正是内核的故障形态。 */
            if (u.byteLength !== want) { lastErr = "块被截断(" + u.byteLength + "/" + want + ")"; continue; }
            return u;
        } catch (e) {
            lastErr = (e && (e as any).message) || String(e);
            if (/HTTP 40[34]/.test(lastErr)) throw new Error(lastErr);  // 404/403 不重试
        }
    }
    throw new Error("分块读取失败：" + lastErr);
}

export async function fetchBookBytes(url: string): Promise<ArrayBuffer> {
    /* 先整取一次（多数情况零额外开销）。★必须校验字节数：被截断的 gzip 流不一定让
     * DecompressionStream 报错，它会「成功」吐出一个短一截的结果（实测 53MB 的书少
     * 14767 字节），只看有无抛错就会放行残缺字节。用 Content-Length / Content-Range 比对。 */
    let expect = 0;
    try {
        const resp = await fetch(url, { cache: "no-store" });   // 同上：必须拿磁盘上的真字节
        if (resp.status === 404 || resp.status === 403) throw new Error("HTTP " + resp.status);
        if (resp.ok) {
            const cl = resp.headers.get("Content-Length");
            if (cl) expect = parseInt(cl, 10);
            const raw = await resp.arrayBuffer();
            const out = isGzipHead(raw) ? await gunzip(raw) : raw;
            /* 长度对不上就丢弃，走下面的分块路径 */
            if (out && (!expect || out.byteLength === expect)) return out;
        }
    } catch (e) {
        if (/HTTP 40[34]/.test(String((e as any).message || e))) throw e;
    }
    /* 整取失败或字节不完整 → Range 分块重取。先探总长。 */
    let total = expect;
    if (!total) {
        try {
            const h = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
            const m = (h.headers.get("Content-Range") || "").match(/\/(\d+)$/);
            if (m) total = parseInt(m[1], 10);
        } catch (e) { /* 探测失败则下面按未知长度处理 */ }
    }
    if (!total) {
        /* 拿不到总长：再整取一次，命中就用（此时只能靠解压成功与否判断） */
        const resp = await fetch(url, { cache: "no-store" });
        const raw = await resp.arrayBuffer();
        const out = isGzipHead(raw) ? await gunzip(raw) : raw;
        if (!out) throw new Error("书籍字节不完整，且无法确定文件长度以分块重取");
        return out;
    }
    const parts: Uint8Array[] = [];
    for (let s = 0; s < total; s += CHUNK) {
        const e = Math.min(s + CHUNK, total) - 1;
        const part = await fetchRange(url, s, e);
        /* 每块都必须正好是请求的区间长度：截断的 gzip 流解压后可能「看起来
         * 成功」但短一截（实测），少了字节会导致整本书拼不全。 */
        const want = e - s + 1;
        if (part.byteLength !== want) {
            throw new Error("分块长度不符(" + part.byteLength + "/" + want + ")");
        }
        parts.push(part);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    if (off !== total) throw new Error("拼接长度不符(" + off + "/" + total + ")");
    return out.buffer;
}

export function svg(id: string, cls?: string): string {
    return '<svg class="' + (cls || "") + '"><use xlink:href="#' + id + '"></use></svg>';
}

export function copyText(s: string): void {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(s); return; }
    } catch (e) {}
    try {
        const ta = document.createElement("textarea");
        ta.value = s;
        ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
    } catch (e) { console.warn(TAG, "复制失败", e); }
}

export function showToast(api: ReaderApiLike, msg: string): void {
    if (!api || !api.root) return;
    let t: HTMLElement = api.root.querySelector(".epub-mini__toast");
    if (!t) {
        t = document.createElement("div");
        t.className = "epub-mini__toast";
        api.root.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("epub-mini__toast--on");
    clearTimeout(api.__toastTimer);
    api.__toastTimer = setTimeout(function () { t.classList.remove("epub-mini__toast--on"); }, 2200);
}

/* showToast 只用到 root / __toastTimer，避免为它引入完整 ReaderApi 造成循环依赖 */
type ReaderApiLike = { root: HTMLElement; __toastTimer?: any };
