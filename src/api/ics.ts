// iCalendar feed for the deadlines (pure, so tests can import it).

export interface CalendarItem {
  id: string; org: string; title: string; kind: string; date: string | null; status: string;
  confidence: string; evidence: string | null; source_url: string | null; job_url: string | null;
}

// ── iCalendar (RFC 5545) ─────────────────────────────────────────────────────
const KIND_LABEL: Record<string, string> = {
  accelerator: "🚀 Accelerator", phd: "🎓 PhD", hackathon: "🛠 Hackathon", event: "📅 Event", job: "💼 Job", personal: "📌 Personal",
};

/** Escape text per RFC 5545 §3.3.11 and fold lines at 75 octets (approximated by characters). */
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = (line: string) => line.length <= 74 ? line : line.match(/.{1,73}/g)!.join("\r\n ");
const ymd = (d: string) => d.replace(/-/g, "");
const nextDay = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

export function toIcs(items: CalendarItem[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Chotu//Deadlines//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Chotu deadlines", "X-PUBLISHED-TTL:PT6H", "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
  ];
  for (const d of items) {
    if (!d.date || d.status === "dismissed") continue;
    const link = d.source_url ?? d.job_url;
    const desc = [
      `${KIND_LABEL[d.kind] ?? d.kind}${d.confidence === "unverified" ? " · ⚠️ date not verified — check the source" : ""}`,
      d.evidence ? `"${d.evidence}"` : "", link ?? "",
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${d.id}@chotu`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(d.date)}`,
      `DTEND;VALUE=DATE:${ymd(nextDay(d.date))}`,
      `SUMMARY:${icsText(`${d.status === "done" ? "✓ " : ""}${d.org} — ${d.title}`)}`,
      `DESCRIPTION:${icsText(desc)}`,
      ...(link ? [`URL:${icsText(link)}`] : []),
      `CATEGORIES:${icsText(d.kind)}`,
      "TRANSP:TRANSPARENT",
      // A reminder the day before at 09:00 (apps that honour alarms in subscribed calendars).
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(`${d.org} — ${d.title}`)}`, "TRIGGER:-PT15H", "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
