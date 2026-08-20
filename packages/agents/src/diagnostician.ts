import type { EvidenceBundle } from '@alarmdrill/observers';
import { z } from 'zod';
import type { ModelClient } from './model.js';
import { loadPrompt } from './prompts.js';

/**
 * The blinded agent. It receives an EvidenceBundle and nothing else.
 *
 * There is deliberately no parameter here for the fault, the injector config or
 * the injection time — not optional, not nullable, absent. Handing this
 * function ground truth would require changing its signature, which is a code
 * review a human will notice. See SPEC.md, "Two things that must not break".
 */
export const diagnosisSchema = z.object({
  suspectedComponent: z
    .string()
    .describe('The single component most likely at fault, or "unknown".'),
  faultCategory: z.enum([
    'dependency_unavailable',
    'latency',
    'resource_exhaustion',
    'business_logic_failure',
    'configuration',
    'unknown',
  ]),
  confidence: z.enum(['low', 'medium', 'high']),
  reasoning: z.string().describe('How the evidence led here, in a few sentences.'),
  evidenceCited: z
    .array(z.string())
    .describe('The specific alerts or metrics that support this.'),
  missingTelemetry: z
    .string()
    .describe('The alert or metric that would have made this obvious.'),
});

export type Diagnosis = z.infer<typeof diagnosisSchema>;

export interface DiagnoseDeps {
  readonly model: ModelClient;
  readonly promptVersion?: string;
}

export interface DiagnosisResult {
  readonly diagnosis: Diagnosis;
  readonly promptVersion: string;
}

export async function diagnose(
  evidence: EvidenceBundle,
  deps: DiagnoseDeps,
): Promise<DiagnosisResult> {
  const prompt = loadPrompt('diagnostician', deps.promptVersion);
  const diagnosis = await deps.model.complete({
    system: prompt.text,
    user: renderEvidence(evidence),
    schema: diagnosisSchema,
  });
  return { diagnosis, promptVersion: prompt.version };
}

/**
 * Renders the bundle for the prompt. Exported so tests can assert on the exact
 * bytes the model would see — the blinding guarantee is only real if it holds
 * on the rendered string, not just on the object.
 */
export function renderEvidence(evidence: EvidenceBundle): string {
  const alerts =
    evidence.firingAlerts.length === 0
      ? 'No alerts are currently firing.'
      : evidence.firingAlerts
          .map((alert) => {
            const labels = Object.entries(alert.labels)
              .map(([key, value]) => `${key}=${value}`)
              .join(' ');
            const summary = alert.annotations['summary'] ?? '';
            return `- ${alert.alertname} [${alert.severity}] since ${alert.startsAt}\n    ${labels}\n    ${summary}`;
          })
          .join('\n');

  const metrics = evidence.metrics
    .map((entry) => {
      if (entry.series.length === 0) {
        return `### ${entry.description}\n\`${entry.query}\`\n\nNo data returned.`;
      }
      const rendered = entry.series
        .map((series) => {
          const labels = Object.entries(series.labels)
            .filter(([key]) => key !== '__name__')
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
          const points = summarise(series.samples.map((s) => s.value));
          return `  {${labels}}  ${points}`;
        })
        .join('\n');
      return `### ${entry.description}\n\`${entry.query}\`\n${rendered}`;
    })
    .join('\n\n');

  return [
    `Services in this system: ${evidence.services.join(', ')}`,
    `Window observed: ${evidence.window.from} to ${evidence.window.to}`,
    '',
    '## Alerts currently firing',
    alerts,
    '',
    '## Metrics',
    metrics,
  ].join('\n');
}

/** first / min / max / last, which is what someone reads off a graph anyway. */
function summarise(values: readonly number[]): string {
  if (values.length === 0) return '(no samples)';
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return '(no finite samples)';
  const round = (n: number): string => (Number.isInteger(n) ? String(n) : n.toPrecision(4));
  return `first=${round(finite[0] ?? 0)} min=${round(Math.min(...finite))} max=${round(
    Math.max(...finite),
  )} last=${round(finite.at(-1) ?? 0)} (${String(finite.length)} samples)`;
}
