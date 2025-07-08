/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
} from '../config/models.js';
import * as readline from 'readline';

/**
 * Checks if the default "pro" model is rate-limited and returns a fallback "flash"
 * model if necessary. This function is designed to be silent.
 * @param apiKey The API key to use for the check.
 * @param currentConfiguredModel The model currently configured in settings.
 * @returns An object indicating the model to use, whether a switch occurred,
 *          and the original model if a switch happened.
 */
export async function getEffectiveModel(
  apiKey: string,
  currentConfiguredModel: string,
): Promise<string> {
  if (currentConfiguredModel !== DEFAULT_GEMINI_MODEL) {
    // Only check if the user is trying to use the specific pro model we want to fallback from.
    return currentConfiguredModel;
  }

  const modelToTest = DEFAULT_GEMINI_MODEL;
  const fallbackModel = DEFAULT_GEMINI_FLASH_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelToTest}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: 'test' }] }],
    generationConfig: {
      maxOutputTokens: 1,
      temperature: 0,
      topK: 1,
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    },
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000); // 2000ms timeout for the request

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      return new Promise((resolve) => {
        rl.question(
          `[INFO] Your configured model (${modelToTest}) is responding slowly. Would you like to switch to ${fallbackModel} for this session? (y/N) `,
          (answer) => {
            rl.close();
            if (answer.toLowerCase() === 'y') {
              console.log(
                `[INFO] Switched to ${fallbackModel} for this session.`,
              );
              resolve(fallbackModel);
            } else {
              console.log(
                `[INFO] Continuing with ${modelToTest}. This may be slow.`,
              );
              resolve(currentConfiguredModel);
            }
          },
        );
      });
    }
    // For any other case (success, other error codes), we stick to the original model.
    return currentConfiguredModel;
  } catch (_error) {
    clearTimeout(timeoutId);
    // On timeout or any other fetch error, stick to the original model.
    // In a future iteration, we might want to ask the user here as well.
    return currentConfiguredModel;
  }
}
