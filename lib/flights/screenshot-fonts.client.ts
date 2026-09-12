// Resolve font URLs against their stylesheet, not the current page URL.
// Next.js emits relative URLs in development, which html-to-image misresolves.
let embeddedFonts: Promise<string> | undefined;

export function screenshotFonts(): Promise<string> {
  if (embeddedFonts) return embeddedFonts;
  embeddedFonts = (async () => {
    const rules: { css: string; base: string }[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule.type === CSSRule.FONT_FACE_RULE && !rule.cssText.includes('__nextjs')) {
            rules.push({ css: rule.cssText, base: sheet.href || document.baseURI });
          }
        }
      } catch {
        // Cross-origin stylesheets cannot be inspected by the browser.
      }
    }
    return (await Promise.all(rules.map(async ({ css, base }) => {
      for (const match of Array.from(css.matchAll(/url\(["']?([^"')]+)["']?\)/g))) {
        const response = await fetch(new URL(match[1], base), { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Could not load screenshot font');
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        css = css.replace(match[0], `url("${dataUrl}")`);
      }
      return css;
    }))).join('\n');
  })().catch((error) => {
    embeddedFonts = undefined;
    throw error;
  });
  return embeddedFonts;
}
