/* 手机端全屏层：fixed 覆盖 + translateX 滑入 + data-prevent-swipe（App 侧查祖先链上
 * 该属性，命中即禁侧滑返回，防阅读冲突）。返回键走 popstate 兜底 + 顶栏按钮双保险。 */
import { displayName, escapeHTML, svg } from "./util";
import { bindHorizontalSwipe } from "./gesture";
import { readerHTML, wireReader } from "./tab";
import { loadStateAsync } from "./state";
import type { ReaderState } from "./types";

const instances: { path: string; handle: any }[] = [];

export function openEpubMobile(path: string, onReady?: (handle: any) => void) {
    const exist = instances.find(function (i) { return i.path === path; });
    if (exist) {
        if (onReady) onReady(exist.handle);
        return exist.handle; // 已开着 → 不叠加（P0 简化：不做聚焦恢复）
    }
    // 标注/进度存于插件数据目录（随思源同步），异步取到后再建全屏层
    loadStateAsync(path).then(function (state: ReaderState) { openMobileLayer(path, state, onReady); });
    return null;
}

function openMobileLayer(path: string, state: ReaderState, onReady?: (handle: any) => void) {
    const layer = document.createElement("div");
    layer.className = "epub-mini-mobile-layer";
    layer.setAttribute("data-prevent-swipe", "true"); // 禁 App 侧滑返回手势
    layer.innerHTML =
        '<div class="epub-mini-m__top">' +
        '<button class="epub-mini-m__back" title="返回">' + svg("iconLeft") + '</button>' +
        '<span class="epub-mini-m__title">' + escapeHTML(displayName(path)) + '</span>' +
        '</div>' +
        '<div class="epub-mini-m__body">' + readerHTML(path) +
        '<div class="epub-mini-m__scrim"></div></div>';
    document.body.appendChild(layer);

    /* 保险：若焦点还留在思源编辑器（touchend 拦截万一没兜住），主动 blur 防软键盘 */
    try { const ae = document.activeElement as HTMLElement | null; if (ae && ae.blur) ae.blur(); } catch (e) {}

    const body = layer.querySelector(".epub-mini-m__body") as HTMLElement;
    const root = layer.querySelector(".epub-mini") as HTMLElement;
    const scrim = layer.querySelector(".epub-mini-m__scrim") as HTMLElement;
    const w = wireReader(body, path, state);

    /* 手势：左滑收侧栏（侧栏没开则不动，退出交给系统边缘返回 / 顶栏按钮，防弧线误触发
     * 直接退书）；右滑开当前页签或切换目录 / 标注。判定复用 bindHorizontalSwipe。
     * iframe 内的 touch 不冒泡出宿主，由 bindMarkClick 转发（api.__mobileSwipe）接力。 */
    w.api.__isMobile = true;
    function currentPane(): string {
        const tocPane = root.querySelector(".epub-mini__pane--toc");
        return tocPane && tocPane.classList.contains("fn__none") ? "mark" : "toc";
    }
    function onSwipe(dir: "left" | "right") {
        const open = root.classList.contains("epub-mini--sidebar-open");
        if (dir === "left") {
            if (open) root.classList.remove("epub-mini--sidebar-open");
            return;
        }
        // 右滑
        if (!open) { try { w.api.__showPane(currentPane()); } catch (e) {} return; }
        try { w.api.__showPane(currentPane() === "toc" ? "mark" : "toc"); } catch (e) {}
    }
    w.api.__mobileSwipe = onSwipe;
    bindHorizontalSwipe(body, onSwipe);

    const inst = { path: path, handle: null as any };
    instances.push(inst);

    let closed = false;
    function close(viaHistory: boolean) {
        if (closed) return;
        closed = true;
        const i = instances.indexOf(inst);
        if (i > -1) instances.splice(i, 1);
        window.removeEventListener("popstate", onPop);
        try { // 注销伪对话框（安卓返回键级联入口，见下方注册处）
            const sy = (window as any).siyuan;
            if (sy && Array.isArray(sy.dialogs)) {
                const di = sy.dialogs.indexOf(fakeDialog);
                if (di > -1) sy.dialogs.splice(di, 1);
            }
        } catch (e) {}
        layer.classList.remove("show"); // 触发滑出动画
        setTimeout(function () {
            try { w.destroy(); } catch (e) {}
            layer.remove();
        }, 240);
        if (!viaHistory) { try { history.back(); } catch (e) {} } // 消费自己 push 的历史项
    }
    function onPop() { close(true); }
    window.addEventListener("popstate", onPop);
    try { history.pushState({ ymerEpub: Date.now() }, ""); } catch (e) {}
/* 返回键：安卓/鸿蒙 App 的返回键不走 WebView 历史（popstate 收不到），原生壳经
 * window.goBack() 级联检查一堆层级都不认识阅读层 → 首次无反应、二次退 App。
 * 对策：把阅读层注册成伪 dialogs（官方扩展点，非空即 destroy 最后一个）→ 返回键
 * 第一优先级就收书；浏览器无 window.siyuan 自动跳过，走 popstate。 */
    const fakeDialog = { destroy: function () { try { close(false); } catch (e) {} } };
    try {
        const sy = (window as any).siyuan;
        if (sy && Array.isArray(sy.dialogs)) sy.dialogs.push(fakeDialog);
    } catch (e) {}

    layer.querySelector(".epub-mini-m__back").addEventListener("click", function () { close(false); });
    scrim.addEventListener("click", function () { root.classList.remove("epub-mini--sidebar-open"); });

    /* 双 rAF：先让 layer 以 translateX(100%) 完成一帧布局，再加 show 触发过渡 */
    requestAnimationFrame(function () {
        requestAnimationFrame(function () { layer.classList.add("show"); });
    });
    inst.handle = { __api: w.api, destroy: function () { close(false); } };
    if (onReady) onReady(inst.handle);
    return inst.handle;
}
