import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx !== -1 && args[outIdx + 1]
  ? path.resolve(args[outIdx + 1])
  : path.join('/tmp', 'ivcf-ux-screenshots');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(`No Chromium/Chrome binary found. Checked: ${CHROME_CANDIDATES.join(', ')}`);
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const cleanPath = (req.url || '/').split('?')[0];
        const rel = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
        const full = path.resolve(rootDir, rel);
        if (!full.startsWith(rootDir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const data = await fs.readFile(full);
        const ext = path.extname(full);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`JS error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception || {})}`);
    }
    return res.result?.value;
  }

  async screenshot(filepath) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(filepath, Buffer.from(data, 'base64'));
  }

  async touchScroll(x, y, yDistance) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: -yDistance
    });
    await sleep(300);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launchChrome(chromePath, url) {
  const userDataDir = await fs.mkdtemp('/tmp/ivcf-chrome-');
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      url
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsPort = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout. stderr=${stderr}`)), 15000);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}). stderr=${stderr}`));
    });
  });

  const pages = await (await fetch(`http://127.0.0.1:${wsPort}/json/list`)).json();
  const pageTarget = pages.find((p) => p.type === 'page') || pages[0];
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('No debuggable page target found.');
  }

  return {
    proc,
    wsUrl: pageTarget.webSocketDebuggerUrl,
    cleanup: async () => {
      proc.kill('SIGTERM');
      await sleep(200);
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  };
}

async function auditViewport(client, label, report) {
  const metrics = await client.eval(`(() => {
    const htmlStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const header = document.querySelector('.app-header');
    const nav = document.querySelector('.bottom-nav');
    const headerRect = header ? header.getBoundingClientRect() : null;
    const navRect = nav ? nav.getBoundingClientRect() : null;
    const logo = document.querySelector('.brand-logo');
    const inputs = [...document.querySelectorAll('input, select, textarea')]
      .filter((el) => el.offsetParent !== null && el.type !== 'checkbox' && el.type !== 'file')
      .map((el) => ({ id: el.id || el.placeholder, fontSize: parseFloat(getComputedStyle(el).fontSize) }));
    const smallInputs = inputs.filter((i) => i.fontSize < 16);
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
      scrollY: window.scrollY,
      bodyScrollTop: document.body.scrollTop,
      htmlOverflowY: htmlStyle.overflowY,
      bodyOverflowY: bodyStyle.overflowY,
      htmlOverflowX: htmlStyle.overflowX,
      bodyOverflowX: bodyStyle.overflowX,
      headerTop: headerRect ? Math.round(headerRect.top) : null,
      headerHeight: headerRect ? Math.round(headerRect.height) : null,
      navTop: navRect ? Math.round(navRect.top) : null,
      navBottom: navRect ? Math.round(navRect.bottom) : null,
      logoLoaded: Boolean(logo && logo.complete && logo.naturalWidth > 0),
      smallInputs
    };
  })()`);

  const issues = [];
  if (metrics.docScrollWidth > metrics.innerWidth) {
    issues.push(`Horizontal overflow: scrollWidth=${metrics.docScrollWidth} > innerWidth=${metrics.innerWidth}`);
  }
  if (!metrics.logoLoaded) {
    issues.push('Iron Valor logo did not load.');
  }
  if (metrics.smallInputs.length > 0) {
    issues.push(`Inputs with font-size < 16px (iOS auto-zoom risk): ${JSON.stringify(metrics.smallInputs)}`);
  }
  if (metrics.headerTop !== null && Math.abs(metrics.headerTop) > 2) {
    issues.push(`Sticky header drifted: headerTop=${metrics.headerTop} (scrollY=${metrics.scrollY})`);
  }
  if (metrics.bodyOverflowY === 'auto' || metrics.bodyOverflowY === 'scroll') {
    issues.push(`Body became an inner scroll container (body.overflowY=${metrics.bodyOverflowY}), breaking mobile momentum scroll & sticky header!`);
  }

  report.push({ label, metrics, issues });
  return { metrics, issues };
}

async function runFlow() {
  await fs.mkdir(outDir, { recursive: true });
  const chromePath = await findChrome();
  const { server, url } = await startStaticServer();
  const chrome = await launchChrome(chromePath, url);
  const client = new CDPClient(chrome.wsUrl);
  const report = [];
  const consoleErrors = [];

  try {
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await client.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5
    });

    await client.send('Page.navigate', { url });
    await sleep(900);

    // 1. Initial Play screen
    await auditViewport(client, '01-play-initial', report);
    await client.screenshot(path.join(outDir, '01-play-initial.png'));

    // 2. Switch to Teams tab and add 6 more teams (total 8 teams)
    await client.eval(`document.querySelector('[data-tab="teams"]').click()`);
    await sleep(250);
    const extraTeams = ['6AM Crew', 'Noon Squad', 'Barbell Club', 'Delray Rx', 'Kettlebell Kings', 'Coaches'];
    for (const name of extraTeams) {
      await client.eval(`(() => {
        const input = document.getElementById('new-team-name');
        input.value = ${JSON.stringify(name)};
        document.getElementById('create-team-form').requestSubmit();
      })()`);
      await sleep(80);
    }
    await sleep(250);
    await auditViewport(client, '02-teams-8-top', report);
    await client.screenshot(path.join(outDir, '02-teams-8-top.png'));

    // Real touch scroll down on Teams tab
    const beforeTeamsScroll = await client.eval(`window.scrollY`);
    await client.touchScroll(195, 500, -520);
    await client.touchScroll(195, 500, -520);
    const afterTeamsScroll = await client.eval(`window.scrollY`);
    const teamsScrollCheck = await auditViewport(client, '03-teams-8-scrolled', report);
    if (afterTeamsScroll <= beforeTeamsScroll) {
      teamsScrollCheck.issues.push(`Touch scroll FAILED on Teams tab: before=${beforeTeamsScroll}, after=${afterTeamsScroll}`);
    }
    // Tap +50 on the last team card while scrolled down and make sure scroll doesn't yank back to top!
    await client.eval(`(() => {
      const cards = document.querySelectorAll('[data-team-card]');
      const lastCard = cards[cards.length - 1];
      lastCard.querySelector('[data-delta="50"]').click();
    })()`);
    await sleep(200);
    const afterDeltaScroll = await client.eval(`window.scrollY`);
    if (Math.abs(afterDeltaScroll - afterTeamsScroll) > 80) {
      teamsScrollCheck.issues.push(`Scroll position jumped after tapping +50 on Teams tab: before=${afterTeamsScroll}, after=${afterDeltaScroll}`);
    }
    await client.screenshot(path.join(outDir, '03-teams-8-scrolled.png'));

    // Check Rename bottom sheet modal
    await client.eval(`document.querySelector('[data-rename-team]').click()`);
    await sleep(250);
    await auditViewport(client, '04-teams-rename-sheet', report);
    await client.screenshot(path.join(outDir, '04-teams-rename-sheet.png'));
    await client.eval(`document.getElementById('sheet-cancel').click()`);
    await sleep(200);

    // 3. Switch back to Play tab with 8 teams!
    await client.eval(`document.querySelector('[data-tab="play"]').click()`);
    await sleep(300);
    const playManyAudit = await auditViewport(client, '05-play-8-teams', report);
    await client.screenshot(path.join(outDir, '05-play-8-teams.png'));

    // Verify we can touch-scroll Play tab down and back up smoothly
    await client.touchScroll(195, 500, -300);
    const playScrolledY = await client.eval(`window.scrollY`);
    if (playManyAudit.metrics.docScrollHeight > playManyAudit.metrics.innerHeight && playScrolledY === 0) {
      playManyAudit.issues.push(`Touch scroll FAILED on Play tab (8 teams): scrollHeight=${playManyAudit.metrics.docScrollHeight}, scrollY stayed 0`);
    }
    await client.touchScroll(195, 500, 400);

    // 4. Pull Random Question and verify active stage + scrollability
    await client.eval(`document.getElementById('btn-pull-random').click()`);
    await sleep(350);
    await auditViewport(client, '06-play-active-question', report);
    await client.screenshot(path.join(outDir, '06-play-active-question.png'));

    // Tap choice A to reveal answer, mark Wrong for Team 1 (test Steal state), then touch-scroll down to bottom of card
    await client.eval(`document.querySelector('[data-choice="0"]').click()`);
    await sleep(200);
    await client.eval(`document.getElementById('btn-mark-wrong').click()`);
    await sleep(250);
    await client.touchScroll(195, 500, -520);
    await client.touchScroll(195, 500, -520);
    const revealedAudit = await auditViewport(client, '07-play-revealed-steal-scrolled', report);
    if (revealedAudit.metrics.scrollY === 0 && revealedAudit.metrics.docScrollHeight > revealedAudit.metrics.innerHeight) {
      revealedAudit.issues.push('Touch scroll FAILED on active Question stage: scrollY stayed 0');
    }
    // Check that award buttons sit cleanly above the bottom nav when scrolled to bottom
    const awardBottomCheck = await client.eval(`(() => {
      const btn = document.getElementById('btn-mark-correct');
      const nav = document.querySelector('.bottom-nav');
      if (!btn || !nav) return null;
      return { btnBottom: Math.round(btn.getBoundingClientRect().bottom), navTop: Math.round(nav.getBoundingClientRect().top) };
    })()`);
    if (awardBottomCheck && awardBottomCheck.btnBottom > awardBottomCheck.navTop) {
      revealedAudit.issues.push(`Award button clipped under bottom nav: btnBottom=${awardBottomCheck.btnBottom} > navTop=${awardBottomCheck.navTop}`);
    }
    await client.screenshot(path.join(outDir, '07-play-revealed-steal-scrolled.png'));

    // Award Correct to steal team!
    await client.eval(`document.getElementById('btn-mark-correct').click()`);
    await sleep(250);

    // 5. Switch to Logs tab and test scrolling down & back up
    await client.eval(`document.querySelector('[data-tab="logs"]').click()`);
    await sleep(250);
    await client.touchScroll(195, 500, -450);
    const logsAudit = await auditViewport(client, '08-logs-tab', report);
    if (logsAudit.metrics.docScrollHeight > logsAudit.metrics.innerHeight && logsAudit.metrics.scrollY === 0) {
      logsAudit.issues.push('Touch scroll FAILED on Logs tab: scrollY stayed 0');
    }
    await client.touchScroll(195, 500, 600);
    await client.screenshot(path.join(outDir, '08-logs-tab.png'));

    // 6. Switch to Admin tab, capture top & touch-scroll all the way to bottom
    await client.eval(`document.querySelector('[data-tab="admin"]').click()`);
    await sleep(250);
    await auditViewport(client, '09-admin-top', report);
    await client.screenshot(path.join(outDir, '09-admin-top.png'));

    await client.touchScroll(195, 500, -750);
    await client.touchScroll(195, 500, -750);
    const adminBottomAudit = await auditViewport(client, '10-admin-bottom', report);
    if (adminBottomAudit.metrics.scrollY === 0) {
      adminBottomAudit.issues.push('Touch scroll FAILED on Admin tab: scrollY stayed 0');
    }
    const adminSubmitCheck = await client.eval(`(() => {
      const btn = document.querySelector('#custom-question-form button[type="submit"]');
      const nav = document.querySelector('.bottom-nav');
      if (!btn || !nav) return null;
      return { btnBottom: Math.round(btn.getBoundingClientRect().bottom), navTop: Math.round(nav.getBoundingClientRect().top) };
    })()`);
    if (adminSubmitCheck && adminSubmitCheck.btnBottom > adminSubmitCheck.navTop) {
      adminBottomAudit.issues.push(`Admin Save button clipped under bottom nav: btnBottom=${adminSubmitCheck.btnBottom} > navTop=${adminSubmitCheck.navTop}`);
    }
    await client.screenshot(path.join(outDir, '10-admin-bottom.png'));

    // 7. Also verify smaller iPhone SE viewport (375x667) with 8 teams + active question + scrolling!
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true
    });
    await client.eval(`document.querySelector('[data-tab="play"]').click()`);
    await sleep(250);
    await client.eval(`document.getElementById('btn-pull-random').click()`);
    await sleep(300);
    await client.touchScroll(187, 420, -450);
    const seAudit = await auditViewport(client, '11-iphone-se-play-scrolled', report);
    if (seAudit.metrics.scrollY === 0 && seAudit.metrics.docScrollHeight > seAudit.metrics.innerHeight) {
      seAudit.issues.push('Touch scroll FAILED on iPhone SE (375x667) Play tab');
    }
    await client.screenshot(path.join(outDir, '11-iphone-se-play-scrolled.png'));

    // Collect runtime exceptions
    for (const ev of client.events) {
      if (ev.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(ev.params?.exceptionDetails?.text || 'Uncaught exception');
      }
    }

    const totalIssues = report.reduce((acc, r) => acc + r.issues.length, 0) + consoleErrors.length;
    console.log(JSON.stringify({ outDir, totalIssues, consoleErrors, report }, null, 2));
    if (totalIssues > 0) {
      process.exitCode = 1;
    }
  } finally {
    client.close();
    await chrome.cleanup();
    server.close();
  }
}

runFlow().catch((err) => {
  console.error(err);
  process.exit(1);
});
