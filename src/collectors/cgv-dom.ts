// Selectors observed on CGV's public booking page on 2026-09-08.
// Keep this function self-contained: Playwright serializes it into the page.
export function readScheduleDom() {
  const groups = Array.from(document.querySelectorAll('[class*="accordion_container"]'));
  return groups.flatMap(group => {
    const title = group.querySelector('h2 .title2')?.textContent?.trim() ?? "";
    return Array.from(group.querySelectorAll('[class*="screenInfo_contentWrap"]')).flatMap(screen => {
      const heading = screen.querySelector('h3')?.textContent?.trim() ?? "";
      const format = screen.querySelector('h3 span')?.textContent?.trim() ?? "";
      return Array.from(screen.querySelectorAll('button[class*="screenInfo_timeLink"]')).map(button => ({
        title,
        screen: heading.replace(format, "").trim(),
        format,
        time: button.querySelector('[class*="screenInfo_start"]')?.textContent?.trim() ?? "",
        status: button.querySelector('[class*="screenInfo_status"]')?.textContent?.trim() ?? "",
        disabled: (button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true',
      }));
    });
  });
}

export interface ScheduleRow {
  title: string;
  screen: string;
  format: string;
  time: string;
  status: string;
  disabled: boolean;
}
