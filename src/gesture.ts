/* 手机端横滑手势：用① 主轴锁定 ② 回勾检测 ③ 长滑兜底三道防线，解决「向上看书被
 * 误判成左滑退出阅读器」。判定阈值不变（横移 ≥60px 且 ≥1.5×纵移），手感保持。
 * 全部监听 passive:true，不干预原生滚动。 */

const LOCK_PX = 5;        /* 主轴锁定门槛：首超此位移即判主轴 */
const MIN_PX = 60;        /* 横滑最短净位移（沿用旧阈值） */
const RATIO = 1.5;        /* 横移须 ≥ 纵移×此比例（沿用旧阈值） */
const TIME_LIMIT = 1000;  /* 手势时长超过此值时，须横移超屏宽 1/3 才算数（思源 touch.ts:309 同款） */

export function bindHorizontalSwipe(
    target: HTMLElement | Document,
    onSwipe: (dir: "left" | "right") => void,
): void {
    let sx = 0, sy = 0, t0 = 0;
    let axis: "" | "x" | "y" = "";  /* 主轴锁定结果：锁定后不再改判 */
    let firstDir = 0;               /* 首次横方向：1 = 右，-1 = 左 */
    let reversed = false;           /* 回勾中（可撤销：转回主方向即清除） */
    let prevX = 0;

    target.addEventListener("touchstart", function (ev: TouchEvent) {
        const t = ev.touches[0];
        sx = t.clientX; sy = t.clientY; t0 = Date.now();
        axis = ""; firstDir = 0; reversed = false; prevX = t.clientX;
    }, { passive: true });

    target.addEventListener("touchmove", function (ev: TouchEvent) {
        const t = ev.touches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (!axis) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return;
            axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";  /* 一锤定音，之后不再改判 */
            if (axis === "x") firstDir = dx > 0 ? 1 : -1;
        }
        if (axis === "x") {
            const moving = t.clientX - prevX;
            if (moving > 0) reversed = firstDir !== 1;       /* 掉头即记，转回主方向即清 */
            else if (moving < 0) reversed = firstDir !== -1;
        }
        prevX = t.clientX;
    }, { passive: true });

    target.addEventListener("touchend", function (ev: TouchEvent) {
        if (axis !== "x" || reversed) return;                /* 锁竖 / 犹豫 → 本次作废 */
        const t = ev.changedTouches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) < MIN_PX || Math.abs(dx) < Math.abs(dy) * RATIO) return;
        if (Date.now() - t0 >= TIME_LIMIT && Math.abs(dx) <= window.innerWidth / 3) return;
        onSwipe(dx < 0 ? "left" : "right");
    }, { passive: true });
}
