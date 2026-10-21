// ヘッドレス Chrome を CDP で操作する最小の道具 (練習モードの実機確認用)
const PORT = Number(process.env.CDP_PORT || 9333);
export async function openPage({ width = 390, height = 844, mobile = true } = {}) {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = ng; });
    let id = 0; const waits = new Map(); const logs = []; const errors = [];
    const net = []; const dialogs = []; const navs = [];
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && waits.has(m.id)) { const { ok, ng } = waits.get(m.id); waits.delete(m.id); m.error ? ng(new Error(m.error.message)) : ok(m.result); return; }
        if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Network.requestWillBeSent') net.push({ method: m.params.request.method, url: m.params.request.url });
        if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) navs.push(`${Date.now()} nav ${m.params.frame.url}`);
        if (m.method === 'Page.loadEventFired') navs.push(`${Date.now()} load`);
        if (m.method === 'Page.javascriptDialogOpening') {
            dialogs.push(`[${m.params.type}] ${m.params.message}`);
            ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true }, sessionId: m.sessionId }));
        }
    };
    const send = (method, params = {}, sessionId) => new Promise((ok, ng) => {
        const i = ++id; waits.set(i, { ok, ng });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => send(method, params, sessionId);
    await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');
    await S('Network.setCacheDisabled', { cacheDisabled: true });
    await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const page = {
        logs, errors, net, dialogs, navs,
        goto: async (url, waitMs = 2500) => { await S('Page.navigate', { url }); await new Promise(r => setTimeout(r, waitMs)); },
        eval: async (expr) => {
            const r = await Promise.race([S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
                new Promise((_, ng) => setTimeout(() => ng(new Error('eval が 20 秒返りません')), 20000))]);
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result.value;
        },
        shot: async (file, full = false) => {
            const fs = await import('node:fs');
            let clip;
            if (full) {
                const m = await S('Page.getLayoutMetrics');
                clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 6000), scale: 1 };
            }
            const r = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, ...(clip ? { clip } : {}) });
            fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        },
        wait: (ms) => new Promise(r => setTimeout(r, ms)),
        close: async () => { await send('Target.closeTarget', { targetId }); ws.close(); },
    };
    return page;
}
