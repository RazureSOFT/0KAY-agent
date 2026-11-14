import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_CONSTRAINTS_KEY, PLAN_THRESHOLD_KEY, PLAN_USER_INTENT_KEY, planReviewOptions, reviewOptions } from './plan_review_options.js';

test('a configured threshold and intent are read back', () => {
  const options = planReviewOptions(75, 'add a route', 'no new dependencies');
  const read = reviewOptions(options);
  assert.equal(read.threshold, 75);
  assert.equal(read.userIntent, 'add a route');
  assert.equal(read.constraints, 'no new dependencies');
});

test('constraints are omitted from the options when there are none', () => {
  const options = planReviewOptions(50, 'x');
  assert.equal(PLAN_CONSTRAINTS_KEY in options, false);
  assert.equal(reviewOptions(options).constraints, undefined);
});

test('no options at all means no review', () => {
  // 0 disables the check, so a tool driven directly (in a test, or by another
  // caller) does not silently spend a model call.
  assert.equal(reviewOptions(undefined).threshold, 0);
  assert.equal(reviewOptions({}).threshold, 0);
});

test('a threshold outside 0-100 is clamped, not honoured', () => {
  assert.equal(reviewOptions({ [PLAN_THRESHOLD_KEY]: '500' }).threshold, 100);
  assert.equal(reviewOptions({ [PLAN_THRESHOLD_KEY]: '-20' }).threshold, 0);
});

test('a non-numeric threshold is treated as no review, not as NaN', () => {
  const read = reviewOptions({ [PLAN_THRESHOLD_KEY]: 'high' });
  assert.equal(read.threshold, 0);
  assert.equal(Number.isNaN(read.threshold), false);
});

test('the option keys are the documented ones', () => {
  // A renamed key would fail open (no review), so the names are pinned here.
  assert.equal(PLAN_THRESHOLD_KEY, 'plan_threshold');
  assert.equal(PLAN_USER_INTENT_KEY, 'user_intent');
  assert.equal(PLAN_CONSTRAINTS_KEY, 'plan_constraints');
});

test('a missing intent reads as an empty string, not "undefined"', () => {
  assert.equal(reviewOptions({ [PLAN_THRESHOLD_KEY]: '50' }).userIntent, '');
});
