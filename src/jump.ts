/* 跳转串行化：意图寄存器 + 单飞工作者 + 门闸 + 一次写入。入口只登记 requestJump，
 * last-write-wins，执行期最多一个跳转在跑。
 *
 * 五条硬约定：
 *   一、所有跳转入口只调 requestJump() 登记意图；不得直接调 rend.display。
 *   二、任何会改几何的机制（resize 回位 / epub.js 内部自回位 / 补章 / trim）在
 *       自己入口问一次 isJumping()，不要自建守卫。
 *   三、全链路只发一次 display，且必须带超时兜底（队列死链时 promise 永不 settle）。
 *   四、完成判定不看 display promise（被新 display 顶掉时会假 resolve）；就绪真值
 *       = chapterReady()。未就绪只投 check() 油门，绝不重发 display（会命中 clear()
 *       分支销毁全部视图）。
 *   五、收尾等「目标就绪 + 布局连续 3 拍安静 + 无待加载图片」，量一次坐标、写一次
 *       scrollTop（值不变则不写），偏差 ≤3px 才收工。绝不在 fill/回流进行中写入 ——
 *       每次写都驱动 epub.js 的 scroll → check/update/trim 连锁，等于自添竞争源头。
 *
 * 落点对齐不用 epub.js 的 moveTo：display(cfi) 的内部滚动只对跳转瞬间正确，fill()
 * 补章与图片回流都会平移内容，必须事后用真值坐标自行对齐（alignCfiTop）。
 * 视图缺位（被 trim 摘出视图池）时收尾通道重建一次，限 2 次、间隔 600ms —— 这是
 * 全链路唯一允许二次 display 的情形。队列层的死链免疫见 epubq.ts。 */
import { EpubCFI } from "@likecoin/epub-ts";
import type { ReaderApi } from "./types";

const JUMP_TOP_PAD = 24;      /* 落点距容器顶的留白（px） */
const DEBOUNCE_MS = 180;      /* 意图稳定窗口：这么久没有新意图才执行（连点合并） */
const READY_MAX_TICKS = 60;   /* 就绪等待上限 ≈ 12s */
const SETTLE_MS = 200;        /* 采样间隔 */
/* 单轮执行看门狗（per-execution，不是 per-request）：判据是「无进展时长」——
 * 正常链路每一拍都会 beat，只有回调彻底不来时它才累积。刻意不挂在 requestJump
 * 上：那样用户连点会把它无限刷新，死锁被永久续命，正是「点什么都没用」的放大器。 */
const EXEC_STALL_MS = 12000;
/* display 最长等待：队列死链时 promise 永不 settle（then/catch 都不触发），
 * 执行器就再无定时器可依、只能干等看门狗。超时即视为「未确认就绪」，转
 * 「就绪探测 + check 兜底」通道（epubq.ts 的队列自愈通常此时已把它救活）。 */
const DISPLAY_MAX_MS = 8000;

/* ---------- 目标 → spine 索引（CFI 与 href 通用） ----------
 * href 可能带锚点（chapter.xhtml#p3），book.spine.get 同时接受 href 字符串与 index
 * （0.3.93 的 spine.get 自带去 #fragment）。解析不出来返回 -1。 */
function targetSpineIdx(a: any, target: string): number {
    try {
        if (String(target).indexOf("epubcfi(") === 0) return new EpubCFI(target).spinePos;
    } catch (e) {}
    try {
        const sec = a.book && a.book.spine && a.book.spine.get ? a.book.spine.get(String(target)) : null;
        if (sec && typeof sec.index === "number") return sec.index;
    } catch (e) {}
    return -1;
}

/* ---------- 就绪真值 ----------
 * 目标章视图的内容高度（视图未就绪返回 -1）。「就绪」的唯一真值 = 内容真的
 * 画出来了，不看 promise 说什么。 */
function viewHeight(a: any, target: string): number {
    try {
        const views = a.rend && a.rend.manager && a.rend.manager.views;
        if (!views || !views.displayed) return -1;
        const idx = targetSpineIdx(a, target);
        if (idx < 0) return -1;
        const list = views.displayed() || [];
        for (let i = 0; i < list.length; i++) {
            const v = list[i];
            if (!v || !v.section || v.section.index !== idx) continue;
            const doc = (v.contents && v.contents.doc) || (v.iframe && v.iframe.contentDocument);
            if (!doc || !doc.body) return -1;
            return doc.body.scrollHeight;
        }
    } catch (e) {}
    return -1;
}

/* 目标章视图是否已真正就绪（阈值 30px：低于它的章不存在）。 */
export function chapterReady(a: any, target: string): boolean {
    return viewHeight(a, target) >= 30;
}

/* ---------- 坐标：目标在「滚动内容坐标系」里的绝对 y ----------
 * 该量随用户滚动抵消（ifrRect.top - contRect.top 减、cont.scrollTop 加），
 * 只有真实布局变化（补章/图片回流）才会改变它 —— settle 采样靠这个分辨
 * 「布局动了」和「用户自己滚了」。目标章视图未就绪返回 null。 */
function cfiAbsTop(a: ReaderApi, cfi: string): { abs: number, cont: HTMLElement, ifrDy: number, pTop: number } | null {
    try {
        const rend = a.rend;
        const views = rend && rend.manager && rend.manager.views;
        if (!views || !views.displayed) return null;
        const spineIdx = targetSpineIdx(a, cfi);
        if (spineIdx < 0) return null;
        const list = views.displayed() || [];
        for (let i = 0; i < list.length; i++) {
            const v = list[i];
            if (!v || !v.section || v.section.index !== spineIdx) continue;
            const cont = a.viewEl ? (a.viewEl.querySelector(".epub-container") as HTMLElement) : null;
            const ifr = v.iframe;
            if (!cont || !ifr || !v.contents) return null;
            /* 视图未就绪守卫：iframe 已挂载但内容还没写进去（快速连点下连环
             * clear/重建 + 队列卡顿，实测空白期 body.scrollHeight=0），此时
             * locationOf 查不到目标返回 (0,0) 假坐标——拿它对齐会把滚动钉死
             * 在 0 并在假象上「稳定」提前 finish。未渲染就报未就绪。 */
            const doc = v.contents.doc || ifr.contentDocument;
            if (!doc || !doc.body || doc.body.scrollHeight < 30) return null;
            const p = v.contents.locationOf(cfi); /* iframe 文档视口系坐标 */
            const contRect = cont.getBoundingClientRect();
            const ifrRect = ifr.getBoundingClientRect();
            const ifrDy = ifrRect.top - contRect.top;
            const pTop = (p && p.top) || 0;
            const abs = ifrDy + cont.scrollTop + pTop;
            return { abs: abs, cont: cont, ifrDy: ifrDy, pTop: pTop };
        }
    } catch (e) { console.warn("[EPUB-MINI] 跳转对齐失败：", e); }
    return null;
}

/* 把目标精确滚到容器顶部。返回 false = 目标章视图还没就绪（外层续等）。
 * miss 不逐条打日志（连环重建时风暴刷屏），miss 计入 ticks 由 finish 汇总。 */
function alignCfiTop(a: ReaderApi, cfi: string): boolean {
    const hit = cfiAbsTop(a, cfi);
    if (!hit) return false;
    const newSt = Math.max(0, hit.abs - JUMP_TOP_PAD);
    /* ★ 值没变就绝不写：空写照样驱动 epub.js 的 scroll → check/update/trim 连锁，每轮都
     * 伴随视图重建与虚拟化（实测一次跳转里有 4 次这样的无意义空写）。 */
    if (Math.abs(newSt - hit.cont.scrollTop) < 1) {
        console.log("[JUMP] align 跳过（已对齐）st=" + Math.round(hit.cont.scrollTop) + " abs=" + Math.round(hit.abs));
        return true;
    }
    console.log("[JUMP] align ifrDy=" + Math.round(hit.ifrDy) + " st=" + Math.round(hit.cont.scrollTop)
        + " pTop=" + Math.round(hit.pTop) + " abs=" + Math.round(hit.abs) + " -> 新st=" + Math.round(newSt));
    hit.cont.scrollTop = newSt;
    return true;
}

/* 目标章 iframe 内尚未加载完成的图片数（收工门控用）。
 * 图片没加载完时高度是 0/占位，其下所有文字坐标被低估 → 对齐偏前
 * （跨书切换 iframe 重建图片重载，实测页 14 落 12）；图在收工后才加载完就
 * 没人修了——所以还有图在加载就不许 finish（回流必然还会来）。img 加载失败
 * complete 也是 true，不会卡死；CSS 背景图检测不到，接受。 */
function cfiPendingImgs(a: ReaderApi, cfi: string): number {
    try {
        const spineIdx = targetSpineIdx(a, cfi);
        if (spineIdx < 0) return 0;
        const views = a.rend && a.rend.manager && a.rend.manager.views;
        const list = views && views.displayed ? (views.displayed() || []) : [];
        for (let i = 0; i < list.length; i++) {
            const v = list[i];
            if (!v || !v.section || v.section.index !== spineIdx) continue;
            const doc = (v.contents && v.contents.doc) || (v.iframe && v.iframe.contentDocument);
            if (!doc || !doc.images) return 0;
            let n = 0;
            for (let j = 0; j < doc.images.length; j++) {
                if (!doc.images[j].complete) n++;
            }
            return n;
        }
    } catch (e) {}
    return 0;
}

/* 往管理队列投一次 check()（替 epub.js 按启动键）：display 空转 resolve 而 views=0
 * 是 epub.js open 竞态的坑，重发 display 治不了它，真正建视图要靠 check/fill 自己跑。
 * 队列死链免疫与自愈见 epubq.ts。 */
function pokeQueue(a: any): void {
    try {
        const mgr = a.rend && a.rend.manager;
        if (mgr && mgr.q && typeof mgr.q.enqueue === "function") {
            mgr.q.enqueue(function () {
                try { return Promise.resolve(mgr.check()); } catch (e) { return Promise.resolve(); }
            });
        }
    } catch (e) {}
}

/* ---------- 门闸（唯一的跳转活动判据） ---------- */
export function gateOf(a: any): any {
    if (!a.__gate) a.__gate = { active: false, seq: 0, target: "" };
    return a.__gate;
}
/* 所有几何修改源（resize 回位 / fixup / 贴边补章 / epub 内部自回位）都问这一个函数 */
export function isJumping(a: any): boolean {
    return !!(a && a.__gate && a.__gate.active);
}
/* 代际号：resize 回位抢拍 / 长时间定时器用它判断「期间是否发生过新跳转」 */
export function jumpSeqOf(a: any): number {
    return (a && a.__jumpSeq) || 0;
}

/* rend.display 守卫（幂等）：epub.js 内部会自发 display(location.start.cfi)
 * —— 尺寸回流、flow、direction、书内链接都会触发，且 location 是滞后值。
 * 跳转期间它排进队列的执行在跳转之后 → 把用户拽回跳转前（点目录被拉回标注位置）。
 * 规则与门闸一致：跳转中只有「目标 == 当前意图」的 display 合法，其余假 resolve
 * 不抛错；门闸开后一律放行。 */
export function installGuard(a: any): void {
    try {
        if (!a || a.__diag || !a.rend) return;
        a.__diag = true;
        const rend = a.rend;
        const oRendDisplay = rend.display.bind(rend);
        rend.display = function (t: any) {
            const g = gateOf(a);
            if (g.active && String(t) !== String(g.target)) {
                const stack = String((new Error() as any).stack || "").split("\n").slice(2, 7).join(" | ");
                console.log("[Q] display 拦截（跳转活动中，非当前意图目标）target=" + String(t).slice(0, 50) + " 栈:" + stack);
                return Promise.resolve();
            }
            console.log("[Q] rend.display(" + String(t).slice(0, 70) + ")");
            return oRendDisplay(t);
        };
        /* manager 级补丁（trim 守卫 / 队列 / 诊断桩）统一在 epubq.ts 的
         * installManagerGuards 里装 —— 那里在 rendition 创建后立刻调用，一定拿得到
         * manager（若首次调用时 rend.manager 未就绪，manager 层就会永远没人管）。 */
        console.log("[Q] rend.display 守卫安装完成");
    } catch (e) { console.warn("[Q] 桩安装失败：", e); }
}

/* ---------- 取消已排队的 resize 回位定时器 ----------
 * 回位目标（跳转前抢拍的旧位置）已过时，执行它只会把位置拽回跳转前。 */
function cancelResizeBack(a: any): void {
    if (a.__resizeBackTimers && a.__resizeBackTimers.length) {
        try { a.__resizeBackTimers.forEach(function (t: any) { clearTimeout(t); }); } catch (e) {}
        a.__resizeBackTimers = null;
    }
}

/* L1 意图登记：所有跳转入口的唯一通道。入口只做三件事 —— 覆盖写意图、关门、唤醒
 * 工作者，绝不在这里执行 display。align 按目标形态自动判定（CFI 走真值坐标对齐、
 * href 走 epub.js 原生定位），调用方无需关心。 */
export function requestJump(a: any, target: string): void {
    if (!a || !a.rend) return;
    installGuard(a);
    cancelResizeBack(a);
    const it = {
        target: String(target),
        align: String(target).indexOf("epubcfi(") === 0,
        seq: (a.__jumpSeq = (a.__jumpSeq || 0) + 1), /* 代际号：每次请求递增 */
        at: Date.now()
    };
    a.__intent = it;
    a.__want = it.target;                           /* fixup 重发瞄准同一目标（兼容字段） */
    const g = gateOf(a);
    g.active = true;                                /* 意图一到就关门：几何修改源立即闭嘴 */
    g.seq = it.seq;
    g.target = it.target;
    a.__edgeMuteUntil = Date.now() + 1500;          /* 贴边补章静默窗（双保险，主判据是 isJumping） */
    const working = a.__jumpWorker && a.__jumpWorker.running;
    console.log("[JOB] 登记 seq=" + it.seq + " align=" + it.align + " target=" + it.target.slice(0, 50)
        + (working ? " （工作者执行中，将覆盖后重跑）" : ""));
    runWorker(a);
}

/* ---------- L2 单飞工作者 ----------
 * 常驻循环，任意时刻最多一个 executeJump 在跑；执行中 seq 变了就丢弃
 * 当前结果、立刻重取最新意图——这就是「只认最后一次点击」。 */
function runWorker(a: any): void {
    const w: any = a.__jumpWorker = a.__jumpWorker || { running: false };
    if (w.running) return;
    w.running = true;
    const loop = function () {
        const it: any = a.__intent;
        if (!it) { /* 无待办意图：开门，工作者退场 */
            w.running = false;
            gateOf(a).active = false;
            return;
        }
        const wait = DEBOUNCE_MS - (Date.now() - it.at);
        if (wait > 0) { /* 意图稳定窗：等用户点完（期间新点击会刷新 at，继续等） */
            setTimeout(loop, Math.min(wait, 50));
            return;
        }
        try {
            executeJump(a, it, function () {
                if (a.__intent && a.__intent.seq !== it.seq) { /* 执行期间来了新意图：立刻重取 */
                    console.log("[JOB] 意图被 seq=" + a.__intent.seq + " 覆盖，丢弃本轮结果，重取");
                    setTimeout(loop, 0);
                    return;
                }
                a.__intent = null;
                w.running = false;
                gateOf(a).active = false; /* 最后一个意图收工 → 开门 */
                console.log("[JOB] 门闸开启（无待办意图）");
            });
        } catch (e) {
            /* 执行器同步抛出（epub.js 内部异常等）：必须复位，否则门闸永久关闭 */
            console.warn("[JOB] 执行器异常，强制复位门闸：", e);
            a.__intent = null;
            w.running = false;
            gateOf(a).active = false;
        }
    };
    loop();
}

/* ---------- 执行器：一次意图 = 一次 display + 就绪等待 + 对齐/稳定收尾 ---------- */
function executeJump(a: any, it: any, onDone: () => void): void {
    const target = it.target, align = it.align;
    const book = String(a.path || "").split("/").pop();
    console.log("[JUMP] 执行<" + book + "> seq=" + it.seq + " target=" + target.slice(0, 60) + " align=" + align);

    const tk: any = { seq: it.seq, target: target, done: false };
    let settled = false;
    /* 本轮执行看门狗：判据是「有没有进展」而不是「跑了多久」（正常长尾可到 28s，用总
     * 时长必然误伤）。无进展超 EXEC_STALL_MS 即复位：递增代际号让旧执行器的回调
     * 全部作废（否则其 waitReady/settle 仍自认活着并抢几何）+ 开门 + 释放工作者。 */
    let lastBeat = Date.now();
    const beat = function () { lastBeat = Date.now(); };
    const watch = setInterval(function () {
        if (settled) { clearInterval(watch); return; }
        if (Date.now() - lastBeat < EXEC_STALL_MS) return;
        clearInterval(watch);
        console.warn("[JOB] 本轮执行无进展超时（防死锁）seq=" + it.seq + " target=" + target.slice(0, 40));
        const pendingNext = (a.__intent && a.__intent.seq !== it.seq) ? a.__intent.target : null;
        a.__jumpSeq = (a.__jumpSeq || 0) + 1;
        a.__intent = null;
        const g2 = gateOf(a);
        g2.active = false;
        g2.seq = a.__jumpSeq;
        if (a.__jumpWorker) a.__jumpWorker.running = false;
        if (pendingNext) requestJump(a, pendingNext);
    }, 1000);
    /* done 幂等：正常 finish / 被新意图中止 / 异常，都只走一次，且都摘掉 rendered 监听 */
    const done = function () {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        try { onDone(); } catch (e) {}
    };
    /* 存活判据：门闸代际号还是我 + 我没 finish */
    const alive = function (): boolean { return gateOf(a).seq === tk.seq && !tk.done; };

    /* 采样状态 */
    let lastAbs = NaN, quiet = 0, ticks = 0;        /* align 通道 */
    let lastH = -1, stable2 = 0, ticks2 = 0;        /* href 通道 */
    let phaseB = false, verify = 0;                 /* align 通道：写入后校验阶段 */
    let repairs = 0, lastRepairAt = 0;              /* 视图缺位重建（限次限速） */

    /* 目标章视图是否还在视图池里。epub.js 的 trim()/erase() 会把视图（含 iframe）
     * 整个从池中摘掉：此后内容永久空白，pokeQueue（投 check）救不回来，只有重建。 */
    const viewPresent = function (): boolean {
        try {
            const views = a.rend && a.rend.manager && a.rend.manager.views;
            const idx = targetSpineIdx(a, target);
            if (!views || !views.all || idx < 0) return true; /* 判不了就不当作缺位 */
            const all = views.all() || [];
            for (let i = 0; i < all.length; i++) {
                const v = all[i];
                if (v && v.section && v.section.index === idx) return true;
            }
            return false;
        } catch (e) { return true; }
    };

    /* 重建：全链路唯一允许二次 display 的情形 —— 目标视图确实已被移出视图池，不重建
     * 就是永久空白。其余「未就绪」只用 check() 油门：视图已 add 但 displayed=false
     * 时重发 display 会命中 clear() 销毁重建（每 400ms 一轮 ≈ 33 次 iframe 重建，
     * 内容永远画不完）。限次 + 限速。 */
    const repair = function (why: string): boolean {
        if (repairs >= 2) return false;
        if (Date.now() - lastRepairAt < 600) return false;
        if (targetSpineIdx(a, target) < 0) return false;
        repairs++; lastRepairAt = Date.now();
        console.warn("[JUMP] 目标章视图已不在视图池（" + why + "）→ 重建一次 repair=" + repairs);
        try { a.rend.display(target); } catch (e) {}
        return true;
    };

    function finish() {
        const ready = chapterReady(a, target);
        const pending = cfiPendingImgs(a, target);
        console.log("[JUMP] finish seq=" + it.seq + " target=" + target.slice(0, 40) + " align=" + align
            + " quiet=" + (align ? quiet : stable2) + " ticks=" + (align ? ticks : ticks2)
            + " ready=" + ready + " pending=" + pending + " present=" + viewPresent() + " repairs=" + repairs);
        /* 收工必须建立在「真值就绪」上：ready=false 意味着用户看到的就是空白页。
         * 不再允许静默带着空白收工——打红字，日志里一眼能看见。 */
        if (!ready) console.warn("[JUMP] 收工但目标章未就绪（ready=false）：目标视图不在视图池"
            + "或内容未渲染，内容很可能空白。present=" + viewPresent() + " repairs=" + repairs);
        if (gateOf(a).seq === tk.seq) tk.done = true;
        done();
    }

    /* settle（align 通道）：两段式，「一次测量、一次写入」。
     * A 只采样绝不写：等目标 abs y 连续 3 拍（≈600ms）不变且无待加载图片 = 布局安静。
     *   不能在 fill 风暴里写 —— 写的连锁里带视图重建与虚拟化，落点会被卷走，
     *   结果是正文永久空白。
     * B 写一次后校验：偏差 ≤3px 收工，偏大退回 A 重来（总拍数封顶）。
     * 视图缺位直接重建，不干等 —— 缺位只能靠 display 救。 */
    const QUIET_NEED = 3;
    const settleStep = function (): boolean {
        if (!viewPresent()) {
            if (repair("对齐阶段发现视图被摘除")) ticks = Math.min(ticks, 10);
            return true;
        }
        const pending = cfiPendingImgs(a, target);
        const hit = cfiAbsTop(a, target);
        if (!hit) { /* 视图在、内容未就绪：投 check 油门，继续等真值 */
            if (ticks % 5 === 1) pokeQueue(a);
            return true;
        }
        if (!phaseB) {
            if (pending === 0 && !isNaN(lastAbs) && Math.abs(hit.abs - lastAbs) <= 2) quiet++;
            else quiet = 0;
            lastAbs = hit.abs;
            if (quiet >= QUIET_NEED || ticks > READY_MAX_TICKS) {
                phaseB = true; verify = 0;
                if (Math.abs(Math.max(0, hit.abs - JUMP_TOP_PAD) - hit.cont.scrollTop) >= 1) alignCfiTop(a, target);
                else console.log("[JUMP] 布局安静且已对齐，无需写入 abs=" + Math.round(hit.abs));
            }
            return true;
        }
        const err = hit.abs - hit.cont.scrollTop - JUMP_TOP_PAD;
        if (Math.abs(err) <= 3) { finish(); return false; }
        if (++verify > 4) {
            console.warn("[JUMP] 对齐偏差仍 " + Math.round(err) + "px（重排未停），先收工避免互锁");
            finish(); return false;
        }
        console.log("[JUMP] 写入后偏差 " + Math.round(err) + "px → 退回等布局安静再写");
        phaseB = false; quiet = 0; lastAbs = NaN;
        return true;
    };
    const settle = function () {
        beat();
        if (!alive()) { done(); return; }
        ticks++;
        if (!settleStep()) return;
        if (ticks > READY_MAX_TICKS) { finish(); return; }
        setTimeout(settle, SETTLE_MS);
    };

    /* href 通道收尾：不做坐标对齐（落点交给 epub.js 原生定位），但「完成」判定
     * 必须基于真值就绪 + 章内容高度稳定，而非 display promise——假 resolve 会在
     * 视图还没建好时就当完成。高度取目标章 iframe 自己的 body.scrollHeight：
     * 只有该章自身布局（图片/字体回流）才会变它，fill 补其它章不影响，所以
     * 正常跳转 ~0.6s 连续两拍一致即可收工。 */
    const settleHref = function () {
        beat();
        if (!alive()) { done(); return; }
        ticks2++;
        if (!viewPresent()) { /* 视图被摘掉：等不来，重建一次 */
            if (repair("href 通道发现视图被摘除")) ticks2 = Math.min(ticks2, 10);
            if (ticks2 > READY_MAX_TICKS) { finish(); return; }
            setTimeout(settleHref, SETTLE_MS);
            return;
        }
        const pending = cfiPendingImgs(a, target);
        const h = viewHeight(a, target);
        if (h < 30) { /* 视图还没画出来：续等（绝不重发 display 去撞 clear()） */
            if (ticks2 > READY_MAX_TICKS) { finish(); return; }
            if (ticks2 % 5 === 1) pokeQueue(a);
            setTimeout(settleHref, SETTLE_MS);
            return;
        }
        if (h !== lastH) {
            stable2 = 0;
            lastH = h;
            console.log("[JUMP] href 通道高度变化 h=" + h + " pending=" + pending);
        } else if (++stable2 >= 2 && pending === 0) { finish(); return; }
        if (ticks2 > (pending > 0 ? 60 : 40)) { finish(); return; }
        setTimeout(settleHref, SETTLE_MS);
    };

    /* 视图就绪等待通道（★ 绝不重发 display）：
     * 只往队列投 check()「替 epub.js 按启动键」让它自己补视图，然后等真值就绪；
     * 就绪后再进对应通道收尾（对齐 / 稳定采样）。上限 60 拍 ≈ 12s。 */
    let waits = 0;
    const waitReady = function () {
        beat();
        if (!alive()) { done(); return; }
        if (targetSpineIdx(a, target) < 0) {
            /* 目标解析不到章（罕见 href 形态）：退回「display resolve 后静默 800ms
             * 收工」的保守路径，别把可用性赌在探测上 */
            console.log("[JUMP] 目标无法解析到章索引，退回静默收尾 target=" + target.slice(0, 40));
            setTimeout(function () { if (alive()) finish(); }, 800);
            return;
        }
        const present = viewPresent();
        if (!present && repair("就绪等待发现视图缺位")) {
            /* 刚发了重建：等它落地，别急着进收尾通道 */
            if (++waits > READY_MAX_TICKS) { finish(); return; }
            setTimeout(waitReady, SETTLE_MS);
            return;
        }
        if (present && chapterReady(a, target)) {
            if (!align) { lastH = -1; stable2 = 0; ticks2 = 0; settleHref(); return; }
            ticks = 0; lastAbs = NaN; quiet = 0; phaseB = false; verify = 0;
            settle();
            return;
        }
        if (++waits > READY_MAX_TICKS) { console.log("[JUMP] 视图就绪等待超时（不做无意义重建）target=" + target.slice(0, 40)); finish(); return; }
        if (waits % 5 === 1) pokeQueue(a); /* 每 ~1s 补一次油门（投 check，不重发 display） */
        setTimeout(waitReady, SETTLE_MS);
    };

    /* 全链路只在这里发一次 display。★必须带超时兜底：队列一旦死链，queued.promise
     * 既不 resolve 也不reject，执行器就静默挂死在这一行（门闸关着 → 点什么都没用）。
     * 超时只代表「未确认就绪」，转 waitReady 用真值探测，绝不重发 display。 */
    const go = function () {
        beat();
        if (!alive()) { console.log("[JUMP] go 中止（意图已被 newer 接管）me=seq" + it.seq); done(); return; }
        let dispSettled = false;
        const onDisplay = function (why: string, e?: any) {
            if (dispSettled) return;
            dispSettled = true;
            clearTimeout(dispTimer);
            if (!alive()) { done(); return; }
            if (why === "reject") console.warn("[EPUB-MINI] display 失败，转就绪等待通道：", target, e);
            else console.log("[JUMP] display " + why + " seq=" + it.seq + " ready=" + chapterReady(a, target));
            waitReady();
        };
        const dispTimer = setTimeout(function () { onDisplay("超时（队列可能卡死）"); }, DISPLAY_MAX_MS);
        let p: any;
        try {
            p = a.rend.display(target);
        } catch (e: any) {
            onDisplay("同步异常", e);
            return;
        }
        Promise.resolve(p).then(function () { onDisplay("resolved"); }, function (e: any) { onDisplay("reject", e); });
    };
    go();
}

/* ---------- 对外入口：文档标注回链（CFI） ----------
 * 等 rend + __booted（book.ready 后的装配完成标志）再登记意图。
 * 不需要再等「首屏 display 完成」——串行化保证了后登记的意图不会被打断，
 * 若此时首屏意图还没执行（防抖窗内），它直接被本意图覆盖，书首不会白渲染一次。 */
export function jumpToCfi(tab: any, cfi: string): void {
    let tries = 0;
    (function poll() {
        const a = tab && tab.__api;
        if (a && a.rend && a.__booted) {
            requestJump(a, cfi);
        } else if (++tries < 90) {
            setTimeout(poll, 200);
        }
    })();
}
