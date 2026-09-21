import { test, expect, devices } from '@playwright/test';

const runtimeErrors = new WeakMap();
const { defaultBrowserType: mobileBrowserType, ...mobileDevice } = devices['Pixel 7'];

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('#globe')).toHaveAttribute('data-state', /running|paused/);
  await expect(page.locator('#loading-message')).toBeHidden();
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page), 'The browser should have no runtime or console errors').toEqual([]);
});

async function direction(page) {
  return page.locator('#globe').evaluate((canvas) => [
    Number(canvas.dataset.directionX),
    Number(canvas.dataset.directionY),
  ]);
}

async function expectDirection(page, dx, dy) {
  const actual = await direction(page);
  const distance = Math.hypot(dx, dy);
  expect(actual[0]).toBeCloseTo(dx / distance, 2);
  expect(actual[1]).toBeCloseTo(dy / distance, 2);
}

async function canvasImage(page) {
  return page.locator('#globe').evaluate((canvas) => canvas.toDataURL());
}

async function expectSpeed(page, radiansPerSecond) {
  const speed = await page.locator('#globe').evaluate((canvas) => Number(canvas.dataset.speed));
  expect(speed).toBeCloseTo(radiansPerSecond, 6);
}

async function settleFrame(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

test('draws the globe, rotates automatically, and holds still when paused', async ({ page }, testInfo) => {
  const canvas = page.locator('#globe');
  await expect(page.locator('#motion-status')).toHaveText('自動回転中');
  await expect(page.locator('#auto-rotate')).toHaveAttribute('aria-checked', 'true');
  const pixels = await canvas.evaluate((element) => {
    const image = element.getContext('2d').getImageData(0, 0, element.width, element.height);
    let visible = 0;
    for (let index = 3; index < image.data.length; index += 4) {
      if (image.data[index] !== 0) visible += 1;
    }
    return visible;
  });
  expect(pixels).toBeGreaterThan(1000);
  const initial = await canvasImage(page);
  await expect.poll(() => canvasImage(page)).not.toBe(initial);
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });

  await page.locator('#auto-rotate').click();
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#motion-status')).toHaveText('一時停止中');
  await settleFrame(page);
  const paused = await canvasImage(page);
  await page.waitForTimeout(200);
  expect(await canvasImage(page)).toBe(paused);

  await page.locator('#auto-rotate').click();
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect.poll(() => canvasImage(page)).not.toBe(paused);
});

test('rotation changes diamond colours while actual drawn vertices, sizes, and pixel coverage stay fixed', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { GlobeRenderer } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:420px;height:420px;position:fixed;left:-1000px;top:0';
    document.body.append(canvas);
    // Repeated pixel inspection can make Chromium switch GPU/CPU rasterizers
    // mid-test. Select its readback backend up front for exact alpha comparison.
    canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    const width = 180;
    const height = 90;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const colours = [[45, 116, 190], [57, 140, 77], [179, 128, 66]];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels.set([...colours[Math.floor(x / (width / 3))], 255], (y * width + x) * 4);
      }
    }

    // Observe the diamond geometry passed to real Canvas drawing operations,
    // including cached Path2D instances, instead of trusting renderer metadata.
    const pathCommands = new WeakMap();
    const methods = ['moveTo', 'lineTo', 'closePath', 'arc'];
    const originalPathMethods = new Map(methods.map((method) => [method, Path2D.prototype[method]]));
    for (const method of methods) {
      Path2D.prototype[method] = function (...args) {
        if (!pathCommands.has(this)) pathCommands.set(this, []);
        pathCommands.get(this).push([method, ...args]);
        return originalPathMethods.get(method).apply(this, args);
      };
    }
    try {
      const renderer = new GlobeRenderer(canvas, { width, height, pixels });
      const context = canvas.getContext('2d');
      const originalBeginPath = context.beginPath;
      const originalFill = context.fill;
      let currentCommands = [];
      let filledPaths = [];
      context.beginPath = function (...args) {
        currentCommands = [];
        return originalBeginPath.apply(this, args);
      };
      for (const method of methods) {
        const original = context[method];
        context[method] = function (...args) {
          currentCommands.push([method, ...args]);
          return original.apply(this, args);
        };
      }
      context.fill = function (...args) {
        filledPaths.push(args[0] instanceof Path2D ? pathCommands.get(args[0]) || [] : currentCommands);
        return originalFill.apply(this, args);
      };
      const render = (orientation) => {
        filledPaths = [];
        renderer.draw(orientation);
        const diamonds = filledPaths.filter((path) => path.some(([method]) => method === 'moveTo'))
          .sort((a, b) => a[0][1] - b[0][1] || a[0][2] - b[0][2]);
        const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const centerDot = renderer.dots.reduce((closest, dot) => (
          Math.hypot(dot.nx, dot.ny) < Math.hypot(closest.nx, closest.ny) ? dot : closest
        ));
        const ratio = canvas.width / 420;
        const centerIndex = (Math.floor(centerDot.y * ratio) * canvas.width + Math.floor(centerDot.x * ratio)) * 4;
        return {
          diamonds,
          image,
          centerColour: Array.from(image.subarray(centerIndex, centerIndex + 3)),
          dots: JSON.stringify(renderer.dots),
          dotRadius: renderer.dotRadius,
        };
      };
      const initial = render([0, 0, 0, 1]);
      const cachedDots = renderer.dots;
      const tilted = [0.27, -0.33, 0.19, 0.88];
      const length = Math.hypot(...tilted);
      const frames = [
        render([0, Math.SQRT1_2, 0, Math.SQRT1_2]),
        render(tilted.map((component) => component / length)),
      ];
      const comparisons = frames.map((frame) => {
        let alphaChanges = 0;
        let colourChanges = 0;
        for (let i = 0; i < initial.image.length; i += 4) {
          if (initial.image[i + 3] !== frame.image[i + 3]) alphaChanges += 1;
          if (initial.image[i] !== frame.image[i]
            || initial.image[i + 1] !== frame.image[i + 1]
            || initial.image[i + 2] !== frame.image[i + 2]) colourChanges += 1;
        }
        return {
          alphaChanges,
          colourChanges,
          sameDrawnDiamonds: JSON.stringify(initial.diamonds) === JSON.stringify(frame.diamonds),
          sameDotMetadata: initial.dots === frame.dots,
          sameDotRadius: initial.dotRadius === frame.dotRadius,
        };
      });
      const repeated = render([0, 0, 0, 1]);
      return {
        dotCount: renderer.dots.length,
        diamondCount: initial.diamonds.length,
        allClosedEqualSquares: initial.diamonds.every((path) => {
          if (path.length !== 5) return false;
          const x = path[0][1];
          const y = path[1][2];
          const r = renderer.dotRadius;
          const expected = [
            ['moveTo', x, y - r],
            ['lineTo', x + r, y],
            ['lineTo', x, y + r],
            ['lineTo', x - r, y],
            ['closePath'],
          ];
          return path.every((command, index) => command.length === expected[index].length
            && command[0] === expected[index][0]
            && command.slice(1).every((coordinate, axis) => Math.abs(coordinate - expected[index][axis + 1]) < 1e-8));
        }),
        reusedGrid: renderer.dots === cachedDots,
        repeatMatches: initial.image.every((byte, index) => byte === repeated.image[index]),
        initialCenter: initial.centerColour,
        quarterTurnCenter: frames[0].centerColour,
        comparisons,
      };
    } finally {
      for (const [method, original] of originalPathMethods) Path2D.prototype[method] = original;
      canvas.remove();
    }
  });
  expect(result.dotCount).toBeGreaterThan(1000);
  expect(result.diamondCount).toBe(result.dotCount);
  expect(result.allClosedEqualSquares).toBe(true);
  expect(result.reusedGrid).toBe(true);
  expect(result.repeatMatches, JSON.stringify(result)).toBe(true);
  // A positive yaw brings western longitudes to the center; a forward rather
  // than inverse texture lookup would incorrectly select the brown eastern band.
  expect(result.initialCenter[1]).toBeGreaterThan(result.initialCenter[0]);
  expect(result.initialCenter[1]).toBeGreaterThan(result.initialCenter[2]);
  expect(result.quarterTurnCenter[2]).toBeGreaterThan(result.quarterTurnCenter[0]);
  expect(result.quarterTurnCenter[2]).toBeGreaterThan(result.quarterTurnCenter[1]);
  for (const frame of result.comparisons) {
    expect(frame.sameDrawnDiamonds).toBe(true);
    expect(frame.sameDotMetadata).toBe(true);
    expect(frame.sameDotRadius).toBe(true);
    expect(frame.alphaChanges).toBe(0);
    expect(frame.colourChanges).toBeGreaterThan(1000);
  }
});

test('the initial geographic map displays blue oceans, green land, and brown dry regions together', async ({ page }) => {
  const counts = await page.locator('#globe').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = { ocean: 0, vegetation: 0, desert: 0 };
    for (let i = 0; i < pixels.length; i += 4) {
      const [red, green, blue, alpha] = pixels.subarray(i, i + 4);
      if (alpha < 150) continue;
      if (blue > green * 1.15 && blue > red * 1.3) counts.ocean += 1;
      if (green > red * 1.1 && green > blue * 1.1) counts.vegetation += 1;
      if (red > green * 1.1 && green > blue * 1.15) counts.desert += 1;
    }
    return counts;
  });
  expect(counts.ocean).toBeGreaterThan(100);
  expect(counts.vegetation).toBeGreaterThan(100);
  expect(counts.desert).toBeGreaterThan(100);
});

test('dragging follows every direction and preserves the last direction after release', async ({ page }) => {
  const canvas = page.locator('#globe');
  const box = await canvas.boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (const [dx, dy] of [[60, 0], [-60, 0], [0, -60], [0, 60], [45, -45]]) {
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await expect(canvas).toHaveAttribute('data-state', 'dragging');
    await expect(page.locator('#motion-status')).toHaveText('ドラッグ中');
    const before = await canvasImage(page);
    await page.mouse.move(center.x + dx, center.y + dy, { steps: 4 });
    await expectDirection(page, dx, dy);
    await expect.poll(() => canvasImage(page)).not.toBe(before);
    await page.mouse.up();
    await expect(canvas).toHaveAttribute('data-state', 'running');
    await expectDirection(page, dx, dy);
    await expectSpeed(page, 0.13);
  }

  const finalDirection = await direction(page);
  await page.mouse.down();
  await page.mouse.up();
  expect(await direction(page)).toEqual(finalDirection);
});

test('releasing outside the canvas ends the drag and continues the final direction', async ({ page }) => {
  const canvas = page.locator('#globe');
  const box = await canvas.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(5, y, { steps: 5 });
  await expect(canvas).toHaveAttribute('data-state', 'dragging');
  await page.mouse.up();
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expectDirection(page, -1, 0);
});

test('speed and grid controls reset to their initial settings', async ({ page }) => {
  await page.locator('#speed').focus();
  await page.keyboard.press('End');
  await expect(page.locator('#speed')).toHaveValue('2');
  await expect(page.locator('#speed-value')).toHaveText('2.0×');
  await expectSpeed(page, 0.26);
  await page.locator('.grid-label').click();
  await expect(page.locator('#show-grid')).toBeChecked();
  await page.locator('#auto-rotate').click();
  await page.locator('#reset').click();

  await expect(page.locator('#speed')).toHaveValue('1');
  await expect(page.locator('#speed-value')).toHaveText('1.0×');
  await expect(page.locator('#show-grid')).not.toBeChecked();
  await expect(page.locator('#auto-rotate')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#globe')).toHaveAttribute('data-state', 'running');
  await expectSpeed(page, 0.13);
  const resetDirection = await direction(page);
  expect(resetDirection[0]).toBeCloseTo(Math.cos(12 * Math.PI / 180), 3);
  expect(resetDirection[1]).toBeCloseTo(0, 3);
});

test('keyboard arrows rotate the globe and space toggles automatic motion', async ({ page }) => {
  const canvas = page.locator('#globe');
  await canvas.focus();
  await page.keyboard.press('ArrowLeft');
  await expectDirection(page, -1, 0);
  await page.keyboard.press('ArrowUp');
  await expectDirection(page, 0, -1);
  await page.keyboard.press('Space');
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#auto-rotate')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('ArrowRight');
  await expectDirection(page, 1, 0);
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  await page.keyboard.press('Space');
  await expect(canvas).toHaveAttribute('data-state', 'running');
});

test('a failed map request shows an error and recovers using the retry button', async ({ page }) => {
  let attempts = 0;
  await page.route('**/data/surface-map.png', async (route) => {
    attempts += 1;
    if (attempts === 1) await route.fulfill({ status: 503, body: 'Service unavailable' });
    else await route.continue();
  });
  await page.reload();
  await expect(page.locator('#motion-status')).toHaveText('読み込みエラー');
  await expect(page.locator('#loading-message')).toBeVisible();

  // This request deliberately fails; accept only its expected diagnostic logs.
  const errors = runtimeErrors.get(page);
  expect(errors.some((message) => message.startsWith('Unable to initialize the globe:'))).toBe(true);
  expect(errors.every((message) => message.startsWith('Unable to initialize the globe:')
    || /Failed to load resource:.*503/.test(message))).toBe(true);
  errors.length = 0;

  await page.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(page.locator('#globe')).toHaveAttribute('data-state', 'running');
  await expect(page.locator('#loading-message')).toBeHidden();
  expect(attempts).toBe(2);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('starts paused, allows opt-in animation, and honors the preference on reset', async ({ page }) => {
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveAttribute('data-state', 'paused');
    await expect(page.locator('#auto-rotate')).toHaveAttribute('aria-checked', 'false');
    await page.locator('#auto-rotate').click();
    await expect(canvas).toHaveAttribute('data-state', 'running');
    await page.locator('#reset').click();
    await expect(canvas).toHaveAttribute('data-state', 'paused');
  });
});

test.describe('mobile touch', () => {
  test.use(mobileDevice);

  test('fits the viewport and supports touch dragging without scrolling the page', async ({ page }, testInfo) => {
    const canvas = page.locator('#globe');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
    await expect(canvas).toHaveAttribute('data-state', 'dragging');
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 28, y: y - 15, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 56, y: y - 30, id: 0 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(canvas).toHaveAttribute('data-state', 'running');
    await expectDirection(page, 56, -30);
    expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(scrollBefore, 0);
    await session.detach();
    await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
  });
});
