const dot = document.querySelector('.cursor-dot');
const outline = document.querySelector('.cursor-outline');
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;
let outX = mouseX;
let outY = mouseY;
let handMode = false;
let lastClickTime = 0;
let lastHoverTarget = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setCursorPosition(x, y) {
  mouseX = clamp(x, 0, window.innerWidth - 1);
  mouseY = clamp(y, 0, window.innerHeight - 1);
  dot.style.left = `${mouseX}px`;
  dot.style.top = `${mouseY}px`;
}

window.addEventListener('mousemove', (event) => {
  if (handMode) return;
  setCursorPosition(event.clientX, event.clientY);
});

function animateCursor() {
  outX += (mouseX - outX) * 0.16;
  outY += (mouseY - outY) * 0.16;
  outline.style.left = `${outX}px`;
  outline.style.top = `${outY}px`;
  requestAnimationFrame(animateCursor);
}
animateCursor();

document.querySelectorAll('a, button').forEach((el) => {
  el.addEventListener('mouseenter', () => outline.style.transform = 'translate(-50%, -50%) scale(1.55)');
  el.addEventListener('mouseleave', () => outline.style.transform = 'translate(-50%, -50%) scale(1)');
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: 0.12 });

document.querySelectorAll('.service-card, .work-item, .contact').forEach((el) => observer.observe(el));

// Hand gesture cursor controls using MediaPipe Hands.
// Move: point with index finger.
// Click: quick pinch thumb + index.
// Scroll: use index + middle fingers. Fingers pointing UP scroll down; fingers pointing DOWN scroll up.
// V4 adds direction-based scrolling so page-up works reliably at the bottom.
const handToggle = document.querySelector('#handToggle');
const handStatus = document.querySelector('#handStatus');
const cameraVideo = document.querySelector('#handVideo');
const handCanvas = document.querySelector('#handCanvas');
const handPanel = document.querySelector('.hand-panel');
const handCtx = handCanvas ? handCanvas.getContext('2d') : null;
let hands = null;
let camera = null;
let pinchWasClosed = false;
let smoothX = mouseX;
let smoothY = mouseY;
let lastScrollY = null;
let lastScrollTime = 0;
let scrollVelocity = 0;
let scrollAccumulator = 0;
let scrollLockUntil = 0;
let scrollModeStartedAt = 0;
let stableScrollY = null;
const scrollSensitivityInput = document.querySelector('#scrollSensitivity');
const scrollHint = document.querySelector('#scrollHint');

// Edge calibration: you do not need to move your hand to the exact camera edge.
// Lower left/right/top/bottom values make corners easier to reach.
const calibration = {
  minX: 0.16,
  maxX: 0.84,
  minY: 0.14,
  maxY: 0.86,
  smoothing: 0.42,
  scrollSpeed: 3.2,
  scrollDeadZone: 0.009,
  scrollSmoothing: 0.34,
  autoScrollZone: 0.18,
};

function updateHandStatus(message) {
  if (handStatus) handStatus.textContent = message;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getScrollSensitivity() {
  const sliderValue = scrollSensitivityInput ? Number(scrollSensitivityInput.value) : 5;
  return clamp(sliderValue || 5, 1, 10) / 5;
}

function getPalmCenter(landmarks) {
  const points = [landmarks[0], landmarks[5], landmarks[9], landmarks[13], landmarks[17]];
  return points.reduce((acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }), { x: 0, y: 0 });
}

function setScrollHint(message) {
  if (scrollHint) scrollHint.textContent = message;
}

function mapHandToScreen(indexTip) {
  // MediaPipe x/y are normalized camera coordinates. Mirror x for natural movement.
  const mirroredX = 1 - indexTip.x;
  const mappedX = ((mirroredX - calibration.minX) / (calibration.maxX - calibration.minX)) * window.innerWidth;
  const mappedY = ((indexTip.y - calibration.minY) / (calibration.maxY - calibration.minY)) * window.innerHeight;
  return {
    x: clamp(mappedX, 0, window.innerWidth - 1),
    y: clamp(mappedY, 0, window.innerHeight - 1),
  };
}

function getClickableTarget(x, y) {
  const target = document.elementFromPoint(x, y);
  if (!target) return null;
  return target.closest('a, button, input, textarea, select, [role="button"]');
}

function updateHoverTarget(x, y) {
  const target = getClickableTarget(x, y);
  if (target !== lastHoverTarget) {
    if (lastHoverTarget) lastHoverTarget.classList.remove('hand-hover');
    if (target) target.classList.add('hand-hover');
    lastHoverTarget = target;
  }
  outline.style.transform = target
    ? 'translate(-50%, -50%) scale(1.65)'
    : 'translate(-50%, -50%) scale(1)';
}

function triggerHandClick(x, y) {
  const now = Date.now();
  if (now - lastClickTime < 650) return;
  lastClickTime = now;

  const target = getClickableTarget(x, y);
  dot.classList.add('clicking');
  outline.classList.add('clicking');
  setTimeout(() => {
    dot.classList.remove('clicking');
    outline.classList.remove('clicking');
  }, 180);

  if (target) target.click();
}

function isFingerRaised(landmarks, tipIndex, pipIndex) {
  return landmarks[tipIndex].y < landmarks[pipIndex].y - 0.025;
}

function isFingerExtended(landmarks, tipIndex, pipIndex, mcpIndex) {
  const tip = landmarks[tipIndex];
  const pip = landmarks[pipIndex];
  const mcp = landmarks[mcpIndex];
  const straightEnough = distance(tip, mcp) > distance(pip, mcp) * 1.08;
  return straightEnough;
}

function getScrollGestureInfo(landmarks, pinchClosed) {
  if (pinchClosed) return { active: false, direction: 0 };

  const indexExtended = isFingerExtended(landmarks, 8, 6, 5);
  const middleExtended = isFingerExtended(landmarks, 12, 10, 9);
  const ringExtended = isFingerExtended(landmarks, 16, 14, 13);
  const pinkyExtended = isFingerExtended(landmarks, 20, 18, 17);
  const twoFingerSpacing = Math.abs(landmarks[8].x - landmarks[12].x) > 0.018;

  // Scroll mode is now based on index + middle being extended, not only pointing upward.
  // This allows a clear "two fingers down" gesture for scrolling back up from the page bottom.
  const active = indexExtended && middleExtended && !ringExtended && !pinkyExtended && twoFingerSpacing;
  if (!active) return { active: false, direction: 0 };

  const avgTipY = (landmarks[8].y + landmarks[12].y) / 2;
  const avgPipY = (landmarks[6].y + landmarks[10].y) / 2;
  const fingerDirection = avgTipY - avgPipY;

  // Browser scroll convention: positive = page down, negative = page up.
  if (fingerDirection < -0.020) return { active: true, direction: 1, label: 'Fingers up: scrolling down' };
  if (fingerDirection > 0.020) return { active: true, direction: -1, label: 'Fingers down: scrolling up' };
  return { active: true, direction: 0, label: 'Tilt two fingers up or down' };
}

function handleScrollGesture(landmarks, gestureInfo) {
  const now = Date.now();
  if (now < scrollLockUntil) return;

  const palm = getPalmCenter(landmarks);
  const rawY = palm.y;
  const sensitivity = getScrollSensitivity();

  if (!scrollModeStartedAt) scrollModeStartedAt = now;
  const inWarmup = now - scrollModeStartedAt < 120;
  let pixels = 0;

  // Primary V4 control: finger direction.
  // Two fingers UP = scroll down. Two fingers DOWN = scroll up.
  if (!inWarmup && gestureInfo.direction) {
    pixels = gestureInfo.direction * 15 * sensitivity;
    setScrollHint(gestureInfo.label);
  }

  // Secondary fallback: if fingers are sideways/unclear, use top/bottom active zone.
  if (!inWarmup && !gestureInfo.direction) {
    if (rawY < calibration.minY + calibration.autoScrollZone) {
      const strength = (calibration.minY + calibration.autoScrollZone - rawY) / calibration.autoScrollZone;
      pixels = -strength * 14 * sensitivity;
      setScrollHint('Top zone: scrolling up');
    } else if (rawY > calibration.maxY - calibration.autoScrollZone) {
      const strength = (rawY - (calibration.maxY - calibration.autoScrollZone)) / calibration.autoScrollZone;
      pixels = strength * 14 * sensitivity;
      setScrollHint('Bottom zone: scrolling down');
    } else {
      setScrollHint('Tilt two fingers up for down, down for up');
    }
  }

  scrollVelocity += (pixels - scrollVelocity) * 0.55;
  scrollAccumulator += scrollVelocity;

  if (Math.abs(scrollAccumulator) >= 1) {
    window.scrollBy({ top: scrollAccumulator, left: 0, behavior: 'auto' });
    scrollAccumulator = 0;
  }

  lastScrollY = rawY;
  lastScrollTime = now;
}

function resetScrollGesture() {
  lastScrollY = null;
  lastScrollTime = 0;
  scrollVelocity = 0;
  scrollAccumulator = 0;
  scrollModeStartedAt = 0;
  stableScrollY = null;
  setScrollHint('Scroll: two fingers, then move wrist up/down');
}

function drawHandPreview(results) {
  if (!handCtx || !handCanvas || !cameraVideo) return;
  handCanvas.width = cameraVideo.videoWidth || 640;
  handCanvas.height = cameraVideo.videoHeight || 480;
  handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
  handCtx.save();
  handCtx.scale(-1, 1);
  handCtx.drawImage(cameraVideo, -handCanvas.width, 0, handCanvas.width, handCanvas.height);

  // Draw the calibrated active area so you know where to keep your hand.
  handCtx.strokeStyle = 'rgba(232,209,164,.95)';
  handCtx.lineWidth = 4;
  handCtx.setLineDash([16, 12]);
  handCtx.strokeRect(
    calibration.minX * handCanvas.width,
    calibration.minY * handCanvas.height,
    (calibration.maxX - calibration.minX) * handCanvas.width,
    (calibration.maxY - calibration.minY) * handCanvas.height
  );
  handCtx.restore();

  if (results.multiHandLandmarks && window.drawConnectors && window.drawLandmarks && window.HAND_CONNECTIONS) {
    handCtx.save();
    handCtx.scale(-1, 1);
    handCtx.translate(-handCanvas.width, 0);
    for (const landmarks of results.multiHandLandmarks) {
      window.drawConnectors(handCtx, landmarks, window.HAND_CONNECTIONS, { color: '#e8d1a4', lineWidth: 3 });
      window.drawLandmarks(handCtx, landmarks, { color: '#91e7ff', lineWidth: 2, radius: 3 });
    }
    handCtx.restore();
  }
}

function handleHandResults(results) {
  drawHandPreview(results);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    updateHandStatus('Hand mode: show your hand inside the big camera box');
    setScrollHint('No hand detected');
    resetScrollGesture();
    return;
  }

  const landmarks = results.multiHandLandmarks[0];
  const indexTip = landmarks[8];
  const thumbTip = landmarks[4];
  const mapped = mapHandToScreen(indexTip);

  smoothX += (mapped.x - smoothX) * calibration.smoothing;
  smoothY += (mapped.y - smoothY) * calibration.smoothing;
  setCursorPosition(smoothX, smoothY);
  updateHoverTarget(smoothX, smoothY);

  const pinchDistance = distance(indexTip, thumbTip);
  const pinchClosed = pinchDistance < 0.045;
  const scrollGesture = getScrollGestureInfo(landmarks, pinchClosed);

  if (scrollGesture.active) {
    document.body.classList.add('hand-scrolling');
    handleScrollGesture(landmarks, scrollGesture);
    pinchWasClosed = false;
    updateHandStatus('Scroll mode: two fingers detected');
    return;
  }

  document.body.classList.remove('hand-scrolling');
  resetScrollGesture();

  if (pinchClosed && !pinchWasClosed) {
    triggerHandClick(smoothX, smoothY);
    scrollLockUntil = Date.now() + 250;
  }
  pinchWasClosed = pinchClosed;

  updateHandStatus(pinchClosed ? 'Pinch detected: click' : 'Hand mode: point to move, pinch to click');
}

async function startHandMode() {
  if (!handToggle || !cameraVideo) return;
  try {
    handMode = true;
    document.body.classList.add('hand-mode');
    handToggle.textContent = 'Disable hand cursor';
    updateHandStatus('Starting camera...');

    if (!window.Hands || !window.Camera) {
      throw new Error('Hand tracking library did not load. Check internet connection or CDN access.');
    }

    hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.56,
      minTrackingConfidence: 0.56,
    });
    hands.onResults(handleHandResults);

    camera = new window.Camera(cameraVideo, {
      onFrame: async () => {
        if (hands && handMode) await hands.send({ image: cameraVideo });
      },
      width: 960,
      height: 720,
    });
    await camera.start();
    handPanel.classList.add('active');
    updateHandStatus('Hand mode: point to move, pinch to click');
  } catch (error) {
    console.error(error);
    stopHandMode();
    updateHandStatus('Camera blocked or hand tracking failed. Use HTTPS or localhost.');
  }
}

function stopHandMode() {
  handMode = false;
  pinchWasClosed = false;
  resetScrollGesture();
  document.body.classList.remove('hand-mode', 'hand-scrolling');
  if (handToggle) handToggle.textContent = 'Enable hand cursor';
  if (handPanel) handPanel.classList.remove('active');
  if (lastHoverTarget) lastHoverTarget.classList.remove('hand-hover');
  lastHoverTarget = null;

  if (camera && camera.stop) camera.stop();
  camera = null;
  hands = null;
  updateHandStatus('Hand mode: off');
}

if (handToggle) {
  handToggle.addEventListener('click', () => {
    if (handMode) stopHandMode();
    else startHandMode();
  });
}
