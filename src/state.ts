/* 阅读状态持久化（随思源同步）：
 * - 存哪：插件数据目录 data/storage/petal/<插件名>/annotations/<键>.json，
 *   经 Plugin.saveData/loadData 读写，落在工作空间内 → 随思源同步到各设备。
 * - 存什么：标注、标注色/模式、字号、页码定位点缓存（locations）、阅读进度（progress）。
 * - 文件格式 { path: 原书资产路径, data: ReaderState }，清扫时据此判断书是否还在。
 * - localStorage 只当镜像兜底：思源前端 origin 是随机端口（每次启动都不同），
 *   localStorage 按 origin 隔离 → 重启必空，绝不能当跨重启存储。
 * - 清扫：pruneOrphanAnnotations() 在加载 10s 后逐本核对书资产（GET+Range 双探），
 *   两次 404 = 书已删 → 连同其标注文件删除（思源无「资产被删」事件，只能加载时对账）。
 * - 防抖：saveState 保持同步签名，内部 800ms 合并写入；onunload 时 flushState 立即落盘。 */
import { fetchPost } from "siyuan";
import { assetURL } from "./util";
import type { ReaderApi, ReaderState } from "./types";

const LS_PREFIX = "siyuan-epub-reader:"; // 旧版 localStorage 键前缀（仅迁移用）
const DIR = "annotations";              // 插件数据目录下的子目录名
const SAVE_DEBOUNCE = 800;              // 连续标注操作合并为一次磁盘写入

let plugin: any = null;
/* 待落盘队列：fileKey -> { timer, path, state }（state 存引用，flush 时取最新值） */
const pending = new Map<string, { timer: number; path: string; state: ReaderState }>();

/** 插件实例注入（index.ts onload 时调用，避免 state.ts ↔ index.ts 循环引用） */
export function bindPlugin(p: any): void { plugin = p; }

function fileKey(path: string): string {
    // ⚠️ 内核 putFile 拒绝含 % 的路径（官方 #14658 安全加固，实测 code=400 "invalid file path"，
    // encodeURIComponent 的键曾导致标注文件静默写入失败）。文件名只保留内核安全字符，
    // 其余（含全部 CJK 与编码符号）压成 -，唯一性由尾部内容哈希保证（文件内 path 字段仍是原路径）
    let safe = path.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
    if (safe.length > 80) safe = safe.slice(0, 80);
    if (!safe) safe = "book";
    return safe + "-" + hashStr(path) + ".json";
}

function hashStr(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

/** 打开书前异步加载状态：新存储优先；为空则读旧 localStorage 并回填新存储。
 * 注意：localStorage 永不删除——它作为镜像兜底（新存储万一损坏/被误删仍可恢复）。 */
export async function loadStateAsync(path: string): Promise<ReaderState> {
    if (plugin) {
        try {
            const raw = await plugin.loadData(DIR + "/" + fileKey(path));
            // loadData 在文件不存在时 resolve ""（走错误回调），有文件时 resolve 解析后的对象
            if (raw && typeof raw === "object" && raw.data) {
                try { localStorage.setItem(LS_PREFIX + path, JSON.stringify(raw.data)); } catch (e2) {} // 保持镜像温热
                return raw.data as ReaderState;
            }
        } catch (e) { /* 插件生命周期已结束等异常 → 走 localStorage 兜底 */ }
    }
    try {
        const old = localStorage.getItem(LS_PREFIX + path);
        if (old) {
            const parsed = JSON.parse(old) || {};
            if (plugin) await saveStateFile(path, parsed as ReaderState); // 回填新存储（失败也不影响本次阅读）
            return parsed as ReaderState;
        }
    } catch (e) {}
    return {};
}

async function saveStateFile(path: string, state: ReaderState): Promise<void> {
    if (!plugin) return;
    try {
        const resp = await plugin.saveData(DIR + "/" + fileKey(path), { path: path, data: state });
        // fetchPost 对内核业务错误（code!=0）也会走成功回调 → 必须自查 code，
        // 否则 400 invalid file path 这类拒绝会静默溜走（标注全丢的教训）
        if (resp && typeof resp === "object" && resp.code) {
            console.warn("[EPUB-MINI] 标注写入被内核拒绝：", resp.code, resp.msg, "键=", fileKey(path));
        }
    } catch (e) { /* 只读模式/发布模式/生命周期结束 saveData 会 reject —— 留痕，阅读功能不受影响 */ console.warn("[EPUB-MINI] 标注写入插件数据目录失败：", e); }
}

/** 保存（同步签名，调用方无感）：800ms 防抖合并连续操作 */
export function saveState(api: ReaderApi): void {
    if (!plugin) { // 无插件实例（极端兜底）→ 退回 localStorage 保证不丢
        try { localStorage.setItem(LS_PREFIX + api.path, JSON.stringify(api.state)); } catch (e) {}
        return;
    }
    const key = fileKey(api.path);
    const prev = pending.get(key);
    if (prev) clearTimeout(prev.timer);
    pending.set(key, {
        timer: window.setTimeout(function () {
            pending.delete(key);
            saveStateFile(api.path, api.state);
            try { localStorage.setItem(LS_PREFIX + api.path, JSON.stringify(api.state)); } catch (e) {} // 镜像双写：新存储异常时兜底
        }, SAVE_DEBOUNCE),
        path: api.path,
        state: api.state
    });
}

/** onunload 兜底：把还没落盘的防抖任务立即写入 */
export function flushState(): void {
    pending.forEach(function (p) {
        clearTimeout(p.timer);
        saveStateFile(p.path, p.state);
    });
    pending.clear();
}

/** 插件加载时清扫孤儿标注文件：书资产已删除（404）→ 删除其标注文件。
 *  ⚠️ 三重防误删（曾有 HEAD 全量误删事故）：
 *  ① 启动后延迟 10s 再核对（避开启动瞬间服务未就绪窗口）；
 *  ② 存在性核对必须用 GET+Range（bytes=0-0）——内核 /assets 静态服务不响应 HEAD；
 *  ③ 双探确认：两次都 404 才判孤儿；200/206/异常一律保守跳过。
 *  ⚠️ 探测必须 cache:"no-store"：内核 /assets 响应只有 Last-Modified、没有
 *     Cache-Control，浏览器会启用启发式缓存（有效期 = 文件年龄 × 10%）。书越老
 *     缓存越"新鲜"，删掉后仍从缓存返回 206 → 误判为「书还在」→ 孤儿清不掉
 *     （实测：刚导入的书清得掉，30 天前的书清不掉）。
 *  ⚠️ 频率：删除书籍是低频动作，清扫只是收拾孤儿文件，**每天一次 + 每次重新载入**
 *     足够（曾用 30 分钟一次纯属浪费）。真正保证「删书后不残留」的是 no-store
 *     那个修复，不是频率 —— 频率只决定「万一漏了，多久补上」。 */
const PRUNE_FIRST_DELAY_MS = 10000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 24 小时
let pruneTimer: any = null;
let pruning = false;

export function pruneOrphanAnnotations(): void {
    if (!plugin) return;
    setTimeout(function () { runPrune("启动首轮"); }, PRUNE_FIRST_DELAY_MS);
    try { if (pruneTimer) clearInterval(pruneTimer); } catch (e) {}
    pruneTimer = setInterval(function () { runPrune("周期复查"); }, PRUNE_INTERVAL_MS);
}

/** 插件卸载时停掉周期复查，避免禁用后定时器还在跑 */
export function stopPrune(): void {
    try { if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; } } catch (e) {}
}

function runPrune(reason: string): void {
    if (!plugin || pruning) return;   // 重入保护：上一轮还没跑完就跳过这一轮
    pruning = true;
    fetchPost("/api/file/readDir", { path: "/data/storage/petal/" + plugin.name + "/" + DIR }, function (res: any) {
        /* 内核 readDir 直接返回文件数组（两种形状都兼容），并打印对账数，杜绝无声失败 */
        const d = res && res.data;
        const arr: any[] = Array.isArray(d) ? d : (d && Array.isArray((d as any).files) ? (d as any).files : []);
        let n = 0;
        for (const f of arr) {
            const name = f && f.name;
            if (!name || f.isDir || !/\.json$/i.test(name)) continue;
            n++;
            plugin.loadData(DIR + "/" + name).then(function (raw: any) {
                const bookPath = raw && raw.path;
                if (!bookPath || typeof bookPath !== "string") {
                    console.warn("[EPUB-MINI] 清扫：文件无 path 字段，跳过", name);
                    return;
                }
                const probe = function (): Promise<number> {
                    /* no-store：强制走网络。少了它就会命中浏览器缓存（见上方说明），
                     * 书已删也返回 206，孤儿永远清不掉。 */
                    return fetch(assetURL(bookPath), { headers: { Range: "bytes=0-0" }, cache: "no-store" })
                        .then(function (r: Response) { return r.status; })
                        .catch(function () { return -1; }); // 网络异常 → -1 → 保守跳过
                };
                probe().then(function (s1: number) {
                    if (s1 !== 404) {
                        console.info("[EPUB-MINI] 清扫保留（书仍在或探测异常）status=" + s1, name);
                        return;
                    }
                    setTimeout(function () {
                        probe().then(function (s2: number) {
                            if (s2 !== 404) { console.warn("[EPUB-MINI] 清扫复核未确认 404，保留", name); return; }
                            console.warn("[EPUB-MINI] 清扫：书已删除，移除其标注文件", name, bookPath);
                            plugin.removeData(DIR + "/" + name).catch(function (e: any) {
                                console.warn("[EPUB-MINI] 清扫删除失败：", e);
                            });
                        });
                    }, 5000);
                });
            }).catch(function (e: any) { console.warn("[EPUB-MINI] 清扫读取失败：", name, e); });
        }
        console.info("[EPUB-MINI] 标注清扫对账（" + reason + "）：", arr.length, "个条目 /", n, "个标注文件");
    }, undefined, function () { /* 目录不存在（还从未存过标注）→ 正常情况 */ });
    /* 双探最长 5s；给个上限后释放重入锁，防网络异常时永久卡住不再复查 */
    setTimeout(function () { pruning = false; }, 30000);
}

/* 7 色与思源 PDF 标注完全一致（daylight 主题 --b3-pdf-background1~7） */
export const HL_COLORS = ["#d23f31", "#f5822e", "#FACA5A", "#7CC868", "#FC5C88", "#69B0F2", "#C885DA"];
