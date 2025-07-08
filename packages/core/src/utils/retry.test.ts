/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryWithBackoff } from './retry.js';
import { setSimulate429 } from './testUtils.js';

// Define an interface for the error with a status property
interface HttpError extends Error {
  status?: number;
}

// Helper to create a mock function that fails a certain number of times
const createFailingFunction = (
  failures: number,
  successValue: string = 'success',
) => {
  let attempts = 0;
  return vi.fn(async () => {
    attempts++;
    if (attempts <= failures) {
      // Simulate a retryable error
      const error: HttpError = new Error(`Simulated error attempt ${attempts}`);
      error.status = 500; // Simulate a server error
      throw error;
    }
    return successValue;
  });
};

// Custom error for testing non-retryable conditions
class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Disable 429 simulation for tests
    setSimulate429(false);
    // Suppress unhandled promise rejection warnings for tests that expect errors
    console.warn = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should return the result on the first attempt if successful', async () => {
    const mockFn = createFailingFunction(0);
    const result = await retryWithBackoff(mockFn);
    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed if failures are within maxAttempts', async () => {
    const mockFn = createFailingFunction(2);
    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 3,
      initialDelayMs: 10,
    });

    await vi.runAllTimersAsync(); // Ensure all delays and retries complete

    const result = await promise;
    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should throw an error if all attempts fail', async () => {
    const mockFn = createFailingFunction(3);

    // 1. Start the retryable operation, which returns a promise.
    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 3,
      initialDelayMs: 10,
    });

    // 2. IMPORTANT: Attach the rejection expectation to the promise *immediately*.
    //    This ensures a 'catch' handler is present before the promise can reject.
    //    The result is a new promise that resolves when the assertion is met.
    const assertionPromise = expect(promise).rejects.toThrow(
      'Simulated error attempt 3',
    );

    // 3. Now, advance the timers. This will trigger the retries and the
    //    eventual rejection. The handler attached in step 2 will catch it.
    await vi.runAllTimersAsync();

    // 4. Await the assertion promise itself to ensure the test was successful.
    await assertionPromise;

    // 5. Finally, assert the number of calls.
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should not retry if shouldRetry returns false', async () => {
    const mockFn = vi.fn(async () => {
      throw new NonRetryableError('Non-retryable error');
    });
    const shouldRetry = (error: Error) => !(error instanceof NonRetryableError);

    const promise = retryWithBackoff(mockFn, {
      shouldRetry,
      initialDelayMs: 10,
    });

    await expect(promise).rejects.toThrow('Non-retryable error');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should use default shouldRetry if not provided, retrying on 429', async () => {
    const mockFn = vi.fn(async () => {
      const error = new Error('Too Many Requests') as any;
      error.status = 429;
      throw error;
    });

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 2,
      initialDelayMs: 10,
    });

    // Attach the rejection expectation *before* running timers
    const assertionPromise =
      expect(promise).rejects.toThrow('Too Many Requests');

    // Run timers to trigger retries and eventual rejection
    await vi.runAllTimersAsync();

    // Await the assertion
    await assertionPromise;

    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should use default shouldRetry if not provided, not retrying on 400', async () => {
    const mockFn = vi.fn(async () => {
      const error = new Error('Bad Request') as any;
      error.status = 400;
      throw error;
    });

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 2,
      initialDelayMs: 10,
    });
    await expect(promise).rejects.toThrow('Bad Request');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should respect maxDelayMs', async () => {
    const mockFn = createFailingFunction(3);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const promise = retryWithBackoff(mockFn, {
      maxAttempts: 4,
      initialDelayMs: 100,
      maxDelayMs: 250, // Max delay is less than 100 * 2 * 2 = 400
    });

    await vi.advanceTimersByTimeAsync(1000); // Advance well past all delays
    await promise;

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);

    // Delays should be around initial, initial*2, maxDelay (due to cap)
    // Jitter makes exact assertion hard, so we check ranges / caps
    expect(delays.length).toBe(3);
    expect(delays[0]).toBeGreaterThanOrEqual(100 * 0.7);
    expect(delays[0]).toBeLessThanOrEqual(100 * 1.3);
    expect(delays[1]).toBeGreaterThanOrEqual(200 * 0.7);
    expect(delays[1]).toBeLessThanOrEqual(200 * 1.3);
    // The third delay should be capped by maxDelayMs (250ms), accounting for jitter
    expect(delays[2]).toBeGreaterThanOrEqual(250 * 0.7);
    expect(delays[2]).toBeLessThanOrEqual(250 * 1.3);
  });

  it('should handle jitter correctly, ensuring varied delays', async () => {
    let mockFn = createFailingFunction(5);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    // Run retryWithBackoff multiple times to observe jitter
    const runRetry = () =>
      retryWithBackoff(mockFn, {
        maxAttempts: 2, // Only one retry, so one delay
        initialDelayMs: 100,
        maxDelayMs: 1000,
      });

    // We expect rejections as mockFn fails 5 times
    const promise1 = runRetry();
    // Attach the rejection expectation *before* running timers
    const assertionPromise1 = expect(promise1).rejects.toThrow();
    await vi.runAllTimersAsync(); // Advance for the delay in the first runRetry
    await assertionPromise1;

    const firstDelaySet = setTimeoutSpy.mock.calls.map(
      (call) => call[1] as number,
    );
    setTimeoutSpy.mockClear(); // Clear calls for the next run

    // Reset mockFn to reset its internal attempt counter for the next run
    mockFn = createFailingFunction(5); // Re-initialize with 5 failures

    const promise2 = runRetry();
    // Attach the rejection expectation *before* running timers
    const assertionPromise2 = expect(promise2).rejects.toThrow();
    await vi.runAllTimersAsync(); // Advance for the delay in the second runRetry
    await assertionPromise2;

    const secondDelaySet = setTimeoutSpy.mock.calls.map(
      (call) => call[1] as number,
    );

    // Check that the delays are not exactly the same due to jitter
    // This is a probabilistic test, but with +/-30% jitter, it's highly likely they differ.
    if (firstDelaySet.length > 0 && secondDelaySet.length > 0) {
      // Check the first delay of each set
      expect(firstDelaySet[0]).not.toBe(secondDelaySet[0]);
    } else {
      // If somehow no delays were captured (e.g. test setup issue), fail explicitly
      throw new Error('Delays were not captured for jitter test');
    }

    // Ensure delays are within the expected jitter range [70, 130] for initialDelayMs = 100
    [...firstDelaySet, ...secondDelaySet].forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(100 * 0.7);
      expect(d).toBeLessThanOrEqual(100 * 1.3);
    });
  });

  describe('Flash model fallback for OAuth users', () => {
    // Mock global config and its methods
    const mockGetFlashFallbackHandler = vi.fn();
    const mockGlobalConfig = {
      getFlashFallbackHandler: mockGetFlashFallbackHandler,
    };

    beforeEach(() => {
      // Assign the mock to the global object before each test
      (globalThis as any).config = mockGlobalConfig;
      mockGetFlashFallbackHandler.mockClear(); // Clear mock history
    });

    afterEach(() => {
      // Clean up the global mock after each test
      delete (globalThis as any).config;
    });

    it('should trigger fallback handler for OAuth personal users after persistent 429 errors', async () => {
      const flashFallbackHandler = vi.fn().mockResolvedValue(true); // Simulate user accepts fallback
      mockGetFlashFallbackHandler.mockReturnValue(flashFallbackHandler);

      let fallbackOccurred = false;
      const mockFn = vi.fn().mockImplementation(async () => {
        // This condition simulates the model being updated by the handler
        if (flashFallbackHandler.mock.calls.length > 0 && fallbackOccurred) {
          return 'success';
        }
        const error: HttpError = new Error('Rate limit exceeded');
        error.status = 429;
        throw error;
      });

      const promise = retryWithBackoff(mockFn, {
        maxAttempts: 3, // Allows for 2 429s then a successful attempt
        initialDelayMs: 100,
        authType: 'oauth-personal',
      });

      // Monitor when the fallback handler is expected to be called
      flashFallbackHandler.mockImplementation(async () => {
        fallbackOccurred = true;
        return true; // User accepts fallback
      });

      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('success');
      expect(flashFallbackHandler).toHaveBeenCalledWith('oauth-personal');
      // mockFn is called twice before fallback, then once after.
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it('should NOT trigger fallback handler for API key users', async () => {
      const flashFallbackHandler = vi.fn();
      mockGetFlashFallbackHandler.mockReturnValue(flashFallbackHandler);

      const mockFn = vi.fn(async () => {
        const error: HttpError = new Error('Rate limit exceeded');
        error.status = 429;
        throw error;
      });

      const promise = retryWithBackoff(mockFn, {
        maxAttempts: 3,
        initialDelayMs: 100,
        authType: 'gemini-api-key', // Non-OAuth type
      });

      const resultPromise = promise.catch((error) => error);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Rate limit exceeded');
      expect(flashFallbackHandler).not.toHaveBeenCalled();
    });

    it('should continue with original error if fallback handler returns false (user rejects)', async () => {
      const flashFallbackHandler = vi.fn().mockResolvedValue(false); // Simulate user rejects fallback
      mockGetFlashFallbackHandler.mockReturnValue(flashFallbackHandler);

      const mockFn = vi.fn(async () => {
        const error: HttpError = new Error('Rate limit exceeded');
        error.status = 429;
        throw error;
      });

      const promise = retryWithBackoff(mockFn, {
        maxAttempts: 3, // Enough attempts to trigger fallback logic
        initialDelayMs: 100,
        authType: 'oauth-personal',
      });

      const resultPromise = promise.catch((error) => error);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Rate limit exceeded');
      expect(flashFallbackHandler).toHaveBeenCalledWith('oauth-personal');
      // mockFn is called 3 times because fallback was rejected, and retries continued up to maxAttempts.
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it('should handle mixed error types (only count consecutive 429s for fallback)', async () => {
      const flashFallbackHandler = vi.fn().mockResolvedValue(true); // Simulate user accepts fallback
      mockGetFlashFallbackHandler.mockReturnValue(flashFallbackHandler);

      let attempts = 0;
      let fallbackLogicTriggered = false;

      const mockFn = vi.fn().mockImplementation(async () => {
        attempts++;
        // Simulate success only after fallback logic has been triggered
        if (fallbackLogicTriggered) {
          return 'success';
        }
        if (attempts === 1) {
          const error: HttpError = new Error('Server error');
          error.status = 500; // Non-429 error
          throw error;
        } else {
          // Subsequent attempts are 429
          const error: HttpError = new Error('Rate limit exceeded');
          error.status = 429;
          throw error;
        }
      });

      // Monitor when the fallback handler is called
      flashFallbackHandler.mockImplementation(async () => {
        fallbackLogicTriggered = true;
        return true; // User accepts fallback
      });

      const promise = retryWithBackoff(mockFn, {
        maxAttempts: 5, // Ample attempts
        initialDelayMs: 100,
        authType: 'oauth-personal',
      });

      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('success');

      // Fallback should be called after the first 500 error and two subsequent 429 errors
      expect(flashFallbackHandler).toHaveBeenCalledWith('oauth-personal');
      // Total calls: 1 (500) + 2 (429s for fallback) + 1 (success after fallback) = 4
      expect(mockFn).toHaveBeenCalledTimes(4);
    });
  });
});
