/* epub.js 队列守卫（rendition.q + manager.q），安装于 rendition 创建后、任何 display 之前。
 *
 * 致命点：queue.run() 的续命链是 dequeue().then(run)，没有 catch —— 任务同步抛错就
 * 永久停摆：running 卡在 true（只有排空才被置回），后续 enqueue 的点火条件永不成立，
 * 任务 promise 既不 resolve 也不 reject。表现是正文空白 + 跳转点了没反应。
 * rendition.q 承载首屏与全部跳转，比 manager.q 更不能裸奔。
 *
 * 两道防线：
 *   ① 咽喉点：包装 dequeue（所有任务执行的必经之路），吞掉同步异常并返回 resolved
 *      promise，续命链不断；调用方的 deferred 仍照常 reject，语义不变。
 *   ② 自愈巡检：running===true（已点火）+ 无任务在执行 + 队列非空，三者同时成立且
 *      持续 200ms → 判续命链已断（正常时一帧 ≤16ms 必然 dequeue），重新点火，积压
 *      任务随之恢复。页面不可见时排除（后台 rAF 冻结会假成立）。 */
import { isJumping } from "./jump";

const HEAL_RECHECK_MS = 200;  /* 疑似死链复检延迟（正常 rAF ≤16ms 必然 dequeue） */
const PATROL_MS = 500;        /* 巡检周期 */

interface QEntry { q: any; api: any; }
const REG: QEntry[] = [];
let patrol: any = null;

function visible(): boolean {
    return typeof document === "undefined" || document.visibilityState === "visible";
}

function inspect(q: any): void {
    try {
        if (!q || !q._q || !q._q.length) return;
        if (q.running !== true || (q.__executing || 0) !== 0) return;
        if (!visible() || q.__healPending) return;
        q.__healPending = true;
        setTimeout(function () {
            q.__healPending = false;
            try {
                /* 复检：这 200ms 内若 dequeue 发生过，该条件必已不成立 */
                if (q._q.length && q.running === true && (q.__executing || 0) === 0 && visible()) {
                    console.warn("[yumin-ebook-reader] epub 队列死链自愈：重新点火（积压 " + q._q.length + " 项）");
                    q.running = undefined;
                    q.run();
                }
            } catch (e) { console.warn("[yumin-ebook-reader] 队列自愈失败：", e); }
        }, HEAL_RECHECK_MS);
    } catch (e) {}
}

function patrolTick(): void {
    patrol = null;
    for (let i = REG.length - 1; i >= 0; i--) {
        const it = REG[i];
        const root = it.api && it.api.root;
        if (!root || !root.isConnected) { REG.splice(i, 1); continue; } /* 页签已关闭：退场 */
        inspect(it.q);
    }
    if (REG.length) patrol = setTimeout(patrolTick, PATROL_MS);
}

/* 给一个 epub.js Queue 实例装死链免疫 + 纳入巡检。幂等。 */
export function patchQueue(q: any, api: any): void {
    if (!q || q.__ymerQueuePatched) return;
    q.__ymerQueuePatched = true;
    const origDequeue = q.dequeue;
    q.dequeue = function () {
        /* 同步异常时队首已被 shift 走，先留引用，替它把 deferred reject 掉，
         * 否则调用方的 promise 永久悬空（表现同死链：什么都不发生） */
        const head = q._q && q._q[0];
        let r: any;
        try {
            r = origDequeue.apply(this, arguments as any);
        } catch (e) {
            console.warn("[yumin-ebook-reader] 队列任务同步异常（已拦截，续命链保持）：", e);
            try { if (head && head.deferred) head.deferred.reject(e); } catch (e2) {}
            return Promise.resolve();
        }
        q.__executing = (q.__executing || 0) + 1;
        return Promise.resolve(r).catch(function (e: any) {
            console.warn("[yumin-ebook-reader] 队列任务失败（已拦截，续命链保持）：", e);
        }).then(function () { q.__executing--; });
    };
    let dup = false;
    for (let i = 0; i < REG.length; i++) { if (REG[i].q === q) { dup = true; break; } }
    if (!dup) REG.push({ q: q, api: api });
    if (!patrol) patrol = setTimeout(patrolTick, PATROL_MS);
}

/* 给一本书的阅读器装队列守卫：rendition.q（跳转 / 内部自显示全走它）+
 * manager.q（补章 check / trim / destroy）。须在 rendition 创建后立刻调用，
 * 早于任何 display —— 懒安装（等 enqueueCheck 才装）覆盖不到首屏。 */
export function installQueueGuards(api: any): void {
    if (!api || !api.rend) return;
    const rend = api.rend;
    patchQueue(rend.q, api);
    if (rend.manager && rend.manager.q) patchQueue(rend.manager.q, api);
    installManagerGuards(api);
    if (!api.__queuesReady) {
        api.__queuesReady = true;
        console.log("[Q] epub 队列守卫安装完成（rendition.q" + (rend.manager && rend.manager.q ? " + manager.q" : "") + "）");
    }
}

/* ---------- manager 级守卫 ----------
 * ① trim() 守卫（正文空白 + 目标视图蒸发的直接成因）
 *    views.displayed() 为空时 indexOf(first/last) 得 undefined → -1，于是
 *    above=slice(0,-1)、below=slice(0)，两个 erase 循环把**全部视图连 iframe
 *    一起删光**（erase → views.remove → container.removeChild）。视图正在重建的
 *    一瞬就会命中：内容永久空白、目标章从视图池蒸发（收工 ready=false 的来源）。
 *    trim 是机会性清理（update() 每次滚动都会重排），所以「displayed 为空就跳过」
 *    零语义损失。
 * ② 跳转临界区内一律跳过：跳转中不该有任何几何改动（同 jump.ts 门闸原则）。
 * ③ 诊断桩（mgr.display / scrollTo / scrollBy）：只在跳转中记录，便于定位
 *    「谁在动几何」。 */
export function installManagerGuards(api: any): void {
    if (!api || !api.rend) return;
    const mgr = api.rend.manager;
    if (!mgr) return;

    if (!mgr.__ymerTrimPatched && typeof mgr.trim === "function") {
        mgr.__ymerTrimPatched = true;
        const origTrim = mgr.trim.bind(mgr);
        mgr.trim = function () {
            try {
                const vs = mgr.views;
                const disp = (vs && typeof vs.displayed === "function") ? (vs.displayed() || []) : null;
                if (disp && disp.length === 0) {
                    console.log("[Q] trim 跳过：views.displayed() 为空（此时 trim 会删光全部视图）");
                    return Promise.resolve();
                }
                if (isJumping(api)) {
                    console.log("[Q] trim 跳过：跳转临界区内不清理视图");
                    return Promise.resolve();
                }
            } catch (e) { /* 守卫自身异常不阻塞原生语义 */ }
            return origTrim();
        };
        console.log("[Q] manager.trim 守卫安装完成");
    }

    if (!mgr.__ymerDiagPatched) {
        mgr.__ymerDiagPatched = true;
        ["display", "scrollTo", "scrollBy", "update"].forEach(function (k: string) {
            if (typeof mgr[k] !== "function") return;
            const orig = mgr[k].bind(mgr);
            mgr[k] = function (x: any, y: any, z: any) {
                if (isJumping(api)) {
                    const a1 = (k === "display") ? ("section=" + (x && x.index) + " target=" + String(y).slice(0, 40)) : ("x=" + Math.round(x) + " y=" + (y == null ? "null" : Math.round(y)));
                    console.log("[Q] mgr." + k + " " + a1);
                }
                return orig(x, y, z);
            };
        });
        console.log("[Q] manager 诊断桩安装完成");
    }
}
