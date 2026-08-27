/**
 * Evidence construction — the honest record of what the engine tried.
 *
 * `evidence` is mandatory on every exception and is the heart of the honest
 * exception list: it answers "why wasn't this matched?" at RULE level, with no
 * LLM involved. The explain layer narrates this object; it never generates it,
 * and the drill-down renders identically when the explain layer is disabled.
 */

import type { ExceptionEvidence } from '../../types/engine.js';

/**
 * A complete, empty evidence object.
 *
 * Every optional field is set explicitly to `null` rather than left undefined, so
 * "the engine did not record this" and "the engine recorded nothing here" are the
 * same visible state. An absent key in a JSONB column reads as a gap in the
 * record; an explicit null reads as an answer.
 */
export function emptyEvidence(): ExceptionEvidence {
  return {
    candidatesConsidered: 0,
    candidates: [],
    anchorStrength: 'none',
    aliasesAttempted: [],
    windowUsed: { amountBandPaise: 0, dateWindow: [0, 0] },
    candidateCapHit: false,
    severityBasis: { base: 'low', amountAtRiskPaise: null, escalated: false },
    wouldMatchIfWindowWidened: null,
    searchExhausted: null,
    searchBoundExceeded: null,
    candidateSubsets: null,
    displacedByMatchId: null,
    counterpartStatus: null,
  };
}
