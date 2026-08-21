import { buildScorecard, type Scorecard } from './grading.js';
import { deriveFindings, formatDuration, type FindingDeps } from './findings.js';
import type { Finding, RunSummary } from './types.js';

/**
 * The report. Findings first, grade second — a letter is a hook, not a
 * deliverable, and the reason anyone runs this tool is the list of things their
 * monitoring cannot see.
 */
export interface RenderDeps extends FindingDeps {
  readonly run: RunSummary;
}

const KIND_ORDER: Record<Finding['kind'], number> = {
  needs_instrumentation: 0,
  blind_spot: 1,
  noisy: 2,
  late: 3,
  covered: 4,
};

const KIND_LABEL: Record<Finding['kind'], string> = {
  needs_instrumentation: 'Not instrumented',
  blind_spot: 'Blind spot',
  noisy: 'Alerted, unhelpfully',
  late: 'Detected late',
  covered: 'Working',
};

export function renderMarkdown(deps: RenderDeps): string {
  const scorecard = buildScorecard(deps.run);
  const findings = [...deriveFindings(deps.run.outcomes, deps)].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.experimentId.localeCompare(b.experimentId),
  );

  return [
    `# Observability drill — ${deps.run.runId}`,
    '',
    headline(scorecard, findings),
    '',
    renderScorecard(scorecard),
    '',
    renderFindings(findings, deps.run),
    '',
    renderProposedRules(findings),
    '',
    renderProvenance(deps.run, scorecard),
    '',
  ].join('\n');
}

function headline(scorecard: Scorecard, findings: readonly Finding[]): string {
  const blind = findings.filter((f) => f.kind === 'blind_spot').length;
  const uninstrumented = findings.filter((f) => f.kind === 'needs_instrumentation').length;

  if (blind === 0 && uninstrumented === 0) {
    return `Every fault drilled was detected and correctly diagnosed. Grade **${scorecard.grade}**.`;
  }

  const parts: string[] = [];
  if (blind > 0) {
    parts.push(
      `**${String(blind)} fault${blind === 1 ? '' : 's'} produced no alert at all** despite the signal already being recorded`,
    );
  }
  if (uninstrumented > 0) {
    parts.push(
      `**${String(uninstrumented)}** could not have alerted, because nothing records the failure`,
    );
  }
  return `${parts.join(', and ')}. Grade **${scorecard.grade}**.`;
}

function renderScorecard(scorecard: Scorecard): string {
  const pct = (n: number): string => `${String(Math.round(n * 100))}%`;
  const lines = [
    '## Scorecard',
    '',
    '| | |',
    '|---|---|',
    `| Detection | ${String(scorecard.detected)}/${String(scorecard.total)} (${pct(scorecard.detectionRate)}) |`,
    scorecard.graded === 0
      ? '| Diagnosis | not attempted |'
      : `| Diagnosis | ${String(scorecard.diagnosed)}/${String(scorecard.graded)} (${pct(scorecard.diagnosisRate)}) |`,
    `| Median time to detect | ${
      scorecard.medianTimeToDetectMs === null
        ? 'n/a — nothing was detected'
        : formatDuration(scorecard.medianTimeToDetectMs)
    } |`,
    `| Grade | **${scorecard.grade}** |`,
  ];
  if (scorecard.needsReview > 0) {
    lines.push(
      '',
      `> ${String(scorecard.needsReview)} experiment(s) had a three-way split among graders and are marked \`needs_review\`. Treat those verdicts as unsettled.`,
    );
  }
  return lines.join('\n');
}

function renderFindings(findings: readonly Finding[], run: RunSummary): string {
  const sections = findings.map((finding) => {
    const outcome = run.outcomes.find((o) => o.id === finding.experimentId);
    const detection =
      outcome === undefined
        ? ''
        : outcome.detection.detected
          ? `Detected in ${formatDuration(outcome.detection.timeToDetectMs ?? 0)}.`
          : 'Never detected.';
    const noise =
      outcome !== undefined && outcome.detection.preexisting.length > 0
        ? ` ${plural(outcome.detection.preexisting.length, 'alert')} already firing throughout and not counted as detection: ${outcome.detection.preexisting
            .map((a) => `\`${a.alertname}\``)
            .join(', ')}.`
        : '';

    return [
      `### ${finding.title}`,
      '',
      `**${KIND_LABEL[finding.kind]}** · ${detection}${noise}`,
      '',
      finding.explanation,
      outcome === undefined || outcome.grade.verdict === 'skipped'
        ? ''
        : `\n> The blinded responder concluded: *${outcome.diagnosis.suspectedComponent}* (${outcome.diagnosis.faultCategory}, ${outcome.diagnosis.confidence} confidence) — graded **${outcome.grade.verdict}**.`,
    ].join('\n');
  });

  // Joined with a blank line: a `###` immediately after a blockquote gets
  // absorbed into it by CommonMark lazy continuation.
  return ['## Findings', '', sections.join('\n\n')].join('\n');
}

const plural = (n: number, noun: string): string =>
  n === 1 ? `1 ${noun} was` : `${String(n)} ${noun}s were`;

function renderProposedRules(findings: readonly Finding[]): string {
  const withRules = findings.filter((f) => f.proposedRule !== undefined);
  if (withRules.length === 0) {
    return ['## Proposed rules', '', 'No rules to propose.'].join('\n');
  }

  const yaml = withRules
    .map((finding) => {
      const rule = finding.proposedRule;
      if (rule === undefined) return '';
      return [
        `      # ${rule.rationale}`,
        `      - alert: ${rule.alertName}`,
        `        expr: ${rule.expr}`,
        `        for: ${rule.forDuration}`,
        `        labels:`,
        `          severity: ${rule.severity}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    '## Proposed rules',
    '',
    'Each of these reads a metric that already exists today.',
    '',
    '```yaml',
    'groups:',
    '  - name: alarmdrill-proposed',
    '    rules:',
    yaml,
    '```',
  ].join('\n');
}

function renderProvenance(run: RunSummary, scorecard: Scorecard): string {
  return [
    '## How this was produced',
    '',
    `Each fault was injected into a running system, then the alerts and metrics were handed to a blinded agent that was told nothing about what had been broken — not the fault, not the target, not the time it was injected. Its diagnosis was graded against ground truth by ${String(
      3,
    )} independent votes, taking the mode.`,
    '',
    `Alerts already firing before an experiment began do not count as detection. That is deliberate: a chronically-firing alert would otherwise make every blind spot look caught.`,
    '',
    '| | |',
    '|---|---|',
    `| Run | \`${run.runId}\` |`,
    `| Started | ${run.startedAt} |`,
    `| Model | \`${run.modelName}\` |`,
    ...Object.entries(run.promptVersions).map(
      ([name, version]) => `| Prompt \`${name}\` | \`${version}\` |`,
    ),
    `| Experiments | ${String(scorecard.total)} |`,
  ].join('\n');
}
