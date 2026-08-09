export function isSafariBrowser(userAgent: string = navigator.userAgent): boolean {
  return (
    /Safari\//.test(userAgent) &&
    !/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|Opera|Firefox|FxiOS)\//.test(userAgent)
  );
}
