export type ReviewNext = 'fix' | 'done';

/**
 * The review exit rule (F10): with open critical or high findings and fewer than `maxReviewRounds` rounds run, a `fix` stage runs on
 * those findings and the next round starts; otherwise the loop ends and the remaining findings stay listed. Ending with findings
 * left is not a failure.
 */
export function nextAfterReview(args: { roundsRun: number; maxReviewRounds: number; openBlocking: number }): ReviewNext {
  return args.openBlocking > 0 && args.roundsRun < args.maxReviewRounds ? 'fix' : 'done';
}
