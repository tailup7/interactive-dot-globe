import { test, expect, devices } from '@playwright/test';

const runtimeErrors = new WeakMap();
const cloudRequests = new WeakMap();
const { defaultBrowserType: mobileBrowserType, ...mobileDevice } =
  devices['Pixel 7'];

function cloudSnapshot(cover = 0) {
  return {
    version: 1,
    width: 8,
    height: 4,
    values: Array(32).fill(cover),
    observedAt: '2026-09-21T12:00:00Z',
    fetchedAt: '2026-09-21T12:10:00Z',
    source: {
      name: 'Test cloud analysis',
      url: 'https://example.com/clouds',
      kind: 'forecast',
      attribution: 'Test weather data',
    },
  };
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  const requests = [];
  cloudRequests.set(page, requests);
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // A checked-in weather snapshot may change between builds; keep UI tests
  // deterministic and independent of live weather services.
  await page.route('**/data/clouds.json', (route) =>
    route.fulfill({ json: cloudSnapshot() }),
  );
  await page.goto('/');
  await expect(page.locator('#globe')).toHaveAttribute(
    'data-state',
    /running|paused/,
  );
  await expect(page.locator('#loading-message')).toBeHidden();
  // Most cases exercise the fully visible globe. Reset finishes the one-shot
  // entrance through its public UI without waiting for half a rotation.
  await page.locator('#reset').click();
  await expect(page.locator('#globe')).toHaveAttribute(
    'data-reveal',
    'complete',
  );
});

test.afterEach(async ({ page }) => {
  expect(
    runtimeErrors.get(page),
    'The browser should have no runtime or console errors',
  ).toEqual([]);
});

async function direction(page) {
  return page
    .locator('#globe')
    .evaluate((canvas) => [
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
  const speed = await page
    .locator('#globe')
    .evaluate((canvas) => Number(canvas.dataset.speed));
  expect(speed).toBeCloseTo(radiansPerSecond, 6);
}

async function settleFrame(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
}

test('draws the globe, rotates automatically, and holds still when paused', async ({
  page,
}, testInfo) => {
  const canvas = page.locator('#globe');
  await expect(page.locator('#auto-rotate')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expectSpeed(page, 0.2925);
  for (const selector of [
    '.header-label',
    '.help-link',
    '.hero-copy',
    '#motion-status',
    '#status-led',
    '.stage-index',
    '#coordinates',
    '.drag-hint',
    '.how-it-works',
  ]) {
    await expect(page.locator(selector)).toHaveCount(0);
  }
  const pixels = await canvas.evaluate((element) => {
    const image = element
      .getContext('2d')
      .getImageData(0, 0, element.width, element.height);
    let visible = 0;
    for (let index = 3; index < image.data.length; index += 4) {
      if (image.data[index] !== 0) visible += 1;
    }
    return visible;
  });
  expect(pixels).toBeGreaterThan(1000);
  const initial = await canvasImage(page);
  await expect.poll(() => canvasImage(page)).not.toBe(initial);
  await page.screenshot({
    path: testInfo.outputPath('desktop.png'),
    fullPage: true,
  });

  await page.locator('#auto-rotate').click();
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  await settleFrame(page);
  const paused = await canvasImage(page);
  await page.waitForTimeout(200);
  expect(await canvasImage(page)).toBe(paused);

  await page.locator('#auto-rotate').click();
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect.poll(() => canvasImage(page)).not.toBe(paused);
});

test('rotation changes diamond colours while actual drawn vertices, sizes, and pixel coverage stay fixed', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { GlobeRenderer } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'width:420px;height:420px;position:fixed;left:-1000px;top:0';
    document.body.append(canvas);
    // Repeated pixel inspection can make Chromium switch GPU/CPU rasterizers
    // mid-test. Select its readback backend up front for exact alpha comparison.
    canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    const width = 180;
    const height = 90;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const colours = [
      [45, 116, 190],
      [57, 140, 77],
      [179, 128, 66],
    ];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels.set(
          [...colours[Math.floor(x / (width / 3))], 255],
          (y * width + x) * 4,
        );
      }
    }

    // Observe the diamond geometry passed to real Canvas drawing operations,
    // including cached Path2D instances, instead of trusting renderer metadata.
    const pathCommands = new WeakMap();
    const methods = ['moveTo', 'lineTo', 'closePath', 'arc'];
    const originalPathMethods = new Map(
      methods.map((method) => [method, Path2D.prototype[method]]),
    );
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
        filledPaths.push(
          args[0] instanceof Path2D
            ? pathCommands.get(args[0]) || []
            : currentCommands,
        );
        return originalFill.apply(this, args);
      };
      const render = (orientation) => {
        filledPaths = [];
        renderer.draw(orientation);
        const diamonds = filledPaths
          .filter((path) => path.some(([method]) => method === 'moveTo'))
          .sort((a, b) => a[0][1] - b[0][1] || a[0][2] - b[0][2]);
        const image = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        const centerDot = renderer.dots.reduce((closest, dot) =>
          Math.hypot(dot.nx, dot.ny) < Math.hypot(closest.nx, closest.ny)
            ? dot
            : closest,
        );
        const ratio = canvas.width / 420;
        const centerIndex =
          (Math.floor(centerDot.y * ratio) * canvas.width +
            Math.floor(centerDot.x * ratio)) *
          4;
        return {
          diamonds,
          image,
          centerColour: Array.from(
            image.subarray(centerIndex, centerIndex + 3),
          ),
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
          if (
            initial.image[i] !== frame.image[i] ||
            initial.image[i + 1] !== frame.image[i + 1] ||
            initial.image[i + 2] !== frame.image[i + 2]
          )
            colourChanges += 1;
        }
        return {
          alphaChanges,
          colourChanges,
          sameDrawnDiamonds:
            JSON.stringify(initial.diamonds) === JSON.stringify(frame.diamonds),
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
          return path.every(
            (command, index) =>
              command.length === expected[index].length &&
              command[0] === expected[index][0] &&
              command
                .slice(1)
                .every(
                  (coordinate, axis) =>
                    Math.abs(coordinate - expected[index][axis + 1]) < 1e-8,
                ),
          );
        }),
        reusedGrid: renderer.dots === cachedDots,
        repeatMatches: initial.image.every(
          (byte, index) => byte === repeated.image[index],
        ),
        initialCenter: initial.centerColour,
        quarterTurnCenter: frames[0].centerColour,
        comparisons,
      };
    } finally {
      for (const [method, original] of originalPathMethods)
        Path2D.prototype[method] = original;
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
  expect(result.quarterTurnCenter[2]).toBeGreaterThan(
    result.quarterTurnCenter[0],
  );
  expect(result.quarterTurnCenter[2]).toBeGreaterThan(
    result.quarterTurnCenter[1],
  );
  for (const frame of result.comparisons) {
    expect(frame.sameDrawnDiamonds).toBe(true);
    expect(frame.sameDotMetadata).toBe(true);
    expect(frame.sameDotRadius).toBe(true);
    expect(frame.alphaChanges).toBe(0);
    expect(frame.colourChanges).toBeGreaterThan(1000);
  }
});

test('the initial geographic map displays blue oceans, green land, and brown dry regions together', async ({
  page,
}) => {
  const counts = await page.locator('#globe').evaluate((canvas) => {
    const pixels = canvas
      .getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height).data;
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

test('clouds add a translucent blue-white tint while preserving terrain colours and fixed diamond geometry', async ({
  page,
}) => {
  const result = await page.evaluate(async (snapshot) => {
    const { GlobeRenderer } = await import('/src/renderer.js');
    const { parseCloudSnapshot } = await import('/src/clouds.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'width:420px;height:420px;position:fixed;left:-1000px;top:0';
    document.body.append(canvas);
    const context = canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });
    const surface = {
      width: 2,
      height: 2,
      pixels: new Uint8ClampedArray(Array(4).fill([25, 80, 140, 255]).flat()),
    };
    const renderer = new GlobeRenderer(
      canvas,
      surface,
      parseCloudSnapshot(snapshot),
    );
    const dots = renderer.dots;
    const paths = renderer.dotPaths.slice();
    const dotRadius = renderer.dotRadius;
    const capture = (orientation = [0, 0, 0, 1]) => {
      renderer.draw(orientation);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    try {
      const cloudy = capture();
      renderer.showClouds = false;
      const clear = capture();
      renderer.showClouds = true;
      const repeated = capture();
      const rotated = capture([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
      let alphaChanges = 0;
      let brightenedPixels = 0;
      for (let index = 0; index < cloudy.length; index += 4) {
        if (
          cloudy[index + 3] !== clear[index + 3] ||
          cloudy[index + 3] !== rotated[index + 3]
        )
          alphaChanges += 1;
        if (cloudy[index + 3] < 250 || cloudy[index] <= clear[index] + 25)
          continue;
        brightenedPixels += 1;
      }
      const center =
        (Math.floor(canvas.height / 2) * canvas.width +
          Math.floor(canvas.width / 2)) *
        4;
      const terrainColours = [
        [25, 80, 140],
        [57, 140, 77],
        [179, 128, 66],
      ];
      const terrainSamples = terrainColours.map((colour) => {
        surface.pixels.set(
          Array(4)
            .fill([...colour, 255])
            .flat(),
        );
        renderer.showClouds = false;
        const clear = Array.from(capture().subarray(center, center + 3));
        renderer.showClouds = true;
        const cloudy = Array.from(capture().subarray(center, center + 3));
        return { clear, cloudy };
      });
      surface.pixels.set(
        Array(4)
          .fill([...terrainColours[0], 255])
          .flat(),
      );
      // Put clouds only west of Greenwich. A positive yaw must bring this
      // geographic band to the center with the same inverse lookup as terrain.
      renderer.clouds = parseCloudSnapshot({
        ...snapshot,
        values: snapshot.values.map((_, index) =>
          [1, 2].includes(index % snapshot.width) ? 1 : 0,
        ),
      });
      const localized = capture();
      const localizedTurn = capture([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
      return {
        alphaChanges,
        brightenedPixels,
        terrainSamples,
        unchangedGeometry:
          renderer.dots === dots &&
          renderer.dotRadius === dotRadius &&
          paths.every((path, index) => renderer.dotPaths[index] === path),
        toggleRestoresImage: cloudy.every(
          (byte, index) => byte === repeated[index],
        ),
        cloudBandArrivesAtCenter: localizedTurn[center] - localized[center],
      };
    } finally {
      canvas.remove();
    }
  }, cloudSnapshot(1));
  expect(result.alphaChanges).toBe(0);
  expect(result.brightenedPixels).toBeGreaterThan(1000);
  expect(result.unchangedGeometry).toBe(true);
  expect(result.toggleRestoresImage).toBe(true);
  expect(result.cloudBandArrivesAtCenter).toBeGreaterThan(40);
  const [ocean, vegetation, desert] = result.terrainSamples;
  // Even full cloud cover preserves the blue ocean, green land, and brown
  // desert. The 60% cloud layer still leaves roughly 40% of terrain contrast.
  expect(ocean.cloudy[2]).toBeGreaterThan(ocean.cloudy[1] + 25);
  expect(vegetation.cloudy[1]).toBeGreaterThan(vegetation.cloudy[0] + 18);
  expect(vegetation.cloudy[1]).toBeGreaterThan(vegetation.cloudy[2] + 5);
  expect(desert.cloudy[0]).toBeGreaterThan(desert.cloudy[1] + 5);
  expect(desert.cloudy[1]).toBeGreaterThan(desert.cloudy[2] + 7);
  const terrainRetention =
    (desert.cloudy[0] - ocean.cloudy[0]) / (desert.clear[0] - ocean.clear[0]);
  expect(terrainRetention).toBeGreaterThan(0.3);
  expect(terrainRetention).toBeLessThan(0.5);
  // Infer the shared tint from two differently coloured terrain samples, so
  // an opaque white layer or a merely dimmed white layer cannot pass.
  const tint = ocean.cloudy.map(
    (channel, index) =>
      (channel - ocean.clear[index] * terrainRetention) /
      (1 - terrainRetention),
  );
  expect(tint[0]).toBeGreaterThan(180);
  expect(tint[1]).toBeGreaterThan(tint[0] + 10);
  expect(tint[2]).toBeGreaterThan(tint[0] + 25);
  expect(tint[2]).toBeGreaterThan(230);
});

test('cloud snapshot is loaded once and toggling, dragging, and reset reuse that snapshot', async ({
  page,
}) => {
  let snapshots = 0;
  await page.route('**/data/clouds.json', (route) => {
    snapshots += 1;
    return route.fulfill({ json: cloudSnapshot(1) });
  });
  await page.reload();
  await expect(page.locator('#globe')).toHaveAttribute('data-state', 'running');
  await expect(page.locator('#show-clouds')).toBeChecked();
  await expect(page.locator('#show-clouds')).toBeEnabled();
  await expect(page.locator('#cloud-status')).toContainText('2026');
  await expect(page.locator('#cloud-status')).toHaveAttribute(
    'data-observed-at',
    '2026-09-21T12:00:00.000Z',
  );
  await expect(
    page.getByRole('link', { name: 'Test cloud analysis' }),
  ).toHaveAttribute('href', 'https://example.com/clouds');
  await page.locator('#reset').click();
  await page.locator('#auto-rotate').click();
  await settleFrame(page);
  const cloudy = await canvasImage(page);
  await page.locator('#show-clouds').uncheck();
  await settleFrame(page);
  expect(await canvasImage(page)).not.toBe(cloudy);
  await page.locator('#show-clouds').check();
  await settleFrame(page);
  expect(await canvasImage(page)).toBe(cloudy);
  await page.locator('#show-clouds').uncheck();
  const canvas = page.locator('#globe');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 55,
    box.y + box.height / 2 - 30,
    { steps: 3 },
  );
  await page.mouse.up();
  await expectDirection(page, 55, -30);
  await page.locator('#reset').click();
  await expect(page.locator('#show-clouds')).toBeChecked();
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await settleFrame(page);
  expect(snapshots).toBe(1);
  // Existing web fonts are external assets; weather data must stay local.
  const assetHosts = ['127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com'];
  const externalRequests = cloudRequests
    .get(page)
    .filter(
      (url) =>
        /^https?:/.test(url) && !assetHosts.includes(new URL(url).hostname),
    );
  expect(
    externalRequests,
    'Weather services must only be contacted during snapshot generation',
  ).toEqual([]);
});

test('the reveal fades existing diamonds along the spin direction without moving them into the gaps', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { GlobeRenderer } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'width:420px;height:420px;position:fixed;left:-1000px;top:0';
    document.body.append(canvas);
    const context = canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });
    const surface = {
      width: 2,
      height: 2,
      pixels: new Uint8ClampedArray(Array(4).fill([25, 80, 140, 255]).flat()),
    };
    const renderer = new GlobeRenderer(canvas, surface);
    const initialDots = JSON.stringify(renderer.dots);
    const originalPaths = new Set(renderer.dotPaths);
    const originalFill = context.fill;
    let reusedPaths = true;
    context.fill = function (...args) {
      if (args[0] instanceof Path2D && !originalPaths.has(args[0]))
        reusedPaths = false;
      return originalFill.apply(this, args);
    };
    const capture = (progress, direction = [1, 0]) => {
      renderer.draw([0, 0, 0, 1], { progress, direction });
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const alpha = renderer.dots.map((dot) => {
        const x = Math.floor((dot.x * canvas.width) / 420);
        const y = Math.floor((dot.y * canvas.height) / 420);
        return pixels[(y * canvas.width + x) * 4 + 3];
      });
      const mass = alpha.reduce((sum, value) => sum + value, 0);
      const meanX =
        alpha.reduce(
          (sum, value, index) => sum + renderer.dots[index].nx * value,
          0,
        ) / mass;
      return { pixels, alpha, mass, meanX };
    };
    try {
      const early = capture(0.3);
      const later = capture(0.7);
      const finished = capture(1);
      const reversed = capture(0.3, [-1, 0]);
      let escapedPixels = 0;
      for (let index = 3; index < finished.pixels.length; index += 4) {
        if (
          early.pixels[index] > finished.pixels[index] + 1 ||
          later.pixels[index] > finished.pixels[index] + 1
        )
          escapedPixels += 1;
      }
      return {
        earlyFraction: early.mass / finished.mass,
        laterFraction: later.mass / finished.mass,
        earlyMean: early.meanX,
        laterMean: later.meanX,
        reverseMean: reversed.meanX,
        fadingDiamonds: early.alpha.filter((alpha) => alpha > 40 && alpha < 220)
          .length,
        monotonic: early.alpha.every(
          (alpha, index) => alpha <= later.alpha[index] + 1,
        ),
        escapedPixels,
        reusedPaths,
        sameDots: JSON.stringify(renderer.dots) === initialDots,
      };
    } finally {
      canvas.remove();
    }
  });
  expect(result.earlyFraction).toBeGreaterThan(0.1);
  expect(result.earlyFraction).toBeLessThan(0.5);
  expect(result.laterFraction).toBeGreaterThan(0.5);
  expect(result.laterFraction).toBeLessThan(0.95);
  expect(result.earlyMean).toBeLessThan(-0.25);
  expect(result.laterMean).toBeGreaterThan(result.earlyMean + 0.15);
  expect(result.reverseMean).toBeGreaterThan(0.25);
  expect(result.fadingDiamonds).toBeGreaterThan(20);
  expect(result.monotonic).toBe(true);
  expect(result.escapedPixels).toBe(0);
  expect(result.reusedPaths).toBe(true);
  expect(result.sameDots).toBe(true);
});

test('the first-load reveal follows rotation speed, pauses with rotation, and does not replay after reset', async ({
  page,
}) => {
  const now = new Date('2026-09-21T12:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.reload();
  const canvas = page.locator('#globe');
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect(canvas).toHaveAttribute('data-reveal', 'running');
  const progress = () =>
    canvas.evaluate((element) => Number(element.dataset.revealProgress));
  const coverage = () =>
    canvas.evaluate((element) => {
      const pixels = element
        .getContext('2d')
        .getImageData(0, 0, element.width, element.height).data;
      let dots = 0;
      for (let index = 3; index < pixels.length; index += 4)
        if (pixels[index] > 200) dots += 1;
      return dots;
    });
  expect(await progress()).toBe(0);
  await page.clock.runFor(3000);
  const early = await coverage();
  const earlyProgress = await progress();
  await page.clock.runFor(2000);
  const later = await coverage();
  const laterProgress = await progress();
  const normalAdvance = laterProgress - earlyProgress;
  // A full entrance needs half a revolution plus its narrow angular fade.
  // Compare with angular speed, so a separate fixed-duration timer cannot pass.
  expect(normalAdvance).toBeCloseTo((0.2925 * 2) / (Math.PI + 0.08), 2);
  expect(laterProgress).toBeLessThan(0.55);
  expect(early).toBeGreaterThan(10);
  expect(later).toBeGreaterThan(early * 1.5);
  await expect(canvas).toHaveAttribute('data-reveal', 'running');
  await page.locator('#auto-rotate').dispatchEvent('click');
  await page.clock.runFor(32);
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  const paused = await canvasImage(page);
  await page.clock.runFor(1000);
  expect(await progress()).toBe(laterProgress);
  await expect(canvas).toHaveAttribute('data-reveal', 'running');
  expect(await canvasImage(page)).toBe(paused);

  // Changing speed and display controls preserves the current reveal mask.
  await page.locator('#speed').evaluate((input) => {
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#show-grid').dispatchEvent('click');
  await page.locator('#show-clouds').dispatchEvent('click');
  await page.clock.runFor(32);
  expect(await progress()).toBe(laterProgress);
  await expect(canvas).toHaveAttribute('data-reveal', 'running');
  await expect(page.locator('#show-grid')).toBeChecked();
  await expect(page.locator('#show-clouds')).not.toBeChecked();
  await page.locator('#show-grid').dispatchEvent('click');
  await page.clock.runFor(32);
  await page.locator('#auto-rotate').dispatchEvent('click');
  await page.clock.runFor(2000);
  const fastAdvance = (await progress()) - laterProgress;
  expect(fastAdvance / normalAdvance).toBeCloseTo(2, 1);
  expect(await coverage()).toBeGreaterThan(later * 1.5);

  // Direct manipulation finishes the entrance so every dot responds at once.
  await canvas.dispatchEvent('keydown', {
    key: 'ArrowLeft',
    code: 'ArrowLeft',
  });
  await page.clock.runFor(32);
  await expect(canvas).toHaveAttribute('data-reveal', 'complete');
  await page.locator('#show-grid').evaluate((input) => {
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.clock.runFor(32);
  const complete = await coverage();
  await page.locator('#reset').dispatchEvent('click');
  await page.clock.runFor(32);
  await expect(canvas).toHaveAttribute('data-state', 'running');
  await expect(canvas).toHaveAttribute('data-reveal', 'complete');
  expect(await coverage()).toBe(complete);
});

for (const unavailable of [
  { name: 'missing', status: 404, body: 'Not found' },
  { name: 'invalid JSON', status: 200, body: '{broken json' },
  {
    name: 'invalid schema',
    status: 200,
    body: JSON.stringify({ ...cloudSnapshot(), values: [2] }),
  },
]) {
  test(`a ${unavailable.name} cloud snapshot leaves the globe usable with an unavailable label`, async ({
    page,
  }) => {
    let attempts = 0;
    await page.route('**/data/clouds.json', (route) => {
      attempts += 1;
      return route.fulfill({
        status: unavailable.status,
        contentType: 'application/json',
        body: unavailable.body,
      });
    });
    await page.reload();
    await expect(page.locator('#globe')).toHaveAttribute(
      'data-state',
      'running',
    );
    await expect(page.locator('#loading-message')).toBeHidden();
    await expect(page.locator('#cloud-status')).toContainText(
      '雲データを利用できません',
    );
    await expect(page.locator('#show-clouds')).toBeDisabled();
    const initial = await canvasImage(page);
    await expect.poll(() => canvasImage(page)).not.toBe(initial);
    await page.locator('#reset').click();
    await expect(page.locator('#globe')).toHaveAttribute(
      'data-state',
      'running',
    );
    await expect(page.locator('#show-clouds')).toBeDisabled();
    await settleFrame(page);
    expect(attempts).toBe(1);
    // Chromium logs an HTTP error for the deliberately absent fixture.
    const errors = runtimeErrors.get(page);
    expect(
      errors.every(
        (message) =>
          unavailable.status === 404 &&
          /Failed to load resource:.*404/.test(message),
      ),
    ).toBe(true);
    errors.length = 0;
  });
}

test('dragging follows every direction and preserves the last direction after release', async ({
  page,
}) => {
  const canvas = page.locator('#globe');
  const box = await canvas.boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (const [dx, dy] of [
    [60, 0],
    [-60, 0],
    [0, -60],
    [0, 60],
    [45, -45],
  ]) {
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await expect(canvas).toHaveAttribute('data-state', 'dragging');
    const before = await canvasImage(page);
    await page.mouse.move(center.x + dx, center.y + dy, { steps: 4 });
    await expectDirection(page, dx, dy);
    await expect.poll(() => canvasImage(page)).not.toBe(before);
    await page.mouse.up();
    await expect(canvas).toHaveAttribute('data-state', 'running');
    await expectDirection(page, dx, dy);
    await expectSpeed(page, 0.2925);
  }

  const finalDirection = await direction(page);
  await page.mouse.down();
  await page.mouse.up();
  expect(await direction(page)).toEqual(finalDirection);
});

test('releasing outside the canvas ends the drag and continues the final direction', async ({
  page,
}) => {
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

test('speed and grid controls reset to their initial settings', async ({
  page,
}) => {
  await page.locator('#speed').focus();
  await page.keyboard.press('End');
  await expect(page.locator('#speed')).toHaveValue('2');
  await expect(page.locator('#speed-value')).toHaveText('2.0×');
  await expectSpeed(page, 0.585);
  await page.locator('#show-grid').check();
  await expect(page.locator('#show-grid')).toBeChecked();
  await page.locator('#auto-rotate').click();
  await page.locator('#reset').click();

  await expect(page.locator('#speed')).toHaveValue('1');
  await expect(page.locator('#speed-value')).toHaveText('1.0×');
  await expect(page.locator('#show-grid')).not.toBeChecked();
  await expect(page.locator('#auto-rotate')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('#globe')).toHaveAttribute('data-state', 'running');
  await expectSpeed(page, 0.2925);
  const resetDirection = await direction(page);
  expect(resetDirection[0]).toBeCloseTo(Math.cos((12 * Math.PI) / 180), 3);
  expect(resetDirection[1]).toBeCloseTo(0, 3);
});

test('keyboard arrows rotate the globe and space toggles automatic motion', async ({
  page,
}) => {
  const canvas = page.locator('#globe');
  await canvas.focus();
  await page.keyboard.press('ArrowLeft');
  await expectDirection(page, -1, 0);
  await page.keyboard.press('ArrowUp');
  await expectDirection(page, 0, -1);
  await page.keyboard.press('Space');
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  await expect(page.locator('#auto-rotate')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.keyboard.press('ArrowRight');
  await expectDirection(page, 1, 0);
  await expect(canvas).toHaveAttribute('data-state', 'paused');
  await page.keyboard.press('Space');
  await expect(canvas).toHaveAttribute('data-state', 'running');
});

test('a failed map request shows an error and recovers using the retry button', async ({
  page,
}) => {
  let attempts = 0;
  const snapshotCount = () =>
    cloudRequests
      .get(page)
      .filter((url) => new URL(url).pathname.endsWith('/data/clouds.json'))
      .length;
  const initialSnapshots = snapshotCount();
  await page.route('**/data/surface-map.png', async (route) => {
    attempts += 1;
    if (attempts === 1)
      await route.fulfill({ status: 503, body: 'Service unavailable' });
    else await route.continue();
  });
  await page.reload();
  await expect(page.locator('#globe')).toHaveAttribute('data-state', 'loading');
  await expect(page.locator('#loading-message')).toBeVisible();

  // This request deliberately fails; accept only its expected diagnostic logs.
  const errors = runtimeErrors.get(page);
  expect(
    errors.some((message) =>
      message.startsWith('Unable to initialize the globe:'),
    ),
  ).toBe(true);
  expect(
    errors.every(
      (message) =>
        message.startsWith('Unable to initialize the globe:') ||
        /Failed to load resource:.*503/.test(message),
    ),
  ).toBe(true);
  errors.length = 0;

  await page.getByRole('button', { name: 'もう一度試す' }).click();
  await expect(page.locator('#globe')).toHaveAttribute('data-state', 'running');
  await expect(page.locator('#loading-message')).toBeHidden();
  expect(attempts).toBe(2);
  expect(
    snapshotCount() - initialSnapshots,
    'Retrying terrain must reuse this page’s cloud snapshot',
  ).toBe(1);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('starts paused, allows opt-in animation, and honors the preference on reset', async ({
    page,
  }) => {
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveAttribute('data-state', 'paused');
    await expect(canvas).toHaveAttribute('data-reveal', 'complete');
    await expect(page.locator('#auto-rotate')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await page.locator('#auto-rotate').click();
    await expect(canvas).toHaveAttribute('data-state', 'running');
    await page.locator('#reset').click();
    await expect(canvas).toHaveAttribute('data-state', 'paused');
    await expect(canvas).toHaveAttribute('data-reveal', 'complete');
  });
});

test.describe('mobile touch', () => {
  test.use(mobileDevice);

  test('fits the viewport and supports touch dragging without scrolling the page', async ({
    page,
  }, testInfo) => {
    const canvas = page.locator('#globe');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 0 }],
    });
    await expect(canvas).toHaveAttribute('data-state', 'dragging');
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 28, y: y - 15, id: 0 }],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 56, y: y - 30, id: 0 }],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect(canvas).toHaveAttribute('data-state', 'running');
    await expectDirection(page, 56, -30);
    expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(
      scrollBefore,
      0,
    );
    await session.detach();
    await page.screenshot({
      path: testInfo.outputPath('mobile.png'),
      fullPage: true,
    });
  });
});
