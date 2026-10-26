'use strict';

// Real renderer and character assets, browser-local mouse input, and a narrow host stub.
// Native window / text-bubble placement is verified by the Electron smoke checks.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { chromium } = require('playwright');
const { DEFAULT_SETTINGS } = require('../electron/host-policy.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'validation-v1.3.0-interactions');
const report = { passed: false, kind: 'real character renderer with browser-local mouse and mock desktop bridge', checks: [], screenshots: [], errors: [] };
const server = createServer(async (request, response) => {
  try {
    const filename = path.resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
    if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const data = await fs.readFile(filename);
    response.setHeader('Content-Type', { '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' }[path.extname(filename)] || 'application/octet-stream');
    response.end(data);
  } catch { response.writeHead(404).end(); }
});

async function main() {
  await fs.mkdir(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, activePage;
  try {
    browser = await chromium.launch({ channel: process.platform === 'darwin' ? 'chrome' : 'msedge', headless: true });
    async function freshPage({ scale = 1, characterX = 140, characterY = 0, interactionsEnabled = true } = {}) {
      if (activePage) await activePage.close();
      const page = activePage = await browser.newPage({ viewport: { width: 740, height: 800 }, deviceScaleFactor: 1 });
      page.on('pageerror', error => report.errors.push(error.message));
      await page.addInitScript(({ defaults, scale, characterX, characterY, interactionsEnabled }) => {
        // Keep fixed-expression upstream assertions deterministic; unit tests cover all draws.
        Math.random = () => 0;
        const callbacks = {};
        const host = { settings: { ...defaults, scale, interactionsEnabled }, hotkeys: { legacy: { active: false }, typing: { active: false } },
          viewport: { width: 740, height: 800, characterX, characterY, characterWidth: 600 * scale, characterHeight: 800 * scale, clipped: false } };
        const qa = window.__interactionsQA = {
          calls: [], appearances: [], starts: 0, ends: 0, zooms: [], hitRegions: [],
          action: value => callbacks.action(value),
          settings: patch => { Object.assign(host.settings, patch); callbacks.settings(structuredClone(host)); },
          nativePointer: value => callbacks.pointer(value),
          viewport: value => { host.viewport = value; callbacks.viewport?.(structuredClone(value)); },
          dragState: active => callbacks.dragState?.(active),
        };
        window.elysiaDesktop = Object.freeze({
          getState: async () => structuredClone(host),
          onPointer: callback => { callbacks.pointer = callback; },
          onDragState: callback => { callbacks.dragState = callback; },
          onAction: callback => { callbacks.action = callback; },
          onViewport: callback => { callbacks.viewport = callback; },
          onSettings: callback => { callbacks.settings = callback; },
          onTypedKey: callback => { callbacks.typedKey = callback; },
          setSettings: async patch => { Object.assign(host.settings, patch); callbacks.settings(structuredClone(host)); return structuredClone(host); },
          setAppearance: value => { qa.appearances.push(structuredClone(value)); },
          setHitRegion: async value => { qa.hitRegions.push(structuredClone(value)); return true; },
          dragStart: () => { qa.starts++; callbacks.dragState?.(true); },
          dragEnd: () => { qa.ends++; callbacks.dragState?.(false); },
          zoomBy: async value => { qa.zooms.push(structuredClone(value)); return structuredClone(host); },
          interact: async kind => { qa.calls.push({ kind: structuredClone(kind), at: performance.now() }); return { ok: true }; },
          quit() {},
        });
      }, { defaults: DEFAULT_SETTINGS, scale, characterX, characterY, interactionsEnabled });
      await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
      await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
      await page.waitForFunction(() => window.__interactionsQA.hitRegions.some(shape => shape.rects.length > 0));
      return page;
    }
    const snapshot = page => page.evaluate(() => ({ state: window.elysiaPreview.snapshot(), calls: window.__interactionsQA.calls,
      starts: window.__interactionsQA.starts, ends: window.__interactionsQA.ends, zooms: window.__interactionsQA.zooms }));
    const action = (page, value) => page.evaluate(value => window.__interactionsQA.action(value), value);
    const point = (page, x, y) => page.evaluate(async ({ x, y }) => {
      const { characterView } = await import('./viewport.mjs');
      const view = characterView(innerWidth, innerHeight, window.elysiaPreview.viewport());
      return { x: view.x + x * view.scale, y: view.y + y * view.scale };
    }, { x, y });
    const move = async (page, x, y, steps = 1) => { const p = await point(page, x, y); await page.mouse.move(p.x, p.y, { steps }); };
    const click = async (page, x = 295, y = 450) => { const p = await point(page, x, y); await page.mouse.click(p.x, p.y, { delay: 30 }); };
    const kinds = result => result.calls.map(call => typeof call.kind === 'string' ? call.kind : call.kind?.type ?? call.kind?.kind);
    const check = (name, details = {}) => report.checks.push({ name, passed: true, ...details });
    const capture = async (page, name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, omitBackground: true }); report.screenshots.push(file); };
    async function headStroke(page, y = 230) {
      await move(page, 255, y);
      for (const x of [335, 255, 335, 255]) {
        await move(page, x, y, 6);
        await page.waitForTimeout(110);
      }
    }

    let page = await freshPage();
    await move(page, 220, 230); await move(page, 365, 230, 12);
    assert.deepEqual(kinds(await snapshot(page)), [], 'A single pass over the head must not count as stroking');
    await page.waitForTimeout(1400);
    assert.deepEqual(kinds(await snapshot(page)), [], 'A stationary cursor must not trigger head pats');
    await headStroke(page); await headStroke(page);
    assert.deepEqual(kinds(await snapshot(page)), [], 'Repeated bare-cursor strokes must not trigger head pats');
    check('single pass, stationary cursor, and repeated head strokes never trigger');

    page = await freshPage();
    await headStroke(page, 550);
    assert.deepEqual(kinds(await snapshot(page)), [], 'Stroking the torso is outside the head region');
    check('back-and-forth movement outside the head stays inert');

    page = await freshPage();
    await click(page, 295, 110);
    assert.deepEqual(kinds(await snapshot(page)), ['head-pat']);
    assert.equal((await snapshot(page)).state.expression, 'blush');
    check('the crown of the head is pettable as well as the bangs');

    page = await freshPage();
    for (const x of [255, 335, 255, 335, 255]) {
      const position = await point(page, x, 230);
      await page.evaluate(position => window.__interactionsQA.nativePointer({ localX: position.x, localY: position.y,
        width: innerWidth, height: innerHeight, sampledAt: Date.now() }), position);
      await page.waitForTimeout(160);
    }
    assert.deepEqual(kinds(await snapshot(page)), [], 'Global gaze updates must not trigger touching through another app');
    check('native gaze-only pointer samples never trigger interactions');

    page = await freshPage();
    await action(page, { type: 'expression', id: 'heart' });
    await click(page, 295, 230);
    await page.waitForFunction(() => window.__interactionsQA.calls.length > 0);
    let result = await snapshot(page);
    assert.deepEqual(kinds(result), ['head-pat']); assert.equal(result.state.expression, 'blush');
    assert.equal(result.starts, 1, 'Head pat uses a completed click');
    assert.equal(result.ends, 1, 'A completed head click releases the drag gesture');
    await capture(page, 'head-pat');
    check('a gentle head click triggers one blush reaction', { kinds: kinds(result) });
    await move(page, 530, 600);
    await page.waitForFunction(() => window.elysiaPreview.snapshot().expression === 'heart', undefined, { timeout: 4000 });
    check('temporary head-pat face restores the previous face');

    page = await freshPage();
    await click(page); result = await snapshot(page);
    assert.equal(result.state.expression, 'surprise');
    assert.deepEqual(kinds(result), ['poke']);
    await click(page, 295, 230);
    assert.equal((await snapshot(page)).state.expression, 'blush');
    await click(page); await click(page, 295, 230);
    result = await snapshot(page);
    assert.equal(result.state.expression, 'blush');
    assert.deepEqual(kinds(result), ['poke', 'head-pat', 'poke', 'head-pat']);
    check('the first four mixed head and body clicks keep their own reactions');
    await click(page);
    result = await snapshot(page);
    assert.equal(result.state.expression, 'angry'); assert.deepEqual(kinds(result), ['poke', 'head-pat', 'poke', 'head-pat', 'poke-annoyed']);
    assert.equal(result.starts, 5); assert.equal(result.ends, 5);
    await capture(page, 'five-mixed-clicks');
    check('head and body share the three-second counter; the fifth mixed click annoys', { kinds: kinds(result) });
    await click(page, 295, 230); await click(page);
    assert.equal((await snapshot(page)).calls.length, 5, 'The three-second cooldown ignores further clicks');
    check('clicks during the annoyance cooldown cannot replace the angry face');
    await move(page, 530, 600);
    await page.waitForFunction(() => window.elysiaPreview.snapshot().expression === null, undefined, { timeout: 4000 });
    check('the fifth-click reaction restores the original face after its timeout');

    page = await freshPage();
    for (let i = 0; i < 4; i++) await click(page, 295, 230);
    result = await snapshot(page); assert.deepEqual(kinds(result), ['head-pat', 'head-pat', 'head-pat', 'head-pat']);
    assert.equal(result.state.expression, 'blush'); await click(page, 295, 230);
    result = await snapshot(page); assert.equal(kinds(result).at(-1), 'poke-annoyed'); assert.equal(result.state.expression, 'angry');
    check('head-only clicks also become angry on the fifth click');

    page = await freshPage();
    for (let i = 0; i < 5; i++) { if (i) await page.waitForTimeout(850); await click(page); }
    assert.ok(!kinds(await snapshot(page)).includes('poke-annoyed'), 'Five clicks spanning more than three seconds are not rapid enough');
    check('five slow clicks outside the three-second window never annoy');

    page = await freshPage();
    for (let i = 0; i < 3; i++) {
      await move(page, 280, 450); await page.mouse.down(); await move(page, i ? 330 : 287, 450, 4); await page.mouse.up();
    }
    result = await snapshot(page); assert.deepEqual(kinds(result), []);
    assert.equal(result.starts, 3); assert.equal(result.ends, 3);
    check('dragging more than six screen pixels never counts as a poke');

    page = await freshPage();
    await move(page, 255, 230); await page.mouse.down(); await headStroke(page); await page.mouse.up();
    assert.deepEqual(kinds(await snapshot(page)), [], 'Left-button dragging must not be mistaken for bare-cursor stroking');
    await move(page, 295, 450); await page.mouse.down(); await page.waitForTimeout(620); await page.mouse.up();
    assert.deepEqual(kinds(await snapshot(page)), [], 'A long hold is not a gentle click');
    check('left-button head dragging and long presses stay inert');

    page = await freshPage();
    await move(page, 255, 230); await page.mouse.down({ button: 'right' });
    await headStroke(page); await page.mouse.wheel(0, 100); await page.mouse.up({ button: 'right' });
    await page.waitForFunction(() => window.__interactionsQA.zooms.length > 0);
    result = await snapshot(page); assert.deepEqual(kinds(result), []);
    check('right-button strokes and wheel zoom never trigger head pats', { zoomRequests: result.zooms.length });

    page = await freshPage();
    await click(page, 295, 230); await move(page, 530, 600);
    await page.keyboard.down('Space'); await page.keyboard.press('Digit9'); await page.keyboard.up('Space');
    assert.equal((await snapshot(page)).state.expression, 'smile');
    await page.waitForTimeout(3200);
    assert.equal((await snapshot(page)).state.expression, 'smile', 'An old reaction timeout cannot overwrite a later shortcut');
    check('a later keyboard expression survives the old reaction timeout');

    page = await freshPage();
    for (let i = 0; i < 5; i++) await click(page);
    assert.equal((await snapshot(page)).state.expression, 'angry');
    await action(page, { type: 'expression', id: 'heart' });
    await action(page, { type: 'pose', id: 'tea' });
    await move(page, 530, 600); await page.waitForTimeout(3200);
    result = await snapshot(page); assert.equal(result.state.expression, 'heart'); assert.equal(result.state.pose, 'tea');
    check('later settings expression and pose survive the old reaction timeout');

    page = await freshPage({ scale: .65, characterX: 180, characterY: 110 });
    await click(page, 295, 230); result = await snapshot(page);
    assert.deepEqual(kinds(result), ['head-pat']); assert.equal(result.state.expression, 'blush');
    await capture(page, 'head-pat-scaled');
    check('head region follows the scaled and offset character viewport');

    page = await freshPage({ interactionsEnabled: false });
    for (let i = 0; i < 6; i++) await click(page, 295, i % 2 ? 450 : 230);
    result = await snapshot(page); assert.deepEqual(kinds(result), []); assert.equal(result.state.expression, null);
    const disabledStarts = result.starts, disabledEnds = result.ends;
    await move(page, 295, 450); await page.mouse.down(); await move(page, 350, 450, 6); await page.mouse.up();
    result = await snapshot(page); assert.equal(result.starts, disabledStarts + 1); assert.equal(result.ends, disabledEnds + 1);
    await move(page, 295, 450); await page.mouse.down({ button: 'right' }); await page.mouse.wheel(0, 100); await page.mouse.up({ button: 'right' });
    await page.waitForFunction(() => window.__interactionsQA.zooms.length > 0);
    await page.keyboard.down('Space'); await page.keyboard.press('Digit9'); await page.keyboard.up('Space');
    result = await snapshot(page); assert.deepEqual(kinds(result), []); assert.equal(result.state.expression, 'smile');
    check('saved interactions-off blocks clicks while native dragging, right-wheel zoom and shortcuts remain usable');

    page = await freshPage();
    await action(page, { type: 'expression', id: 'heart' }); await action(page, { type: 'pose', id: 'tea' });
    await action(page, { type: 'toggle-skin', id: 'cat' }); await action(page, { type: 'toggle-skin', id: 'glasses' });
    await click(page, 295, 230); assert.equal((await snapshot(page)).state.expression, 'blush');
    await page.evaluate(() => window.__interactionsQA.settings({ interactionsEnabled: false }));
    result = await snapshot(page); assert.equal(result.state.expression, 'heart'); assert.equal(result.state.pose, 'tea');
    assert.equal(result.state.cat, true); assert.equal(result.state.glasses, true);
    await action(page, { type: 'expression', id: 'wink' }); await page.waitForTimeout(2600);
    assert.equal((await snapshot(page)).state.expression, 'wink');
    check('turning interactions off immediately restores the base expression and preserves later appearance choices');

    page = await freshPage();
    for (let i = 0; i < 4; i++) await click(page, 295, 230);
    await page.evaluate(() => window.__interactionsQA.settings({ interactionsEnabled: false }));
    for (let i = 0; i < 6; i++) await click(page);
    assert.equal((await snapshot(page)).calls.length, 4);
    await page.evaluate(() => window.__interactionsQA.settings({ interactionsEnabled: true }));
    await click(page, 295, 230); result = await snapshot(page);
    assert.deepEqual(kinds(result), ['head-pat', 'head-pat', 'head-pat', 'head-pat', 'head-pat']);
    assert.equal(result.state.expression, 'blush');
    check('re-enabling starts the shared click count from zero, ignoring all clicks while disabled');

    page = await freshPage();
    for (let i = 0; i < 5; i++) await click(page);
    assert.equal((await snapshot(page)).state.expression, 'angry');
    await page.evaluate(() => window.__interactionsQA.settings({ interactionsEnabled: false }));
    assert.equal((await snapshot(page)).state.expression, null);
    await page.evaluate(() => window.__interactionsQA.settings({ interactionsEnabled: true }));
    await click(page, 295, 230); result = await snapshot(page);
    assert.equal(kinds(result).at(-1), 'head-pat'); assert.equal(result.state.expression, 'blush');
    check('off then on clears the old anger cooldown as well as its temporary expression');

    page = await freshPage(); await move(page, 295, 230); await page.mouse.down();
    await page.evaluate(() => {
      window.__interactionsQA.settings({ interactionsEnabled: false });
      window.__interactionsQA.settings({ interactionsEnabled: true });
    });
    await page.mouse.up(); assert.deepEqual(kinds(await snapshot(page)), []);
    await click(page); assert.deepEqual(kinds(await snapshot(page)), ['poke']);
    check('a press begun before disabling cannot become a ghost click when released after re-enabling');
    // Exercise source-space regions on all four foreground-hand poses. The
    // resulting voice kind still uses the upstream catalog and debounce path.
    for (const [pose,x,y] of [['idle',770,752],['tea',635,741],['cake',702,750],['megaphone',337,751]]) {
      page = await freshPage(); await action(page,{type:'pose',id:pose});
      await click(page,38+x*.48,68+y*.48);
      result = await snapshot(page);
      assert.equal(result.state.expression,'blush'); assert.deepEqual(kinds(result),['poke']);
      check(`fine hand region follows ${pose} without replacing the voice group`);
    }
    page = await freshPage();
    await click(page,38+540*.48,68+1250*.48);
    assert.equal((await snapshot(page)).state.expression,'surprise');
    const count = (await snapshot(page)).calls.length;
    await click(page,1,1); assert.equal((await snapshot(page)).calls.length,count);
    check('legs use the startled group and transparent source pixels stay inert');
    assert.deepEqual(report.errors, [], 'No renderer exceptions');
    report.passed = true;
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    if (activePage && !activePage.isClosed()) {
      try { await activePage.screenshot({ path: path.join(output, 'failure.png') }); } catch {}
      try { report.lastState = await activePage.evaluate(() => ({ state: window.elysiaPreview?.snapshot(), calls: window.__interactionsQA?.calls })); } catch {}
    }
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
