// server/utils/journalSecurityHelpers.ts
// Security utilities for journal entry validation and sanitization

/**
 * Constants matching frontend validation
 */
export const JOURNAL_CONSTANTS = {
  MAX_ENTRY_LENGTH: 10000,
  MAX_GRATEFUL_LENGTH: 500,
  MAX_TAGS: 20,
  MAX_TAG_LENGTH: 50,
  VALID_TIMES_OF_DAY: ['morning', 'afternoon', 'evening', 'night'] as const,
  MOOD_RANGE: { min: 1, max: 10 },
  ENERGY_RANGE: { min: 1, max: 10 },
  EMOTION_INTENSITY_RANGE: { min: 1, max: 10 },
} as const;

/**
 * Validation error types for structured error handling
 */
export interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

/**
 * Comprehensive validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Sanitize text input to prevent XSS attacks
 * Server-side equivalent of frontend sanitizeInput
 */
export function sanitizeTextInput(input: string | null | undefined): string {
  if (!input) return '';
  
  let sanitized = input
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>.*?<\/iframe>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
  
  // Additional HTML entity encoding for safety
  sanitized = sanitized
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
  
  return sanitized;
}

/**
 * Sanitize and normalize tags
 * Matches frontend logic: lowercase, trim, filter empty, cap length/count
 */
export function sanitizeTags(tagsInput: string[] | string | null | undefined): string[] {
  if (!tagsInput) return [];
  
  // Handle string input (comma-separated)
  const tagsArray = typeof tagsInput === 'string' 
    ? tagsInput.split(',')
    : Array.isArray(tagsInput) ? tagsInput : [];
  
  return tagsArray
    .map(tag => sanitizeTextInput(tag).toLowerCase().trim())
    .filter(Boolean) // Remove empty strings
    .map(tag => tag.substring(0, JOURNAL_CONSTANTS.MAX_TAG_LENGTH))
    .slice(0, JOURNAL_CONSTANTS.MAX_TAGS);
}

/**
 * Validate numeric range
 */
function validateRange(
  value: any,
  field: string,
  min: number,
  max: number
): ValidationError | null {
  const num = Number(value);
  
  if (isNaN(num)) {
    return { field, message: `${field} must be a number`, value };
  }
  
  if (!Number.isFinite(num)) {
    return { field, message: `${field} must be finite`, value };
  }
  
  if (num < min || num > max) {
    return { field, message: `${field} must be between ${min} and ${max}`, value: num };
  }
  
  return null;
}

/**
 * Validate date format (YYYY-MM-DD)
 */
function validateDateFormat(dateStr: any): ValidationError | null {
  if (typeof dateStr !== 'string') {
    return { field: 'entryDate', message: 'Entry date must be a string', value: dateStr };
  }
  
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) {
    return { field: 'entryDate', message: 'Entry date must be in YYYY-MM-DD format', value: dateStr };
  }
  
  // Validate it's a real date
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return { field: 'entryDate', message: 'Entry date is not a valid date', value: dateStr };
  }
  
  // Prevent future dates (entries should be for today or past)
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (date > today) {
    return { field: 'entryDate', message: 'Entry date cannot be in the future', value: dateStr };
  }
  
  return null;
}

/**
 * Comprehensive journal entry validation
 * Mirrors frontend validation with additional server-side checks
 */
export function validateJournalEntry(data: any): ValidationResult {
  const errors: ValidationError[] = [];
  
  // Required field: entryDate
  if (!data.entryDate) {
    errors.push({ field: 'entryDate', message: 'Entry date is required' });
  } else {
    const dateError = validateDateFormat(data.entryDate);
    if (dateError) errors.push(dateError);
  }
  
  // Required field: timeOfDay
  if (!data.timeOfDay) {
    errors.push({ field: 'timeOfDay', message: 'Time of day is required' });
  } else if (!JOURNAL_CONSTANTS.VALID_TIMES_OF_DAY.includes(data.timeOfDay)) {
    errors.push({
      field: 'timeOfDay',
      message: `Time of day must be one of: ${JOURNAL_CONSTANTS.VALID_TIMES_OF_DAY.join(', ')}`,
      value: data.timeOfDay
    });
  }
  
  // Required field: moodRating
  const moodError = validateRange(
    data.moodRating,
    'moodRating',
    JOURNAL_CONSTANTS.MOOD_RANGE.min,
    JOURNAL_CONSTANTS.MOOD_RANGE.max
  );
  if (moodError) errors.push(moodError);
  
  // Required field: energyLevel
  const energyError = validateRange(
    data.energyLevel,
    'energyLevel',
    JOURNAL_CONSTANTS.ENERGY_RANGE.min,
    JOURNAL_CONSTANTS.ENERGY_RANGE.max
  );
  if (energyError) errors.push(energyError);
  
  // Required field: emotionIntensity
  const intensityError = validateRange(
    data.emotionIntensity,
    'emotionIntensity',
    JOURNAL_CONSTANTS.EMOTION_INTENSITY_RANGE.min,
    JOURNAL_CONSTANTS.EMOTION_INTENSITY_RANGE.max
  );
  if (intensityError) errors.push(intensityError);
  
  // Required field: primaryEmotion
  if (!data.primaryEmotion || typeof data.primaryEmotion !== 'string' || !data.primaryEmotion.trim()) {
    errors.push({ field: 'primaryEmotion', message: 'Primary emotion is required' });
  }
  
  // Required field: freeFormEntry (at least one content field)
  if (!data.freeFormEntry || typeof data.freeFormEntry !== 'string' || !data.freeFormEntry.trim()) {
    errors.push({
      field: 'freeFormEntry',
      message: 'Entry content is required (freeFormEntry cannot be empty)'
    });
  } else if (data.freeFormEntry.length > JOURNAL_CONSTANTS.MAX_ENTRY_LENGTH) {
    errors.push({
      field: 'freeFormEntry',
      message: `Entry cannot exceed ${JOURNAL_CONSTANTS.MAX_ENTRY_LENGTH} characters`,
      value: data.freeFormEntry.length
    });
  }
  
  // Optional: tags validation
  if (data.tags) {
    const sanitized = sanitizeTags(data.tags);
    if (sanitized.length > JOURNAL_CONSTANTS.MAX_TAGS) {
      errors.push({
        field: 'tags',
        message: `Maximum ${JOURNAL_CONSTANTS.MAX_TAGS} tags allowed`,
        value: sanitized.length
      });
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Sanitize complete journal entry
 * Returns sanitized data safe for database insertion
 */
export function sanitizeJournalEntry(data: any): any {
  return {
    entryDate: data.entryDate, // Already validated format
    timeOfDay: data.timeOfDay,
    moodRating: Number(data.moodRating),
    energyLevel: Number(data.energyLevel),
    emotionIntensity: Number(data.emotionIntensity),
    primaryEmotion: sanitizeTextInput(data.primaryEmotion),
    freeFormEntry: sanitizeTextInput(data.freeFormEntry).substring(0, JOURNAL_CONSTANTS.MAX_ENTRY_LENGTH),
    gratefulFor: data.gratefulFor 
      ? sanitizeTextInput(data.gratefulFor).substring(0, JOURNAL_CONSTANTS.MAX_GRATEFUL_LENGTH)
      : null,
    tags: sanitizeTags(data.tags),
    promptResponses: data.promptResponses || {},
    category: data.category ? sanitizeTextInput(data.category) : null,
  };
}

/**
 * Rate limit check helper
 * Returns true if request should be allowed
 */
export function checkEntryRateLimit(
  userEntriesToday: number,
  maxEntriesPerDay: number = 20
): { allowed: boolean; message?: string } {
  if (userEntriesToday >= maxEntriesPerDay) {
    return {
      allowed: false,
      message: `Maximum ${maxEntriesPerDay} entries per day exceeded. Current: ${userEntriesToday}`
    };
  }
  
  return { allowed: true };
}

/**
 * Calculate entry statistics for analytics
 */
export function calculateEntryStats(freeFormEntry: string): {
  wordCount: number;
  sentimentScore: number;
} {
  const wordCount = freeFormEntry ? freeFormEntry.trim().split(/\s+/).length : 0;
  const sentimentScore = calculateSimpleSentiment(freeFormEntry);
  
  return { wordCount, sentimentScore };
}

/**
 * Simple sentiment analysis
 * Returns score between -1 (negative) and 1 (positive)
 */
function calculateSimpleSentiment(text: string): number {
  if (!text) return 0;
  
  const positiveWords = [
    'happy', 'great', 'good', 'excellent', 'wonderful', 'amazing', 'love',
    'grateful', 'blessed', 'joy', 'excited', 'proud', 'accomplished',
    'successful', 'peaceful', 'content', 'satisfied', 'motivated', 'inspired'
  ];
  
  const negativeWords = [
    'sad', 'bad', 'terrible', 'awful', 'hate', 'angry', 'frustrated',
    'anxious', 'worried', 'stressed', 'depressed', 'lonely', 'tired',
    'exhausted', 'overwhelmed', 'hopeless', 'miserable'
  ];
  
  const lowercaseText = text.toLowerCase();
  let score = 0;
  
  for (const word of positiveWords) {
    if (lowercaseText.includes(word)) score += 0.1;
  }
  
  for (const word of negativeWords) {
    if (lowercaseText.includes(word)) score -= 0.1;
  }
  
  return Math.max(-1, Math.min(1, score));
}

/**
 * Generate a sanitized error response
 * Prevents leaking internal details
 */
export function generateErrorResponse(
  validationResult: ValidationResult,
  sanitize: boolean = true
): { error: string; details?: any } {
  if (!validationResult.valid) {
    const errorMessage = validationResult.errors
      .map(e => e.message)
      .join('; ');
    
    return {
      error: 'Validation failed',
      details: sanitize 
        ? validationResult.errors.map(e => ({ field: e.field, message: e.message }))
        : validationResult.errors
    };
  }
  
  return { error: 'Unknown validation error' };
}
