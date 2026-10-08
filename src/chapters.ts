/* continuous 章节加载：只往 mgr.q 投一次 check()，补章/跳章/销毁全交给 epub.js 队列。
 * 禁用 mgr.add/prepend 抢队列 —— 队列外插队会与 update/destroy 互踩，视图被销毁
 * （快速连点目录后正文空白的根因）。
 * 禁用 rend.next()/prev() —— 它们内部走 display 的「目标章无视图」分支 = clear()
 * 销毁全部视图，会把当前章一起销毁、视口拽到新章开头（滚动横跳的真凶）。 */
import type { ReaderApi } from "./types";
import { isJumping, requestJump } from "./jump";
import { patchQueue } from "./epubq";

/* 往 continuous 管理器自己的队列投一次 check()：补哪章、scrollTop 反向补偿全由
 * epub.js 决定（它的 scrolled 事件内部就走这条路径）。
 * 队列死链免疫与自愈在 epubq.ts统一处理，本函数只保留调用方闸门：返回 promise
 * 用超时兜底，队列瘫痪时 busy 也能按时释放。 */
export function enqueueCheck(api: ReaderApi): Promise<any> | null {
    const mgr = api.rend && api.rend.manager;
    if (!mgr || !mgr.q || typeof mgr.check !== "function") return null;
    const q = mgr.q;
    patchQueue(q, api);
    const task = function (this: any) {
        try {
            const r = this.check();
            if (r && typeof r.then === "function") {
                return r.catch(function (e: any) { console.warn("[yumin-ebook-reader] check() 失败：", e); });
            }
            return r;
        } catch (e) {
            console.warn("[yumin-ebook-reader] check() 异常：", e);
        }
    };
    let taskPromise: any;
    try {
        taskPromise = q.enqueue(task);
    } catch (e) {
        console.warn("[yumin-ebook-reader] check() 入队失败：", e);
        return null;
    }
    return Promise.race([
        Promise.resolve(taskPromise).catch(function (e) { console.warn("[yumin-ebook-reader] check() 队列失败：", e); }),
        new Promise(function (res) { setTimeout(res, 2500); }) // 队列瘫痪时强制放行调用方闸门
    ]);
}

/* 手动显式加载某一章。仅特殊场景调用；常规补章一律走 enqueueCheck，
 * 让 epub.js 自己决定加载哪一章。保留去重；错误 console.warn 不再静默吞。 */
export function loadNeighbor(api: ReaderApi, section: any, isPrev: boolean) {
    if (!section) return null;
    const mgr = api.rend && api.rend.manager;
    if (!mgr || !mgr.views || typeof mgr.views.all !== "function") return null;
    const vs = mgr.views.all();
    for (let i = 0; i < vs.length; i++) {
        if (vs[i].section && vs[i].section.index === section.index) return null; // 已加载过，不重复
    }
    const fn = isPrev ? mgr.prepend : mgr.add;
    if (typeof fn !== "function") return null;
    try {
        return Promise.resolve(fn.call(mgr, section)).catch(function (e) {
            console.warn("[yumin-ebook-reader] loadNeighbor 失败：", e);
        });
    } catch (e) {
        console.warn("[yumin-ebook-reader] loadNeighbor 异常：", e);
        return null;
    }
}

/* 统一跳转入口（目录 href / 侧栏标注 CFI / 页码 href）。
 * 全插件跳转只有 jump.ts 一个入口：requestJump 只登记意图，防抖、「只认最后一次」、
 * align 判定都在那一层统一生效，各入口的本地防抖/静默窗已全部取消。
 * align 按目标形态自动判定：CFI → 真值坐标对齐，href → epub.js 原生定位。 */
export function jumpApi(api: ReaderApi, target: string) {
    requestJump(api, target);
}

/* 滚动跨章兜底 + 主动级联预加载：贴边后 150ms 内 epub.js 未自动加载（scrollHeight
 * 未增长、仍贴边）就往队列投一次 check() 代它补章。底边/顶边双向覆盖 —— 顶边在
 * 「短章无滚动条 → 无 scroll、无 rendered」时是唯一触发源。
 * __edgeMuteUntil 静默窗内不开火：落点稳定期由原生 fill 独自补章，避免落点漂移。 */
export function bindScrollChapters(api: ReaderApi): void {
    const cont = api.root.querySelector(".epub-container") as any; // 挂 __epubScrollChapterBound 幂等标记
    if (!cont || cont.__epubScrollChapterBound) return;
    cont.__epubScrollChapterBound = true;
    let busy = false;

    // 主动级联加载：滚到 clamp 后不再派发 scroll 事件，短章本就零 scroll 事件，
    // 两者都会让「贴边才补章」永远不被触发。故在贴边/无滚动条时主动投 check()，
    // 直到抵首末章或用户已离开贴边。busy 与滚动处理器共用，避免互相抢占。
    function ensureBottomLoaded() {
        if (busy) return;
        if (isJumping(api)) return;                            // 跳转活动中：门闸关闭，一律不补章
        if (Date.now() < (api.__edgeMuteUntil || 0)) return;  // 跳章静默窗：别与原生 fill 竞争
        const mgr = api.rend && api.rend.manager;
        if (!mgr || !mgr.views || typeof mgr.views.all !== "function") return;
        const views = mgr.views.all();
        if (!views.length) return;
        const first = views[0], last = views[views.length - 1];
        const canPrev = !!(first.section && first.section.prev());
        const canNext = !!(last.section && last.section.next());
        if (!canPrev && !canNext) return; // 已是全书首/末章
        const noScrollbar = cont.scrollHeight <= cont.clientHeight + 2;
        const atBottom = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 60;
        const atTop = cont.scrollTop <= 0;
        if (!((noScrollbar && (canPrev || canNext)) || (atBottom && canNext) || (atTop && canPrev))) return;
        busy = true;
        api.__chapterScrollAt = Date.now();
        Promise.resolve(enqueueCheck(api)).then(function () {
            setTimeout(function () { busy = false; ensureBottomLoaded(); }, 40);
        });
    }
    api.__ensureBottomLoaded = ensureBottomLoaded;

    cont.addEventListener("scroll", function () {
        if (busy) return;
        if (isJumping(api)) return;                          // 跳转活动中：门闸关闭
        if (Date.now() < (api.__edgeMuteUntil || 0)) return; // 跳章静默窗
        const now = Date.now();
        if (now - (api.__chapterScrollAt || 0) < 500) return;
        const atBottom = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 60;
        const atTop = cont.scrollTop <= 60;
        if (!atBottom && !atTop) return;
        busy = true;
        const shAtEntry = cont.scrollHeight; // 管理器 reflow 中（sh 在变）绝不开火——否则横跳
        setTimeout(function () {
            try {
                const stillBottom = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 80;
                const stillTop = cont.scrollTop <= 80;
                const shStable = cont.scrollHeight === shAtEntry;
                if (shStable && ((atBottom && stillBottom) || (atTop && stillTop))) {
                    api.__chapterScrollAt = Date.now();
                    const p = enqueueCheck(api); // 不自己算 next/prev，交给 epub.js 的队列
                    if (p) {
                        p.then(function () { busy = false; ensureBottomLoaded(); });
                    } else { busy = false; }
                    return;
                }
            } catch (e) {}
            busy = false;
        }, 150);
    }, { passive: true } as any);
}
