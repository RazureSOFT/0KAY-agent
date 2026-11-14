import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeObjection, parsePlanReview, planScore, planVerdict, reviewPlan } from './plan_review.js';

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    feasibility: 90,
    confidence: 80,
    completeness: 70,
    strengths: ['the approach reuses the existing router'],
    objections: [],
    revise: '',
    ...over,
  });

test('planScore is the weakest dimension, not the average', () => {
  // 90/80/20 is not "about 63% good", it is a plan that misses most of the
  // request. The threshold has to be met by the worst score.
  assert.equal(planScore(90, 80, 20), 20);
  assert.equal(planScore(100, 100, 100), 100);
  assert.equal(planScore(50, 90, 90), 50);
});

test('a well-formed reply is read into the three scores', () => {
  const review = parsePlanReview(reply(), 5);
  assert.equal(review?.feasibility, 90);
  assert.equal(review?.confidence, 80);
  assert.equal(review?.completeness, 70);
  assert.equal(review?.score, 70);
  assert.deepEqual(review?.strengths, ['the approach reuses the existing router']);
});

test('a fenced JSON reply is read too', () => {
  const review = parsePlanReview('Here is my verdict:\n```json\n' + reply() + '\n```\n', 1);
  assert.equal(review?.score, 70);
});

test('scores are clamped to 0-100', () => {
  const review = parsePlanReview(reply({ feasibility: 250, confidence: -40 }), 1);
  assert.equal(review?.feasibility, 100);
  assert.equal(review?.confidence, 0);
});

test('a non-numeric score falls back to zero rather than NaN', () => {
  const review = parsePlanReview(reply({ completeness: 'mostly' }), 1);
  assert.equal(review?.completeness, 0);
  assert.equal(Number.isNaN(review?.score), false);
});

test('an objection without a location cannot be applied, so it is dropped', () => {
  assert.equal(normalizeObjection({ problem: 'this is vague', severity: 'concern' }), null);
});

test('an objection without a problem says nothing, so it is dropped', () => {
  assert.equal(normalizeObjection({ where: 'step 2', suggestion: 'change it' }), null);
});

test('a well-formed objection is kept with its severity', () => {
  const objection = normalizeObjection({
    where: 'step 2',
    problem: 'assumes the API supports batching',
    suggestion: 'check the docs first',
    severity: 'blocker',
  });
  assert.deepEqual(objection, {
    where: 'step 2',
    problem: 'assumes the API supports batching',
    suggestion: 'check the docs first',
    severity: 'blocker',
  });
});

test('an unknown severity is a concern, never a silent blocker', () => {
  assert.equal(normalizeObjection({ where: 'x', problem: 'y', severity: 'catastrophic' })?.severity, 'concern');
});

test('prose with no JSON is not a verdict', () => {
  assert.equal(parsePlanReview('I think this plan is probably fine.', 1), null);
});

test('a plan above the threshold with no blockers passes', () => {
  const review = parsePlanReview(reply({ feasibility: 90, confidence: 85, completeness: 80 }), 1)!;
  assert.equal(planVerdict(review, 75), 'pass');
});

test('a plan below the threshold is sent back', () => {
  const review = parsePlanReview(reply({ completeness: 40 }), 1)!;
  assert.equal(planVerdict(review, 75), 'revise');
});

test('a blocker sends the plan back even when it scored above the threshold', () => {
  // A reviewer that rates 90/90/90 and also lists a blocker is contradicting
  // itself; the blocker is the honest half.
  const review = parsePlanReview(reply({
    feasibility: 90, confidence: 90, completeness: 90,
    objections: [{ where: 'step 3', problem: 'deletes the table before reading it', severity: 'blocker' }],
  }), 1)!;
  assert.equal(review.score, 90);
  assert.equal(planVerdict(review, 75), 'revise');
});

test('a concern alone does not block a passing plan', () => {
  const review = parsePlanReview(reply({
    feasibility: 90, confidence: 90, completeness: 90,
    objections: [{ where: 'step 4', problem: 'could be faster', severity: 'concern' }],
  }), 1)!;
  assert.equal(planVerdict(review, 75), 'pass');
});

test('the threshold is inclusive — reaching it is enough', () => {
  const review = parsePlanReview(reply({ feasibility: 75, confidence: 75, completeness: 75 }), 1)!;
  assert.equal(review.score, 75);
  assert.equal(planVerdict(review, 75), 'pass');
});

test('an empty plan is rejected without calling the model', async () => {
  let called = false;
  const review = await reviewPlan({ userIntent: 'do a thing', plan: '   ' }, async () => { called = true; return 'x'; });
  assert.equal(called, false);
  assert.equal(review.score, 0);
  assert.equal(review.objections[0].severity, 'blocker');
  assert.match(review.objections[0].problem, /empty/);
});

test('a reviewer that cannot run degrades to a pass, not a blocked build', async () => {
  const review = await reviewPlan({ userIntent: 'x', plan: '# Plan\n\n1. Do it' }, async () => { throw new Error('model down'); });
  assert.equal(review.score, 100);
  assert.match(String(review.degraded), /model down/);
  // A degraded review must never hold up a build.
  assert.equal(planVerdict(review, 95), 'pass');
});

test('a reviewer that returns nothing usable degrades rather than rejecting', async () => {
  const review = await reviewPlan({ userIntent: 'x', plan: '# Plan\n\n1. Do it' }, async () => 'no idea, sorry');
  assert.ok(review.degraded);
  assert.equal(planVerdict(review, 90), 'pass');
});

test('a real reply is passed through with its objections intact', async () => {
  const review = await reviewPlan({ userIntent: 'add a route', plan: '# Plan\n\n1. Add it' }, async () =>
    reply({ completeness: 60, objections: [{ where: 'whole plan', problem: 'no test step', suggestion: 'add one', severity: 'blocker' }] }));
  assert.equal(review.completeness, 60);
  assert.equal(review.objections.length, 1);
  assert.equal(planVerdict(review, 50), 'revise');
});
