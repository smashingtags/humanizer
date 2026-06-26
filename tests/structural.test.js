import { describe, it, expect } from 'vitest';
import { analyzeStructural, stripForStructural } from '../src/structural.js';
import { analyze } from '../src/analyzer.js';

// A long, clean human baseline so ratio signals have a real sample size.
const CLEAN = `I rebuilt the deploy script this afternoon. The old one pushed straight to prod with no checks, which is how the homepage got wiped last month. Now it walks dev, then staging, then prod, and each step has to be green before the next runs.

The annoying part was the registry. My infra doc said one org and the running container pulled from another, so every push landed in a namespace nothing watched. I found it by diffing the asset hash the container served against the hash my build produced. They did not match, so I knew the deploy never took.

Once that was fixed the rest was mechanical. I added a confirmation prompt before prod, wired up a Discord notification, and wrote down the rollback command so future me does not have to remember it at 2am.`;

describe('stripForStructural — markdown reduction', () => {
  it('strips YAML frontmatter before analysis', () => {
    const input = ['---', 'title: Test document', 'tags:', '  - demo', '---', '', 'This is the actual body.'].join('\n');
    const out = stripForStructural(input);
    expect(out).toContain('This is the actual body.');
    expect(out).not.toMatch(/title:\s*Test document/);
  });

  it('removes fenced code blocks, including antithesis-shaped lines inside them', () => {
    const input = ['Intro before code.', '', '```js', 'note: this is not a tool, it is a way of life', '```', '', 'Outro after code.'].join('\n');
    const out = stripForStructural(input);
    expect(out).toContain('Intro before code.');
    expect(out).toContain('Outro after code.');
    expect(out).not.toMatch(/way of life/);
    expect(out).not.toContain('```');
  });

  it('removes inline code spans', () => {
    const out = stripForStructural('This has `inline code` that must not influence signals.');
    expect(out).toContain('This has');
    expect(out).toContain('that must not influence signals.');
    expect(out).not.toMatch(/inline code/);
    expect(out).not.toContain('`');
  });

  it('drops links whole — markup, URL, and bare-URL text — to protect calibration', () => {
    // The reference scorer the corpus is calibrated against removed the entire
    // link; keeping link text injects tokens like "mjashley.com" that distort
    // the cadence signals and tip already-clean posts over the gate.
    const out = stripForStructural('See the [docs](https://example.com/docs) and [mjashley.com](https://mjashley.com) now.');
    expect(out).not.toContain('https://example.com/docs');
    expect(out).not.toContain('mjashley.com');
    expect(out).not.toContain('](');
    expect(out).toContain('See the');
    expect(out).toContain('now.');
  });

  it('removes heading and quote markers but keeps their text', () => {
    const out = stripForStructural(['# Heading one', '> Quoted line', 'Normal line.'].join('\n'));
    expect(out).toContain('Heading one');
    expect(out).toContain('Quoted line');
    expect(out).toContain('Normal line.');
    expect(out).not.toContain('# Heading one');
    expect(out).not.toContain('> Quoted line');
  });

  it('unwraps inline emphasis without eating the words', () => {
    const out = stripForStructural('This is *very* and **really** important.');
    expect(out).toContain('very');
    expect(out).toContain('really');
    expect(out).not.toContain('*');
  });

  it('leaves bare #, > and * inside prose alone (regression: old /[#>*]/g mangled them)', () => {
    const out = stripForStructural('C# perf beat a > b and 3 * 4 in the bench.');
    expect(out).toContain('C#');
    expect(out).toContain('a > b');
    expect(out).toContain('3 * 4');
  });
});

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

  // The reviewer asked us to prove the OTHER direction too: that the
  // structural max() floor never drags a high legacy/density score DOWN, and
  // that when structural slop is low the legacy blend still drives the result.
  // (The reviewer's suggested >40 thresholds assume a different scale — our
  // uniformity term is heavily damped, so density-only text rarely clears 40.
  // We instead pin the relationship that actually matters: legacy dominates.)
  it('lets the legacy density blend dominate when structural slop is low', () => {
    // Chatbot artifacts + cutoff disclaimers: high legacy density, almost no
    // structural tells (no antithesis, no kicker pile-up, no blacklist vocab).
    const dense = `I hope this helps! Let me know if you have any other questions. Certainly!

As an AI language model, I cannot browse the web. As of my last training update in 2023, I do not have access to current events. I apologize for any confusion this may cause.

Feel free to reach out if you need anything else. I am happy to help with your request today.`;
    const r = analyze(dense);
    expect(r.structuralScore).toBeLessThan(25); // structural is the minority input
    expect(r.patternScore).toBeGreaterThan(r.structuralScore); // legacy density is bigger
    expect(r.score).toBeGreaterThan(r.structuralScore + 15); // floor did not cap it down
  });

  it('keeps density dominant even when structural slop is modestly present', () => {
    // Promotional slop: strong legacy density AND some structural/blacklist
    // tells. The composite must still track the (larger) legacy blend.
    const promo = 'This stunning, breathtaking framework is a rich tapestry that stands as a testament to modern engineering. It plays a vital role in the ever-evolving landscape of software. Industry experts agree it is widely regarded as a game-changer. Many critics have praised its enduring legacy and profound significance across the broader community.';
    const r = analyze(promo);
    expect(r.structuralScore).toBeGreaterThan(15); // structural is non-trivial here
    expect(r.patternScore).toBeGreaterThan(r.structuralScore); // but legacy is larger
    expect(r.score).toBeGreaterThan(r.structuralScore + 15); // and the score follows legacy
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
