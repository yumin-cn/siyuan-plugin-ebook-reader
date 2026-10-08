declare module "*.png" {
    const src: string;
    export default src;
}
declare module "*.png?inline" {
    const src: string;
    export default src;
}

export {};

declare global {
    interface Window {
        siyuan: any;
        __EPUB_MINI__?: {
            openEpub: (path: string, split?: boolean) => any;
        };
    }
}
