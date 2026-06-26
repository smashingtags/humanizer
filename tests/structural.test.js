import { describe, it, expect } from 'vitest';
import { analyzeStructural } from '../src/structural.js';
import { analyze } from '../src/analyzer.js';

// A long, clean human baseline so ratio signals have a real sample size.
const CLEAN = `I rebuilt the deploy script this afternoon. The old one pushed straight to prod with no checks, which is how the homepage got wiped last month. Now it walks dev, then staging, then prod, and each step has to be green before the next runs.

The annoying part was the registry. My infra doc said one org and the running container pulled from another, so every push landed in a namespace nothing watched. I found it by diffing the asset hash the container served against the hash my build produced. They did not match, so I knew the deploy never took.

Once that was fixed the rest was mechanical. I added a confirmation prompt before prod, wired up a Discord notification, and wrote down the rollback command so future me does not have to remember it at 2am.`;

describe('analyzeStructural — detectors', () => {
  it('flags the antithesis cliché', () => {
    const r = analyzeStructural("This is the point: it's not just a tool, it's a way of life. Onward.");
    expect(r.sig.antithesis).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.patternId === 100)).toBe(true);
  });

  it('flags aphoristic kickers in a multi-paragraph post', () => {
    const text = Array.from({ length: 8 }, (_, i) =>
      `Paragraph ${i} runs on for a little while with some real detail about the work and then it stops. It was done.`,
    ).join('\n\n');
    const r = analyzeStructural(text);
    expect(r.sig.kicker).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.patternId === 101)).toBe(true);
  });

  it('flags trailing -ing clauses', () => {
    const r = analyzeStructural('The migration completed cleanly, underscoring the value of the new pipeline.');
    expect(r.sig.ingTails).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.patternId === 102)).toBe(true);
  });

  it('flags copula inflation', () => {
    const r = analyzeStructural('The cache serves as a bridge between the two services and boasts low latency.');
    expect(r.sig.copula).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.patternId === 103)).toBe(true);
  });

  it('flags blacklist vocabulary', () => {
    const r = analyzeStructural('We leverage a robust, seamless, comprehensive tapestry of cutting-edge tooling.');
    expect(r.sig.blacklist).toBeGreaterThanOrEqual(4);
    expect(r.findings.some((f) => f.patternId === 106)).toBe(true);
  });

  it('flags transition-word openers', () => {
    const r = analyzeStructural('We shipped it.\n\nMoreover, the rollout was clean.\n\nFurthermore, nobody noticed.');
    expect(r.sig.transitions).toBeGreaterThanOrEqual(2);
    expect(r.findings.some((f) => f.patternId === 107)).toBe(true);
  });

  it('does not over-flag terse human writing (sample-size guard)', () => {
    const terse = `The bug was in the pool. It dropped requests at 256 connections. No error, no log.

Found it with a counter. Took three hours. Fixed it with a semaphore.`;
    const r = analyzeStructural(terse);
    expect(r.slop).toBeLessThan(25);
  });

  it('scores genuinely clean human prose low', () => {
    expect(analyzeStructural(CLEAN).slop).toBeLessThan(20);
  });
});

describe('analyzer integration — structural slop sets a floor', () => {
  it('a kicker/antithesis-heavy post no longer scores a false single digit', () => {
    // Density is low (few words per tell) but the structural tells are damning.
    const slop = `This was not a refactor. It was a reckoning.

The code looked fine. It was not fine.

Every shortcut had a price. We paid it.`;
    const r = analyze(slop);
    expect(r.structuralScore).toBeGreaterThan(15);
    expect(r.score).toBeGreaterThanOrEqual(r.structuralScore);
  });

  it('exposes the structural breakdown on the result', () => {
    const r = analyze(CLEAN);
    expect(r).toHaveProperty('structuralScore');
    expect(r.structural).toHaveProperty('sig');
    expect(r.structural.sig).toHaveProperty('antithesis');
  });

  it('clean prose stays low end-to-end', () => {
    expect(analyze(CLEAN).score).toBeLessThan(25);
  });
});
