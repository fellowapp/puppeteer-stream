import { launch as puppeteerLaunch, } from "puppeteer-core";
import * as path from "path";
import { Transform } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionId = "jjndjgheafjngoipoacpjgeicjeomjli";
let currentIndex = 0;
const pageUrlToIndex = new Map();
let port;
export const wss = (async () => {
    for (let i = 55200; i <= 65535; i++) {
        const ws = new WebSocketServer({ port: i });
        const promise = await Promise.race([
            new Promise((resolve) => {
                ws.on("error", (e) => {
                    resolve(!e.message.includes("EADDRINUSE"));
                });
            }),
            new Promise((resolve) => {
                ws.on("listening", () => {
                    resolve(true);
                });
            }),
        ]);
        if (promise) {
            port = i;
            return ws;
        }
    }
})();
export async function launch(arg1, opts) {
    //if puppeteer library is not passed as first argument, then first argument is options
    // @ts-ignore
    if (typeof arg1.launch != "function")
        opts = arg1;
    if (!opts)
        opts = {};
    if (!opts.args)
        opts.args = [];
    function addToArgs(arg, value) {
        if (!value) {
            if (opts.args.includes(arg))
                return;
            return opts.args.push(arg);
        }
        let found = false;
        opts.args = opts.args.map((x) => {
            if (x.includes(arg)) {
                found = true;
                return x + "," + value;
            }
            return x;
        });
        if (!found)
            opts.args.push(arg + value);
    }
    if (!Array.isArray(opts.enableExtensions))
        opts.enableExtensions = [];
    opts.enableExtensions.push(path.join(__dirname, "..", "extension"));
    opts.pipe = true;
    addToArgs("--autoplay-policy=no-user-gesture-required");
    addToArgs("--auto-accept-this-tab-capture");
    if (opts.defaultViewport?.width && opts.defaultViewport?.height) {
        opts.args.push(`--window-size=${opts.defaultViewport.width},${opts.defaultViewport.height}`);
        opts.args.push(`--ozone-override-screen-size=${opts.defaultViewport.width},${opts.defaultViewport.height}`);
    }
    // @ts-ignore
    opts.headless = opts.headless === "new" ? "new" : false;
    if (opts.headless) {
        if (!opts.ignoreDefaultArgs)
            opts.ignoreDefaultArgs = [];
        if (Array.isArray(opts.ignoreDefaultArgs) && !opts.ignoreDefaultArgs.includes("--mute-audio"))
            opts.ignoreDefaultArgs.push("--mute-audio");
        if (!opts.args.includes("--headless=new"))
            opts.args.push("--headless=new");
    }
    let browser;
    // @ts-ignore
    if (typeof arg1.launch == "function") {
        // @ts-ignore
        browser = await arg1.launch(opts);
    }
    else {
        browser = await puppeteerLaunch(opts);
    }
    if (opts.allowIncognito) {
        const settings = await browser.newPage();
        await settings.goto(`chrome://extensions/?id=${extensionId}`);
        await settings.evaluate(() => {
            document
                .querySelector("extensions-manager")
                .shadowRoot.querySelector("#viewManager > extensions-detail-view.active")
                .shadowRoot.querySelector("div#container.page-container > div.page-content > div#options-section extensions-toggle-row#allow-incognito")
                .shadowRoot.querySelector("label#label input")
                .click();
        });
        await settings.close();
    }
    (await browser.newPage()).goto(`chrome-extension://${extensionId}/options.html#${port}`);
    const old_browser_close = browser.close;
    browser.close = async () => {
        for (const page of await browser.pages()) {
            if (!page.url().startsWith(`chrome-extension://${extensionId}/options.html`)) {
                await page.close();
            }
        }
        const extension = await getExtensionPage(browser);
        await extension.evaluate(async () => {
            return chrome.tabs.query({});
        });
        if (opts.closeDelay) {
            await new Promise((r) => setTimeout(r, opts.closeDelay));
        }
        await old_browser_close.call(browser);
    };
    return browser;
}
export async function getExtensionPage(browser) {
    const extensionTarget = await browser.waitForTarget((target) => {
        return target.type() === "page" && target.url().startsWith(`chrome-extension://${extensionId}/options.html`);
    });
    if (!extensionTarget)
        throw new Error("cannot load extension");
    const videoCaptureExtension = await extensionTarget.page();
    if (!videoCaptureExtension)
        throw new Error("cannot get page of extension");
    return videoCaptureExtension;
}
let mutex = false;
let queue = [];
function lock() {
    return new Promise((res) => {
        if (!mutex) {
            mutex = true;
            return res(null);
        }
        queue.push(res);
    });
}
function unlock() {
    if (queue.length)
        queue.shift()();
    else
        mutex = false;
}
export async function getStream(page, opts) {
    if (!opts.audio && !opts.video)
        throw new Error("At least audio or video must be true");
    if (!opts.mimeType) {
        if (opts.video)
            opts.mimeType = "video/webm";
        else if (opts.audio)
            opts.mimeType = "audio/webm";
    }
    if (!opts.frameSize)
        opts.frameSize = 20;
    const retryPolicy = Object.assign({}, { each: 20, times: 3 }, opts.retry);
    const extension = await getExtensionPage(page.browser());
    const highWaterMarkMB = opts.streamConfig?.highWaterMarkMB || 8;
    const index = currentIndex++;
    pageUrlToIndex.set(page.url(), index);
    await lock();
    await page.bringToFront();
    const [tab] = await extension.evaluate(async (x) => {
        // @ts-ignore
        return chrome.tabs.query(x);
    }, opts.tabQuery || {
        active: true,
    });
    unlock();
    if (!tab)
        throw new Error("Cannot find tab, try providing your own tabQuery to getStream options");
    const stream = new Transform({
        highWaterMark: 1024 * 1024 * highWaterMarkMB,
        transform(chunk, encoding, callback) {
            callback(null, chunk);
        },
    });
    function onConnection(ws, req) {
        const url = new URL(`http://localhost:${port}${req.url}`);
        if (url.searchParams.get("index") != index.toString())
            return;
        async function close() {
            if (!stream.readableEnded && !stream.writableEnded)
                stream.end();
            if (!extension.isClosed() && extension.browser().isConnected()) {
                // @ts-ignore
                extension.evaluate((index) => STOP_RECORDING(index), index);
            }
            if (ws.readyState != WebSocket.CLOSED) {
                setTimeout(() => {
                    // await pending messages to be sent and then close the socket
                    if (ws.readyState != WebSocket.CLOSED)
                        ws.close();
                }, opts.streamConfig?.closeTimeout ?? 5000);
            }
            (await wss).off("connection", onConnection);
        }
        ws.on("message", (data) => {
            stream.write(data);
        });
        ws.on("close", close);
        page.on("close", close);
        stream.on("close", close);
    }
    (await wss).on("connection", onConnection);
    await lock();
    await page.bringToFront();
    await assertExtensionLoaded(extension, retryPolicy);
    // Invoke extension via keyboard command to grant activeTab (Ctrl/Command+Shift+Y)
    const isMac = process.platform === 'darwin';
    await page.keyboard.down(isMac ? 'Meta' : 'Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyY');
    await page.keyboard.up('Shift');
    await page.keyboard.up(isMac ? 'Meta' : 'Control');
    // Small delay to let Chrome register the invocation
    await new Promise((r) => setTimeout(r, 100));
    await extension.evaluate(
    // @ts-ignore
    (settings) => START_RECORDING(settings), { ...opts, index, tabId: tab.id });
    unlock();
    return stream;
}
async function assertExtensionLoaded(ext, opt) {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    for (let currentTick = 0; currentTick < opt.times; currentTick++) {
        // @ts-ignore
        if (await ext.evaluate(() => typeof START_RECORDING === "function"))
            return;
        await wait(Math.pow(opt.each, currentTick));
    }
    throw new Error("Could not find START_RECORDING function in the browser context");
}
export async function pauseStream(page) {
    const index = pageUrlToIndex.get(page.url());
    if (!index)
        throw new Error("Cannot find index of page");
    const extension = await getExtensionPage(page.browser());
    await extension.evaluate(
    // @ts-ignore
    (settings) => PAUSE_RECORDING(settings), index);
}
export async function resumeStream(page) {
    const index = pageUrlToIndex.get(page.url());
    if (!index)
        throw new Error("Cannot find index of page");
    const extension = await getExtensionPage(page.browser());
    await extension.evaluate(
    // @ts-ignore
    (settings) => RESUME_RECORDING(settings), index);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUHVwcGV0ZWVyU3RyZWFtLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL1B1cHBldGVlclN0cmVhbS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQ04sTUFBTSxJQUFJLGVBQWUsR0FJekIsTUFBTSxnQkFBZ0IsQ0FBQztBQUN4QixPQUFPLEtBQUssSUFBSSxNQUFNLE1BQU0sQ0FBQztBQUM3QixPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sUUFBUSxDQUFDO0FBQ25DLE9BQU8sU0FBUyxFQUFFLEVBQUUsZUFBZSxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBRWhELE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFFcEMsTUFBTSxVQUFVLEdBQUcsYUFBYSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDbEQsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUUzQyxNQUFNLFdBQVcsR0FBRyxrQ0FBa0MsQ0FBQztBQUN2RCxJQUFJLFlBQVksR0FBRyxDQUFDLENBQUM7QUFDckIsTUFBTSxjQUFjLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7QUFTakQsSUFBSSxJQUFZLENBQUM7QUFFakIsTUFBTSxDQUFDLE1BQU0sR0FBRyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7SUFDOUIsS0FBSyxJQUFJLENBQUMsR0FBRyxLQUFLLEVBQUUsQ0FBQyxJQUFJLEtBQUssRUFBRSxDQUFDLEVBQUUsRUFBRTtRQUNwQyxNQUFNLEVBQUUsR0FBRyxJQUFJLGVBQWUsQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQzVDLE1BQU0sT0FBTyxHQUFHLE1BQU0sT0FBTyxDQUFDLElBQUksQ0FBQztZQUNsQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFO2dCQUN2QixFQUFFLENBQUMsRUFBRSxDQUFDLE9B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