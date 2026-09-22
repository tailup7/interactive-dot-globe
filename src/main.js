import "./style.css";
import { DEFAULT_SPEED, GlobeMotion } from "./motion.js";
import { GlobeRenderer } from "./renderer.js";
import { parseCloudSnapshot } from "./clouds.js";
import { GlobeReveal } from "./reveal.js";

const canvas = document.querySelector("#globe");
const stage = document.querySelector("#globe-stage");
const autoRotate = document.querySelector("#auto-rotate");
const speed = document.querySelector("#speed");
const speedValue = document.querySelector("#speed-value");
const grid = document.querySelector("#show-grid");
const cloudToggle = document.querySelector("#show-clouds");
const cloudStatus = document.querySelector("#cloud-status");
const cloudSource = document.querySelector("#cloud-source-link");
const loading = document.querySelector("#loading-message");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const motion = new GlobeMotion({ autoRotate: !reducedMotion.matches });
const reveal = new GlobeReveal({
  direction: [motion.driftAxis[1], motion.driftAxis[0]],
  reducedMotion: reducedMotion.matches,
});
let renderer = null;
let activePointer = null;
let previousPointer = null;
let frameId = 0;
let previousFrame = 0;
let requestInFlight = false;
let cloudSnapshotPromise;

function updateRevealState() {
  canvas.dataset.reveal = reveal.active ? "running" : "complete";
  canvas.dataset.revealProgress = String(reveal.progress);
}

function finishReveal() {
  reveal.finish();
  updateRevealState();
  invalidate();
}

function updateStatus() {
  const state = motion.dragging
    ? "dragging"
    : motion.autoRotate
      ? "running"
      : "paused";
  autoRotate.setAttribute("aria-checked", String(motion.autoRotate));
  document.querySelector("#rotation-description").textContent =
    motion.autoRotate ? "最後に動かした方向へ" : "ドラッグで操作できます";
  canvas.dataset.state = renderer ? state : "loading";
  canvas.dataset.directionX = String(motion.driftAxis[1]);
  canvas.dataset.directionY = String(motion.driftAxis[0]);
  canvas.dataset.speed = String(motion.speed);
}

function invalidate() {
  if (!frameId && renderer && !document.hidden)
    frameId = requestAnimationFrame(frame);
}

function frame(timestamp) {
  frameId = 0;
  if (!renderer || document.hidden) {
    previousFrame = 0;
    return;
  }
  if (previousFrame) {
    const seconds = (timestamp - previousFrame) / 1000;
    if (motion.step(seconds)) reveal.advance(motion.lastStepAngle);
  }
  previousFrame = timestamp;
  renderer.draw(motion.orientation, reveal);
  updateRevealState();
  if (motion.autoRotate && !motion.dragging) invalidate();
  else previousFrame = 0;
}

function movePointer(event) {
  if (event.pointerId !== activePointer || !renderer) return;
  const coalesced = event.getCoalescedEvents?.() || [];
  const samples = coalesced.length ? coalesced : [event];
  for (const sample of samples) {
    const dx = sample.clientX - previousPointer.x;
    const dy = sample.clientY - previousPointer.y;
    motion.dragBy(dx, dy, renderer.radius);
    previousPointer = { x: sample.clientX, y: sample.clientY };
  }
  updateStatus();
  invalidate();
}

function endDrag(event) {
  if (
    activePointer === null ||
    (event?.pointerId !== undefined && event.pointerId !== activePointer)
  )
    return;
  const pointer = activePointer;
  activePointer = null;
  previousPointer = null;
  motion.endDrag();
  canvas.classList.remove("is-dragging");
  if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
  previousFrame = 0;
  updateStatus();
  invalidate();
}

canvas.addEventListener("pointerdown", (event) => {
  if (
    !renderer ||
    activePointer !== null ||
    !event.isPrimary ||
    event.button !== 0
  )
    return;
  event.preventDefault();
  finishReveal();
  canvas.classList.add("is-pointer-focus");
  canvas.focus({ preventScroll: true });
  activePointer = event.pointerId;
  previousPointer = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  motion.beginDrag();
  previousFrame = 0;
  canvas.classList.add("is-dragging");
  updateStatus();
  invalidate();
});
canvas.addEventListener("pointermove", movePointer);
canvas.addEventListener("pointerup", (event) => {
  movePointer(event);
  endDrag(event);
});
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("lostpointercapture", endDrag);
canvas.addEventListener("blur", () =>
  canvas.classList.remove("is-pointer-focus"),
);
window.addEventListener("blur", () => endDrag());

function toggleRotation() {
  motion.setAutoRotate(!motion.autoRotate);
  previousFrame = 0;
  updateStatus();
  invalidate();
}

autoRotate.addEventListener("click", toggleRotation);
canvas.addEventListener("keydown", (event) => {
  canvas.classList.remove("is-pointer-focus");
  if (!renderer || activePointer !== null) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat) toggleRotation();
    return;
  }
  const directions = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  finishReveal();
  const distance = renderer.radius * (event.shiftKey ? 0.18 : 0.075);
  motion.beginDrag();
  motion.dragBy(
    direction[0] * distance,
    direction[1] * distance,
    renderer.radius,
  );
  motion.endDrag();
  updateStatus();
  invalidate();
});

function updateSpeed() {
  const multiplier = Number(speed.value);
  motion.setSpeed(DEFAULT_SPEED * multiplier);
  const formatted = Number.isInteger(multiplier * 10)
    ? multiplier.toFixed(1)
    : multiplier.toFixed(2);
  speedValue.value = `${formatted}×`;
  speed.setAttribute("aria-valuetext", `${formatted}倍`);
  speed.style.setProperty(
    "--range-progress",
    `${((multiplier - 0.25) / 1.75) * 100}%`,
  );
  updateStatus();
  invalidate();
}
speed.addEventListener("input", updateSpeed);

grid.addEventListener("change", () => {
  if (renderer) renderer.showGrid = grid.checked;
  invalidate();
});
cloudToggle.addEventListener("change", () => {
  if (renderer) renderer.showClouds = cloudToggle.checked;
  invalidate();
});

document.querySelector("#reset").addEventListener("click", () => {
  finishReveal();
  endDrag();
  motion.reset();
  motion.setAutoRotate(!reducedMotion.matches);
  speed.value = "1";
  updateSpeed();
  grid.checked = false;
  if (renderer) renderer.showGrid = false;
  cloudToggle.checked = Boolean(renderer?.clouds);
  if (renderer) renderer.showClouds = cloudToggle.checked;
  previousFrame = 0;
  updateStatus();
  invalidate();
});

const resizeObserver = new ResizeObserver(() => invalidate());
resizeObserver.observe(stage);
window.addEventListener("resize", invalidate);
document.addEventListener("visibilitychange", () => {
  previousFrame = 0;
  if (document.hidden) {
    endDrag();
    cancelAnimationFrame(frameId);
    frameId = 0;
  } else invalidate();
});
reducedMotion.addEventListener("change", (event) => {
  if (event.matches) {
    finishReveal();
    motion.setAutoRotate(false);
    updateStatus();
    invalidate();
  }
});

/** Load the local build snapshot once, also across terrain-load retries. */
function getCloudSnapshot() {
  cloudSnapshotPromise ??= (async () => {
    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}data/clouds.json`,
        {
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error(`Cloud data: HTTP ${response.status}`);
      const clouds = parseCloudSnapshot(await response.json());
      const date = new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZoneName: "short",
      }).format(new Date(clouds.observedAt));
      const kind = {
        forecast: "モデル推定",
        analysis: "解析値",
        satellite: "衛星観測",
      }[clouds.source.kind];
      const missing =
        clouds.coverage < 1
          ? ` · データなし ${((1 - clouds.coverage) * 100).toFixed(1)}%`
          : "";
      cloudStatus.textContent = `雲の対象日時：${date} · ${kind}${missing}`;
      cloudStatus.dataset.observedAt = clouds.observedAt;
      cloudSource.textContent = clouds.source.name;
      cloudSource.href = clouds.source.url;
      cloudSource.title = clouds.source.attribution;
      cloudSource.hidden = false;
      cloudToggle.disabled = false;
      return clouds;
    } catch {
      cloudStatus.textContent =
        "雲データを利用できません。地表のみ表示しています。";
      cloudSource.hidden = true;
      cloudToggle.checked = false;
      cloudToggle.disabled = true;
      return null;
    }
  })();
  return cloudSnapshotPromise;
}

async function initialize() {
  if (requestInFlight) return;
  requestInFlight = true;
  loading.hidden = false;
  loading.classList.remove("is-error");
  loading.textContent = "世界を描いています…";
  const cloudsPromise = getCloudSnapshot();
  try {
    const response = await fetch(
      `${import.meta.env.BASE_URL}data/surface-map.png`,
    );
    if (!response.ok) throw new Error(`Map data: HTTP ${response.status}`);
    const image = await createImageBitmap(await response.blob());
    let surface;
    try {
      const mapCanvas = document.createElement("canvas");
      mapCanvas.width = image.width;
      mapCanvas.height = image.height;
      const mapContext = mapCanvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (!mapContext) throw new Error("Canvas 2D is unavailable");
      mapContext.drawImage(image, 0, 0);
      surface = {
        width: image.width,
        height: image.height,
        pixels: mapContext.getImageData(0, 0, image.width, image.height).data,
      };
    } finally {
      image.close();
    }
    const clouds = await cloudsPromise;
    renderer = new GlobeRenderer(canvas, surface, clouds);
    renderer.showGrid = grid.checked;
    renderer.showClouds = cloudToggle.checked;
    renderer.draw(motion.orientation, reveal);
    updateRevealState();
    loading.hidden = true;
    updateStatus();
    invalidate();
  } catch (error) {
    console.error("Unable to initialize the globe:", error);
    loading.classList.add("is-error");
    loading.replaceChildren(
      document.createTextNode("地図を読み込めませんでした。"),
    );
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "もう一度試す";
    retry.addEventListener("click", initialize);
    loading.append(retry);
  } finally {
    requestInFlight = false;
  }
}

updateSpeed();
initialize();
