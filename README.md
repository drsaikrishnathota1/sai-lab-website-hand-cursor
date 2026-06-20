# Sai Lab Website — Hand Cursor Version 4

This version includes webcam hand cursor control with improved up/down scrolling.

## How to run

Camera access usually works only on localhost or HTTPS.

```bash
cd sai-lab-website
python3 -m http.server 8000
```

Open:

```text
http://localhost:8000
```

## Hand gestures

- Move cursor: point with your index finger.
- Click: quick pinch with thumb + index finger.
- Scroll mode: show index + middle fingers only.
- Page down: keep two fingers pointing up.
- Page up: turn the same two fingers downward.
- Adjust scroll speed using the Scroll sensitivity slider.

## V4 fix

The old version mainly detected two fingers pointing upward, so page-down worked but page-up could fail at the bottom. V4 detects two extended fingers in either direction:

- Two fingers up = scroll down.
- Two fingers down = scroll up.

Keep ring and pinky folded for more accurate scroll detection.
