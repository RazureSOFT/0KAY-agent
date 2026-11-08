/**
 * A worked example of the gate half of an agent plugin.
 *
 * The point of these hooks is that the quality gate is not a fixed pipeline the
 * plugin can only watch. A workspace with a house rule — "nothing ships without
 * a runnable proof" — can make the gate enforce it without forking the agent.
 *
 * Three rules this file follows, and that any plugin hooking the gate should:
 *
 * 1. Say what is wrong, not that the agent is bad. `fix_feedback` goes straight
 *    to the model that is about to retry, so it must be actionable.
 * 2. Refuse only on evidence the hook is given. This one reads the intent ledger
 *    and the tool trace; it does not guess.
 * 3. Never throw. A hook that throws is logged and skipped, which would silently
 *    turn a policy into a no-op — worse than not having the plugin at all.
 */

// A command whose output is a proof rather than an assertion. Deliberately
// broad: a false positive costs one review round, a false negative ships
// unverified work.
const VERIFY = /\b(test|vitest|pytest|go test|cargo test|tsc|typecheck|lint|eslint|build|gofmt|go vet|check)\b/i;

export default function register(api) {
  return {
    /**
     * Refuse a done-claim that has no runnable proof behind it.
     *
     * The gate's own reviewer can reach the same conclusion, but it costs a
     * model call and a minute. This is a fact about the trace, and a fact can be
     * checked for free.
     */
    onGateCheck({ intents, completion, touched, trace, delivery }) {
      if (!touched.length && !delivery.mutations) return

      const open = intents.filter((row) => row.status !== 'done')
      if (open.length) {
        return {
          block:
            `Refused by plugin delivery-policy: ${open.length} intent(s) are still open ` +
            `(${open.map((row) => row.id).join(', ')}) while ${touched.length || delivery.mutations} file(s) were changed. ` +
            'Close them with evidence, or mark them blocked and say why.',
        }
      }
      if (completion < 100) {
        return { block: `Refused by plugin delivery-policy: the ledger derives ${completion}%, not 100%.` }
      }

      const proved = (delivery.evidence || []).length > 0
        || trace.some((entry) => entry.ok && (VERIFY.test(entry.evidence || '') || VERIFY.test(entry.name)))
      if (!proved) {
        return {
          block:
            'Refused by plugin delivery-policy: files changed but no verification command appears in the trace. ' +
            'Run the narrowest proof (a type check, one test file, a build) and quote its output in the evidence of the intent it covers.',
        }
      }

      return {
        note: 'This workspace requires a runnable proof for every change: a test, type check, or build whose output is quoted in the evidence.',
      }
    },

    /** A line in the review trail, so a policy refusal is not a mystery later. */
    onTaskEnd({ taskId, status, completion }) {
      api.log(`task ${taskId} ended ${status} at ${completion}%`)
    },
  }
}
