import { launch as puppeteerLaunch, } from "puppeteer-core";
import * as path from "path";
import { Transform } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
// Handle cases where import.meta.url might not be a file:// URL
let __filename;
let __dirname;
try {
    if (import.meta.url && import.meta.url.startsWith('file://')) {
        console.log("19: import.meta.url", import.meta.url);
        __filename = fileURLToPath(import.meta.url);
        console.log("19: __filename", __filename);
        __dirname = path.dirname(__filename);
        console.log("19: __dirname", __dirname);
    }
    else {
        // Fallback for non-file URLs or when import.meta.url is not available
        // This should point to the directory containing the compiled JS file
        console.log("27: import.meta.url", import.meta.url);
        __dirname = path.dirname(new URL(import.meta.url || 'file:///dist/PuppeteerStream.js').pathname);
        console.log("27: __dirname", __dirname);
        __filename = path.join(__dirname, 'PuppeteerStream.js');
        console.log("27: __filename", __filename);
    }
}
catch (error) {
    // Final fallback - assume we're in a dist directory
    console.log("35: process.cwd()", process.cwd());
    __dirname = path.resolve(process.cwd(), 'dist');
    console.log("35: __dirname", __dirname);
    __filename = path.join(__dirname, 'PuppeteerStream.js');
    console.log("35: __filename", __filename);
}
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
    if (!opts.extensionPath) {
        // Use the fallback __dirname that was calculated at the top of the file
        opts.extensionPath = path.join(__dirname, "..", "extension");
    }
    addToArgs("--load-extension=", opts.extensionPath);
    addToArgs("--disable-extensions-except=", opts.extensionPath);
    addToArgs("--allowlisted-extension-id=", extensionId);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUHVwcGV0ZWVyU3RyZWFtLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL1B1cHBldGVlclN0cmVhbS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQ04sTUFBTSxJQUFJLGVBQWUsR0FJekIsTUFBTSxnQkFBZ0IsQ0FBQztBQUN4QixPQUFPLEtBQUssSUFBSSxNQUFNLE1BQU0sQ0FBQztBQUM3QixPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sUUFBUSxDQUFDO0FBQ25DLE9BQU8sU0FBUyxFQUFFLEVBQUUsZUFBZSxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBRWhELE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFFcEMsZ0VBQWdFO0FBQ2hFLElBQUksVUFBa0IsQ0FBQztBQUN2QixJQUFJLFNBQWlCLENBQUM7QUFFdEIsSUFBSTtJQUNILElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUFFO1FBQzdELE9BQU8sQ0FBQyxHQUFHLENBQUMscUJBQXFCLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNwRCxVQUFVLEdBQUcsYUFBYSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDNUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsRUFBRSxVQUFVLENBQUMsQ0FBQztRQUMxQyxTQUFTLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUNyQyxPQUFPLENBQUMsR0FBRyxDQUFDLGVBQWUsRUFBRSxTQUFTLENBQUMsQ0FBQztLQUN4QztTQUFNO1FBQ04sc0VBQXNFO1FBQ3RFLHFFQUFxRTtRQUNyRSxPQUFPLENBQUMsR0FBRyxDQUFDLHFCQUFxQixFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENB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