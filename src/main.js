import "./style.css";
import { GlobeMotion, rotateVector } from "./motion.js";
import { GlobeRenderer } from "./renderer.js";

const DEFAULT_SPEED = 0.13;
const canvas = document.querySelector("#globe");
const stage = document.querySelector("#globe-stage");
const status = document.querySelector("#motion-status");
const statusLed = document.querySelector("#status-led");
const autoRotate = document.querySelector("#auto-rotate");
const speed = document.querySelector("#speed");
const speedValue = document.querySelector("#speed-value");
const grid = document.querySelector("#show-grid");
const loading = document.querySelector("#loading-message");
const coordinates = document.querySelector("#coordinates");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const motion = new GlobeMotion({ autoRotate: !reducedMotion.matches });
let renderer = null;
let activePointer = null;
let previousPointer = null;
let frameId = 0;
let previousFrame = 0;
let lastCoordinateUpdate = 0;
let requestInFlight = false;

function updateStatus() {
  const state = motion.dragging
    ? "dragging"
    : motion.autoRotate
      ? "running"
      : "paused";
  const labels = {
    dragging: "ドラッグ中",
    running: "自動回転中",
    paused: "一時停止中",
  };
  if (renderer && status.textContent !== labels[state])
    status.textContent = labels[state];
  autoRotate.setAttribute("aria-checked", String(motion.autoRotate));
  statusLed.classList.toggle("is-paused", state === "paused");
  document.querySelector("#rotation-description").textContent =
    motion.autoRotate ? "最後に動かした方向へ" : "ドラッグで操作できます";
  canvas.dataset.state = renderer ? state : "loading";
  canvas.dataset.directionX = String(motion.driftAxis[1]);
  canvas.dataset.directionY = String(motion.driftAxis[0]);
  canvas.dataset.speed = String(motion.speed);
}

function updateCoordinates() {
  const [x, y, z, w] = motion.orientation;
  const center = rotateVector([0, 0, 1], [-x, -y, -z, w]);
  const latitude =
    (Math.asin(Math.max(-1, Math.min(1, center[1]))) * 180) / Math.PI;
  const longitude = (Math.atan2(center[0], center[2]) * 180) / Math.PI;
  coordinates.textContent = `${Math.abs(latitude).toFixed(1)}° ${latitude < 0 ? "S" : "N"}   ${Math.abs(longitude).toFixed(1)}° ${longitude < 0 ? "W" : "E"}`;
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
  if (previousFrame) motion.step((timestamp - previousFrame) / 1000);
  previousFrame = timestamp;
  renderer.draw(motion.orientation);
  if (
    timestamp - lastCoordinateUpdate > 120 ||
    !motion.autoRotate ||
    motion.dragging
  ) {
    updateCoordinates();
    lastCoordinateUpdate = timestamp;
  }
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

document.querySelector("#reset").addEventListener("click", () => {
  endDrag();
  motion.reset();
  motion.setAutoRotate(!reducedMotion.matches);
  speed.value = "1";
  updateSpeed();
  grid.checked = false;
  if (renderer) renderer.showGrid = false;
  updateCoordinates();
  previousFrame = 0;
  updateStatus();
  invalidate();
});

document.querySelector("#explore").addEventListener("click", () => {
  canvas.scrollIntoView({
    behavior: reducedMotion.matches ? "instant" : "smooth",
    block: "center",
  });
  canvas.focus({ preventScroll: true });
  stage.classList.remove("is-invited");
  void stage.offsetWidth;
  stage.classList.add("is-invited");
});
stage.addEventListener("animationend", () =>
  stage.classList.remove("is-invited"),
);

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
    motion.setAutoRotate(false);
    updateStatus();
    invalidate();
  }
});

async function initialize() {
  if (requestInFlight) return;
  requestInFlight = true;
  loading.hidden = false;
  loading.classList.remove("is-error");
  loading.textContent = "世界を描いています…";
  status.textContent = "読み込み中";
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
    renderer = new GlobeRenderer(canvas, surface);
    renderer.showGrid = grid.checked;
    renderer.draw(motion.orientation);
    loading.hidden = true;
    updateStatus();
    invalidate();
  } catch (error) {
    console.error("Unable to initialize the globe:", error);
    status.textContent = "読み込みエラー";
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
