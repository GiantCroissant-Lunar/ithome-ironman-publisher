export function expectedArticleTitle(template: string, dayNumber: number): string {
  return template
    .replaceAll('{day2}', String(dayNumber).padStart(2, '0'))
    .replaceAll('{day}', String(dayNumber));
}

export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function titlesMatch(left: string, right: string): boolean {
  return normalizeTitle(left) === normalizeTitle(right);
}
