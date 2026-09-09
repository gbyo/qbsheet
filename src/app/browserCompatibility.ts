export function isSafariBrowser(userAgent?: string): boolean {
  const resolvedUserAgent = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return (
    /Safari\//.test(resolvedUserAgent) &&
    !/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|OPT|Opera|Firefox|FxiOS)\//.test(resolvedUserAgent)
  );
}
