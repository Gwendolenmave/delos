/**
 * Doctor: operational truth as a list of independent, read-only checks.
 *
 * Core owns the frame only - what a check IS, how a report aggregates, and
 * how a report is redacted for export. The concrete checks are composed by
 * the surfaces from their real dependencies, because what can be checked
 * depends on what is composed (a daemon can verify its live socket; the CLI
 * can only verify what is on disk).
 *
 * Doctor NEVER repairs: no deletion, no webhook removal, no logout, no
 * database recreation, no credential change, no rebinding. A check that
 * cannot run reports BLOCKED honestly instead of throwing.
 */

export type DoctorStatus = "PASS" | "DEGRADED" | "BLOCKED";

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly status: DoctorStatus;
  /** Safe for export: no secret, no prompt text, no account identifier. */
  readonly detail: string;
}

export interface DoctorReport {
  readonly generatedAtIso: string;
  readonly overall: DoctorStatus;
  readonly checks: readonly DoctorCheck[];
}

export type DoctorCheckRunner = () => Promise<DoctorCheck>;

const SEVERITY: Record<DoctorStatus, number> = { PASS: 0, DEGRADED: 1, BLOCKED: 2 };

export async function runDoctor(
  runners: readonly DoctorCheckRunner[],
  nowIso: string,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  for (const runner of runners) {
    try {
      checks.push(await runner());
    } catch (error) {
      // A crashing check is itself a finding, never a crash of doctor. The
      // error text is NOT relayed - it can carry paths.
      checks.push({
        id: "check-crashed",
        title: "A doctor check failed to run",
        status: "BLOCKED",
        detail: "The check threw instead of reporting; that is a bug worth reporting.",
      });
    }
  }
  const overall = checks.reduce<DoctorStatus>(
    (worst, check) => (SEVERITY[check.status] > SEVERITY[worst] ? check.status : worst),
    "PASS",
  );
  return { generatedAtIso: nowIso, overall, checks };
}

/**
 * Belt-and-braces scrub for the exportable report. Checks are WRITTEN to be
 * safe; this pass removes anything path- or credential-shaped that slipped
 * through anyway, because an exported report travels.
 */
const PATHLIKE = /(?:\/(?:home|Users|tmp|var|mnt|etc)\/[^\s"']*|[A-Za-z]:\\[^\s"']*)/g;
const KEYLIKE = /\b(?:sk|rk|pk)-[A-Za-z0-9]{8,}\b/g;
const TOKENLIKE = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;

export function redactDoctorReport(report: DoctorReport): DoctorReport {
  const scrub = (text: string): string =>
    text.replace(PATHLIKE, "<path>").replace(KEYLIKE, "<redacted>").replace(TOKENLIKE, "<redacted>");
  return {
    generatedAtIso: report.generatedAtIso,
    overall: report.overall,
    checks: report.checks.map((check) => ({
      id: check.id,
      title: scrub(check.title),
      status: check.status,
      detail: scrub(check.detail),
    })),
  };
}
