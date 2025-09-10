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
        __filename = fileURLToPath(import.meta.url);
        __dirname = path.dirname(__filename);
    }
    else {
        // Fallback for non-file URLs or when import.meta.url is not available
        // This should point to the directory containing the compiled JS file
        __dirname = path.dirname(new URL(import.meta.url || 'file:///dist/PuppeteerStream.js').pathname);
        __filename = path.join(__dirname, 'PuppeteerStream.js');
    }
}
catch (error) {
    // Final fallback - assume we're in a dist directory
    __dirname = path.resolve(process.cwd(), 'dist');
    __filename = path.join(__dirname, 'PuppeteerStream.js');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUHVwcGV0ZWVyU3RyZWFtLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL1B1cHBldGVlclN0cmVhbS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQ04sTUFBTSxJQUFJLGVBQWUsR0FJekIsTUFBTSxnQkFBZ0IsQ0FBQztBQUN4QixPQUFPLEtBQUssSUFBSSxNQUFNLE1BQU0sQ0FBQztBQUM3QixPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sUUFBUSxDQUFDO0FBQ25DLE9BQU8sU0FBUyxFQUFFLEVBQUUsZUFBZSxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBRWhELE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFFcEMsZ0VBQWdFO0FBQ2hFLElBQUksVUFBa0IsQ0FBQztBQUN2QixJQUFJLFNBQWlCLENBQUM7QUFFdEIsSUFBSTtJQUNILElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUFFO1FBQzdELFVBQVUsR0FBRyxhQUFhLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUM1QyxTQUFTLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQztLQUNyQztTQUFNO1FBQ04sc0VBQXNFO1FBQ3RFLHFFQUFxRTtRQUNyRSxTQUFTLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEdBQUcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsSUFBSSxpQ0FBaUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ2pHLFVBQVUsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO0tBQ3hEO0NBQ0Q7QUFBQyxPQUFPLEtBQUssRUFBRTtJQUNmLG9EQUFvRDtJQUNwRCxTQUFTLEdBQUcsSUFBSSxDQUFDLE9B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