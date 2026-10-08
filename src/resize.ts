/* 容器尺寸变化 → 重排：页签分屏拖动 / 窗口缩放 / 侧栏开合都不触发 window resize，
 * epub.js 感知不到，必须自己 ResizeObserver。重排会改章节高度 → 同一 scrollTop 指向
 * 别的章节，故记下重排前CFI，跑偏就拉回。
 * 跳转让路：判据统一取 jump.ts 的 isJumping() / jumpSeqOf()，不另建守卫。 */
import type { ReaderApi } from "./types";
import { isJumping, jumpSeqOf } from "./jump";

export function resizeRendition(api: ReaderApi): void {
    if (!api || !api.rend || !api.viewEl) return;
    try {
        // continuous 管理器在零视图时 resize 会卡死主线程（display 队列死锁），必须跳过
        const views = api.rend.manager && api.rend.manager.views;
        if (views && !views.length) return;
    } catch (e) {}
    const r = api.viewEl.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (!(w > 50 && h > 50)) return;
    let cfiBefore: string | null = null;
    const book = String(api.path || "").split("/").pop();
    // 跳转进行中（门闸关闭）只重排不回位：此刻的 currentLocation 是瞬态旧位置，
    // back() 会把刚跳到的位置拽回旧章——点链接开新书必伴随容器尺寸变化（分屏建立），
    // 正是「跳完又被拽回书首」的实测元凶；落点由跳转自身的对齐 + 稳定采样负责。
    if (isJumping(api)) {
        console.log("[RSZ] <" + book + "> " + w + "x" + h + " 跳转中只重排不回位");
        try { api.rend.resize(w, h); } catch (e) {}
        return;
    }
    try {
        const l0 = api.rend.currentLocation();
        cfiBefore = l0 && l0.start && l0.start.cfi;
    } catch (e) {}
    // 代际号：抢拍时记下当时的跳转序号，back 执行时序号变了（期间发生过任何新
    // 意图）就放弃——back 目标（抢拍的瞬态旧位置）已被新跳转作废。
    const seqAtCapture = jumpSeqOf(api);
    console.log("[RSZ] <" + book + "> " + w + "x" + h + " cfiBefore=" + (cfiBefore || "无").slice(0, 60));
    try { api.rend.resize(w, h); } catch (e) {}
    if (!cfiBefore) return;
    const back = function () {
        try {
            if (!api.rend) return;
            // 查牌要晚：守卫只在 resize 入口检查过一次，back 是 260/800ms 后才执行的
            // 定时器——若排定时器时跳转还没开始（新开页签的 ~200ms 空档），入口守卫
            // 拦不住，back 执行时跳转已在跑，必须再查一次，否则把刚跳到的位置拽回
            // cfiBefore（= 书首）——「有时跳到目录第一页」的实测元凶
            if (isJumping(api)) { console.log("[RSZ] <" + book + "> back 闭嘴（跳转活动中）"); return; }
            if (jumpSeqOf(api) !== seqAtCapture) { console.log("[RSZ] <" + book + "> back 作废（抢拍后发生过新跳转）"); return; }
            console.log("[RSZ] <" + book + "> back -> display(" + String(cfiBefore).slice(0, 60) + ")");
            // 总是 display(cfiBefore) 回位，不能只在跨章（href 变了）时才回：
            // 重排改变行宽/行数 → 整章高度变，scrollTop 不变 = 指向章内另一位置
            // （实测页 14 → 页 12 的章内漂移，同章 href 未变，旧短路直接放过不修）。
            // display(cfi) 对已显示章节走 visible 分支（locationOf+scrollTo），
            // 章内精确归位；没跑偏时滚到同一位置，视觉零操作感。
            // 此时门闸已开，installGuard 不会拦这条回位 display（目标是我方自己发的）。
            api.rend.display(String(cfiBefore)).catch(function (e) { console.warn("[yumin-ebook-reader] resize 回位失败：", e); });
        } catch (e) {}
    };
    // 暴露定时器句柄：跳转发起（jump.ts requestJump）时取消已排队的 back——
    // 否则跳转开始后定时器照跑，全靠 back 内查牌兜底（双保险）
    api.__resizeBackTimers = [setTimeout(back, 260), setTimeout(back, 800)];
}
