import { describe, expect, it } from 'vitest';
import { logLine } from './log-context';

describe('logLine', () => {
  it('puts every known part in one bracket, in a fixed order', () => {
    expect(logLine({ ticket: 'SDA-12', stage: 'implement', run: '3fa9c2d1-aaaa-bbbb', subtask: 2 }, 'Coder finished')).toBe('[ticket=SDA-12 stage=implement run=3fa9c2d1 subtask=2] Coder finished');
  });
  it('leaves out what is not known', () => {
    expect(logLine({ stage: 'plan' }, 'started')).toBe('[stage=plan] started');
    expect(logLine({}, 'Worker started')).toBe('Worker started');
    expect(logLine({ subtask: 0 }, 'x')).toBe('[subtask=0] x');
  });
});
