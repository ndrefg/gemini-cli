/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Config } from '../config/config.js';
import {
  setSimulate429,
  disableSimulationAfterFallback,
  shouldSimulate429,
  createSimulated429Error,
  resetRequestCounter,
} from './testUtils.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import { retryWithBackoff } from './retry.js';
import { AuthType } from '../core/contentGenerator.js';

describe('Flash Fallback Integration', () => {
  let config: Config;

  beforeEach(() => {
    config = new Config({
      sessionId: 'test-session',
      targetDir: '/test',
      debugMode: false,
      cwd: '/test',
      model: 'gemini-2.5-pro',
    });

    // Reset simulation state for each test
    setSimulate429(false);
    resetRequestCounter();
    // Mock global config and its methods
    const mockGetFlashFallbackHandler = vi.fn();
    const mockGlobalConfig = {
      getFlashFallbackHandler: mockGetFlashFallbackHandler,
      // Add other methods from Config that might be accessed if necessary
      // For this test, only getFlashFallbackHandler is crucial for retry logic
    };
    (globalThis as any).config = mockGlobalConfig;
    mockGetFlashFallbackHandler.mockClear();
  });

  afterEach(() => {
    // Clean up the global mock
    delete (globalThis as any).config;
  });

  it('should trigger flashFallbackHandler after 2 consecutive 429 errors for OAuth users and succeed if handler returns true', async () => {
    const flashFallbackHandler = vi.fn().mockResolvedValue(true); // Simulate user accepts fallback
    (globalThis as any).config.getFlashFallbackHandler.mockReturnValue(
      flashFallbackHandler,
    );

    let handlerCalledAndModelSwitched = false;

    const mockApiCall = vi.fn().mockImplementation(async () => {
      if (handlerCalledAndModelSwitched) {
        return 'success after fallback';
      }
      throw createSimulated429Error();
    });

    flashFallbackHandler.mockImplementation(async () => {
      handlerCalledAndModelSwitched = true; // Simulate model switch
      return true;
    });

    const result = await retryWithBackoff(mockApiCall, {
      maxAttempts: 3, // Attempt 1 (429), Attempt 2 (429, fallback), Attempt 3 (success)
      initialDelayMs: 1,
      maxDelayMs: 10,
      shouldRetry: (error: Error) => {
        const status = (error as Error & { status?: number }).status;
        return status === 429;
      },
      authType: AuthType.LOGIN_WITH_GOOGLE,
    });

    expect(flashFallbackHandler).toHaveBeenCalledWith(
      AuthType.LOGIN_WITH_GOOGLE,
    );
    expect(result).toBe('success after fallback');
    expect(mockApiCall).toHaveBeenCalledTimes(3);
  });

  it('should not trigger flashFallbackHandler for API key users', async () => {
    const flashFallbackHandler = vi.fn();
    (globalThis as any).config.getFlashFallbackHandler.mockReturnValue(
      flashFallbackHandler,
    );

    const mockApiCall = vi.fn().mockRejectedValue(createSimulated429Error());

    try {
      await retryWithBackoff(mockApiCall, {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        shouldRetry: (error: Error) => {
          const status = (error as Error & { status?: number }).status;
          return status === 429;
        },
        authType: AuthType.USE_GEMINI, // API key auth type
      });
    } catch (error) {
      expect((error as Error).message).toContain('Rate limit exceeded');
    }

    expect(flashFallbackHandler).not.toHaveBeenCalled();
    expect(mockApiCall).toHaveBeenCalledTimes(3); // Retried up to maxAttempts
  });

  it('should continue with original error if flashFallbackHandler returns false', async () => {
    const flashFallbackHandler = vi.fn().mockResolvedValue(false); // Simulate user rejects fallback
    (globalThis as any).config.getFlashFallbackHandler.mockReturnValue(
      flashFallbackHandler,
    );

    const mockApiCall = vi.fn().mockRejectedValue(createSimulated429Error());

    try {
      await retryWithBackoff(mockApiCall, {
        maxAttempts: 3,
        initialDelayMs: 1,
        authType: AuthType.LOGIN_WITH_GOOGLE,
      });
    } catch (error) {
      expect((error as Error).message).toContain('Rate limit exceeded');
    }

    expect(flashFallbackHandler).toHaveBeenCalledWith(
      AuthType.LOGIN_WITH_GOOGLE,
    );
    // Called 3 times: 2 to trigger fallback, 1 more because fallback returned false.
    expect(mockApiCall).toHaveBeenCalledTimes(3);
  });

  it('should properly disable simulation state after fallback', () => {
    // Enable simulation
    setSimulate429(true);

    // Verify simulation is enabled
    expect(shouldSimulate429()).toBe(true);

    // Disable simulation after fallback
    disableSimulationAfterFallback();

    // Verify simulation is now disabled
    expect(shouldSimulate429()).toBe(false);
  });
});
