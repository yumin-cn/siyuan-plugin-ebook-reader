/* 目录侧栏 */
import { jumpApi } from "./chapters";
import type { ReaderApi } from "./types";

export function renderTOC(api: ReaderApi, items: any[], depth?: number, host?: HTMLElement): void {
    depth = depth || 0;
    for (let i = 0; i < items.length; i++) {
        (function (it: any) {
            const a = document.createElement("div");
            a.className = "epub-mini__toc-item";
            a.style.paddingLeft = (8 + depth * 12) + "px";
            a.textContent = (it.label || "").trim();
            a.setAttribute("data-href", it.href || "");
            a.addEventListener("click", function () {
                if (!it.href) return;
                highlightTOC(api, it.href, a);
                jumpApi(api, it.href);
            });
            host.appendChild(a);
            api.tocFlat.push({ href: it.href, el: a });
            if (it.subitems && it.subitems.length) renderTOC(api, it.subitems, depth + 1, host);
        })(items[i]);
    }
}

export function highlightTOC(api: ReaderApi, href?: string, forcedEl?: HTMLElement): void {
    if (forcedEl) {
        api.tocPinned = forcedEl;
        for (let i = 0; i < api.tocFlat.length; i++) {
            if (api.tocFlat[i].el) api.tocFlat[i].el.classList.toggle("epub-mini__toc-item--active", api.tocFlat[i].el === forcedEl);
        }
        return;
    }
    if (!href) return;
    // 滚动中：若当前位置仍在用户点过的章节文件内，保持用户的选择
    if (api.tocPinned && api.tocPinned.isConnected) {
        const pinnedHref = api.tocPinned.getAttribute("data-href") || "";
        if (href.split("#")[0] === pinnedHref.split("#")[0]) return;
    }
    api.tocPinned = null;
    // 按 href 匹配：完整匹配（含锚点）优先，否则取同文件的第一项（父节）
    let best: HTMLElement | null = null;
    for (let j = 0; j < api.tocFlat.length; j++) {
        const f = api.tocFlat[j];
        if (!f.el || !f.href) continue;
        if (href.indexOf(f.href.split("#")[0]) !== -1) {
            if (f.href === href) { best = f.el; break; }
            if (!best) best = f.el;
        }
    }
    for (let k = 0; k < api.tocFlat.length; k++) {
        if (api.tocFlat[k].el) api.tocFlat[k].el.classList.toggle("epub-mini__toc-item--active", api.tocFlat[k].el === best);
    }
}
