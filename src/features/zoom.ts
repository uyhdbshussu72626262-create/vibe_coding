export const ZOOM_MIN = 0.75;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.05;

export function clampZoom(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, rounded));
}

export function nextZoom(current: number, direction: number): number {
  return clampZoom(current - Math.sign(direction) * ZOOM_STEP);
}

export function applyZoom(value: number): void {
  document.documentElement.style.setProperty('--app-zoom', String(clampZoom(value)));
}
