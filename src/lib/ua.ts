// Coarse browser / OS names from a User-Agent string. Versions are deliberately dropped.
export function browserOf(ua: string): string {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/CriOS\/|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}
export function osOf(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}
