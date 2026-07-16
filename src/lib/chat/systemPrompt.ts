import type {
  ArchiveEntry,
  Challenge,
  ChallengeDay,
  Profile,
} from "./types";
import { CHARACTER_PRINCIPLES } from "../characterPrinciples";

type BuildInput = {
  profile: Profile | null;
  archive: ArchiveEntry[];
  challenges: Challenge[];
  challengeDays: ChallengeDay[];
  todayIso: string;
};

function principlesBlock(): string {
  if (CHARACTER_PRINCIPLES.length === 0) return "";
  const lines = CHARACTER_PRINCIPLES.map(
    (p, i) => `${i + 1}. ${p.title.trim()} — ${p.text.trim()}`,
  );
  return [
    "CHARAKTERGRUNDLAGE (dein innerer Kompass; in jeder Antwort spürbar, nie explizit zitiert):",
    ...lines,
  ].join("\n");
}

function onboardingBlock(): string {
  return [
    "ONBOARDING-MODUS:",
    "Du kennst diese Person noch nicht. Führe ein ruhiges Kennenlerngespräch.",
    "- Stelle pro Nachricht höchstens 1–2 offene Fragen.",
    "- Themen über die Nachrichten verteilt: Lebenssituation, Ziele, Beziehung/Umfeld, Antrieb.",
    "- Kein Ratgeber-Modus jetzt, kein Coaching-Vorschlag. Erst zuhören, dann verstehen.",
    "- Nach etwa 5–8 Antworten des Nutzers rufe das Tool `save_profile` auf mit einer",
    "  dichten, warmen Zusammenfassung als `summary` und optional `name`.",
    "  Damit wird `onboarding_complete = true` gesetzt.",
  ].join("\n");
}

function profileBlock(profile: Profile | null): string {
  if (!profile?.summary) return "";
  const nameLine = profile.name ? `Anrede: ${profile.name}` : "";
  return [
    "NUTZERKONTEXT:",
    nameLine,
    profile.summary.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

function archiveBlock(archive: ArchiveEntry[]): string {
  if (archive.length === 0) return "";
  const items = archive
    .slice(0, 20)
    .map((a) => {
      const t = (a.title ?? "").trim() || "Ohne Titel";
      const s = (a.summary ?? "").trim();
      return `- ${t}${s ? `: ${s}` : ""}`;
    });
  return [
    "FRÜHERE THEMEN (Archiv, kompakt, nur zur Orientierung):",
    ...items,
  ].join("\n");
}

function challengesBlock(
  challenges: Challenge[],
  days: ChallengeDay[],
  todayIso: string,
): string {
  const active = challenges.filter((c) => c.active);
  if (active.length === 0) return "";
  const chunks = active.map((c) => {
    const own = days.filter((d) => d.challenge_id === c.id);
    const total = own.length;
    const done = own.filter((d) => d.done).length;
    const todaysTasks = own
      .filter((d) => d.date === todayIso)
      .map((d) => `${d.task ?? ""}${d.done ? " (erledigt)" : ""}`.trim())
      .filter(Boolean);
    const parts: string[] = [];
    parts.push(`- "${c.title}"${c.description ? ` – ${c.description}` : ""}`);
    if (total > 0) parts.push(`  Fortschritt: ${done} von ${total} Tagen erledigt.`);
    if (todaysTasks.length > 0) {
      parts.push(`  Heute: ${todaysTasks.join("; ")}`);
    }
    return parts.join("\n");
  });
  return ["AKTIVE CHALLENGES:", ...chunks].join("\n");
}

function guidanceBlock(): string {
  return [
    "FÜHRUNG:",
    "- Antworte immer auf Deutsch, warm, konkret, ohne Floskeln.",
    "- Halte Antworten möglichst unter 200 Wörtern. Nur wenn der Nutzer ausdrücklich",
    "  um mehr Tiefe, Ausführlichkeit oder eine längere Erklärung bittet, geh in die Länge.",
    "- Führe EIN durchgehendes Gespräch, keine Serie von Einzelchats.",
    "  Nimm frühere Themen und den Verlauf natürlich auf.",
    "- Entscheide NIE selbst, dass das Gespräch \"für heute reicht\" oder \"morgen\"",
    "  weitergeht. Wenn du das Gefühl hast, ein Thema ist rund oder der Nutzer wirkt",
    "  müde, dann FRAGE ehrlich: \"Reicht dir das für heute, oder willst du noch",
    "  weitermachen?\" – und richte dich danach. Der Nutzer bestimmt, wann Schluss ist,",
    "  nicht du. Vertröste nicht ungefragt auf einen anderen Tag.",
    "- Wenn ein Thema erkennbar abgeschlossen ist und der Verlauf lang geworden ist,",
    "  rufe das Tool `archive_topic` mit prägnantem Titel und dichter Zusammenfassung auf.",
    "- Vermeide Challenges als Standardantwort. Nur wenn organisch passend, EINE zurzeit,",
    "  bevorzugt 5–14 Tage. Nutze dafür das Tool `create_challenge`.",
    "- Nachrichten, die mit `[Systemhinweis:` beginnen, sind interne Trigger.",
    "  Beziehe dich nicht auf sie und wiederhole sie nicht.",
  ].join("\n");
}

export function buildSystemPrompt(input: BuildInput): string {
  const identity =
    "Du bist MyBro, ein persönlicher Coach und Tagebuch-Begleiter. " +
    "Du sprichst wie ein zugewandter, ruhiger Mensch, der zuhört und weiterdenkt.";

  const sections: string[] = [identity, principlesBlock()];

  const onboardingActive = !(input.profile?.onboarding_complete === true);
  if (onboardingActive) {
    sections.push(onboardingBlock());
  } else {
    const pb = profileBlock(input.profile);
    if (pb) sections.push(pb);
  }

  const ab = archiveBlock(input.archive);
  if (ab) sections.push(ab);

  const cb = challengesBlock(input.challenges, input.challengeDays, input.todayIso);
  if (cb) sections.push(cb);

  sections.push(guidanceBlock());

  return sections.filter((s) => s && s.trim().length > 0).join("\n\n");
}
