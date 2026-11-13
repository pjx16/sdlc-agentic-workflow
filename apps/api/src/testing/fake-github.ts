import type { CheckBucket, GitHubClient, OpenedPr, PrCheck, PrState } from '../worker/github/github-client';

/** A GitHub client that records every call and answers from a script. For tests. */
export class FakeGitHub implements GitHubClient {
  calls: string[] = [];
  opened: { repo: string; base: string; head: string; title: string; body: string }[] = [];
  edits: { number: number; body: string }[] = [];
  comments: { number: number; body: string }[] = [];
  nextNumber = 100;
  failOpenWith: Error | null = null;
  failComment: Error | null = null;
  checksResult: PrCheck[] = [];
  state: PrState = { state: 'OPEN', mergedAt: null };
  failLog = '';
  ready: number[] = [];

  async openDraftPr(a: { repo: string; base: string; head: string; title: string; body: string }): Promise<OpenedPr> {
    this.calls.push('openDraftPr');
    if (this.failOpenWith) throw this.failOpenWith;
    this.opened.push(a);
    const number = this.nextNumber++;
    return { number, url: `https://github.com/${a.repo}/pull/${number}` };
  }
  async markReady(_repo: string, number: number) {
    this.calls.push('markReady');
    this.ready.push(number);
  }
  async comment(_repo: string, number: number, body: string) {
    this.calls.push('comment');
    if (this.failComment) throw this.failComment;
    this.comments.push({ number, body });
  }
  async checks(): Promise<PrCheck[]> {
    this.calls.push('checks');
    return this.checksResult;
  }
  async failingLogTail() {
    this.calls.push('failingLogTail');
    return this.failLog;
  }
  async prState(): Promise<PrState> {
    this.calls.push('prState');
    return this.state;
  }
  async editBody(_repo: string, number: number, body: string) {
    this.calls.push('editBody');
    this.edits.push({ number, body });
  }
  reset() {
    this.calls = [];
    this.opened = [];
    this.edits = [];
    this.comments = [];
    this.nextNumber = 100;
    this.failOpenWith = null;
    this.checksResult = [];
    this.state = { state: 'OPEN', mergedAt: null };
    this.failLog = '';
    this.ready = [];
  }
  setChecks(...buckets: CheckBucket[]) {
    this.checksResult = buckets.map((bucket, i) => ({ name: `check-${i + 1}`, bucket }));
  }
}
