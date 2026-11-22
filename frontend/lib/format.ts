/**
 * Calendar dates ("2026-03-30") carry no time zone. Format them in UTC so a viewer
 * west of Greenwich never sees the previous day.
 */
export function formatDate(isoDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );
}

/** Instants (UTC timestamps from the API) are shown in the viewer's own time zone. */
export function formatDateTime(isoInstant: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(isoInstant));
}
