export interface WeatherSnapshot {
  city: string;
  latitude: number;
  longitude: number;
  temperature: number;
  weatherCode: number;
  windSpeed: number;
  updatedAt: number;
}

export interface GeoPoint {
  name: string;
  latitude: number;
  longitude: number;
}

const CACHE_KEY = 'daynora.weather.cache.v1';
export const WEATHER_TTL_MS = 30 * 60 * 1000;

export function isWeatherCacheFresh(
  snapshot: WeatherSnapshot | null,
  now = Date.now(),
  ttlMs = WEATHER_TTL_MS,
): boolean {
  if (!snapshot) return false;
  return now - snapshot.updatedAt < ttlMs;
}

export function weatherEmoji(code: number): string {
  if (code === 0) return '☀️';
  if (code >= 1 && code <= 3) return '⛅';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌧️';
  if (code >= 85 && code <= 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌤️';
}

export function weatherLabel(code: number, language: 'zh-CN' | 'en'): string {
  const zh = code === 0 ? '晴' : code <= 3 ? '多云' : code === 45 || code === 48 ? '雾' : code <= 57 ? '毛毛雨' : code <= 67 ? '雨' : code <= 77 ? '雪' : code <= 82 ? '阵雨' : code <= 86 ? '阵雪' : '雷雨';
  const en = code === 0 ? 'Clear' : code <= 3 ? 'Cloudy' : code === 45 || code === 48 ? 'Fog' : code <= 57 ? 'Drizzle' : code <= 67 ? 'Rain' : code <= 77 ? 'Snow' : code <= 82 ? 'Showers' : code <= 86 ? 'Snow showers' : 'Thunderstorm';
  return language === 'zh-CN' ? zh : en;
}

export async function geocodeCity(city: string): Promise<GeoPoint | null> {
  const params = new URLSearchParams({
    name: city,
    count: '1',
    language: 'zh',
    format: 'json',
  });
  const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`);
  if (!response.ok) throw new Error(`geocoding failed: ${response.status}`);
  const payload = (await response.json()) as {
    results?: Array<{ name: string; latitude: number; longitude: number }>;
  };
  const first = payload.results?.[0];
  if (!first) return null;
  return { name: first.name, latitude: first.latitude, longitude: first.longitude };
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  language: 'zh-CN' | 'en' = 'zh-CN',
): Promise<string> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    localityLanguage: language === 'zh-CN' ? 'zh' : 'en',
  });
  const response = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?${params.toString()}`,
  );
  if (!response.ok) throw new Error(`reverse geocoding failed: ${response.status}`);
  const payload = (await response.json()) as {
    city?: string;
    locality?: string;
    principalSubdivision?: string;
    countryName?: string;
  };
  return (
    payload.city ||
    payload.locality ||
    payload.principalSubdivision ||
    payload.countryName ||
    (language === 'zh-CN' ? '当前位置' : 'Current location')
  );
}

export async function fetchWeatherByPoint(point: GeoPoint): Promise<WeatherSnapshot> {
  const params = new URLSearchParams({
    latitude: String(point.latitude),
    longitude: String(point.longitude),
    current: 'temperature_2m,weather_code,wind_speed_10m',
    timezone: 'auto',
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!response.ok) throw new Error(`weather failed: ${response.status}`);
  const payload = (await response.json()) as {
    current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
  };
  const current = payload.current;
  if (!current) throw new Error('weather payload is missing current data');
  return {
    city: point.name,
    latitude: point.latitude,
    longitude: point.longitude,
    temperature: Number(current.temperature_2m ?? 0),
    weatherCode: Number(current.weather_code ?? 0),
    windSpeed: Number(current.wind_speed_10m ?? 0),
    updatedAt: Date.now(),
  };
}

export async function fetchWeatherForCity(city: string): Promise<WeatherSnapshot> {
  const point = await geocodeCity(city);
  if (!point) throw new Error(`city not found: ${city}`);
  return fetchWeatherByPoint(point);
}

export function loadCachedWeather(): WeatherSnapshot | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as WeatherSnapshot) : null;
  } catch {
    return null;
  }
}

export function saveCachedWeather(snapshot: WeatherSnapshot): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // noop
  }
}

export function getBrowserLocation(): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('geolocation is unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          name: '',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      (error) => reject(error),
      { timeout: 8000 },
    );
  });
}
