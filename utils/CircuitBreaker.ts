/**
 * Circuit Breaker Pattern Implementation
 *
 * Protects against cascading failures when DINA server is down.
 * Automatically opens circuit after threshold failures, preventing
 * unnecessary requests to a failing service.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit broken, requests fail fast
 * - HALF_OPEN: Testing if service recovered
 */

import { Logger } from './logger';

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal - requests allowed
  OPEN = 'OPEN',         // Broken - fail fast
  HALF_OPEN = 'HALF_OPEN' // Testing recovery
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Failures before opening circuit
  successThreshold: number;      // Successes to close circuit
  timeout: number;               // Time before attempting half-open (ms)
  monitoringPeriod: number;      // Window for counting failures (ms)
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failures: number;
  successes: number;
  totalRequests: number;
  lastFailureTime?: Date;
  lastSuccessTime?: Date;
  stateChangedAt: Date;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private totalRequests: number = 0;
  private lastFailureTime?: Date;
  private lastSuccessTime?: Date;
  private stateChangedAt: Date = new Date();
  private nextAttemptTime?: Date;
  private logger: Logger;

  constructor(
    private name: string,
    private config: CircuitBreakerConfig
  ) {
    this.logger = new Logger(`CircuitBreaker:${name}`);
    this.logger.info('Circuit breaker initialized', { config });
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(
    fn: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    this.totalRequests++;

    // If circuit is OPEN, fail fast
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      const attemptTime = this.nextAttemptTime?.getTime() || 0;

      if (now < attemptTime) {
        this.logger.debug('Circuit is OPEN, failing fast', {
          nextAttemptIn: attemptTime - now
        });

        if (fallback) {
          return await fallback();
        }

        throw new Error(`Circuit breaker is OPEN for ${this.name}`);
      }

      // Time to attempt half-open
      this.transitionTo(CircuitState.HALF_OPEN);
    }

    // Execute the function
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();

      if (fallback) {
        this.logger.warn('Executing fallback due to failure', { error });
        return await fallback();
      }

      throw error;
    }
  }

  /**
   * Record successful execution
   */
  private recordSuccess(): void {
    this.successes++;
    this.lastSuccessTime = new Date();
    this.failures = 0; // Reset failure count on success

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successes >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }
  }

  /**
   * Record failed execution
   */
  private recordFailure(): void {
    this.failures++;
    this.lastFailureTime = new Date();

    if (this.state === CircuitState.HALF_OPEN) {
      // Immediately open on failure during half-open
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      // Open circuit if threshold exceeded
      if (this.failures >= this.config.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.stateChangedAt = new Date();

    if (newState === CircuitState.OPEN) {
      this.nextAttemptTime = new Date(Date.now() + this.config.timeout);
      this.successes = 0; // Reset successes when opening
    } else if (newState === CircuitState.CLOSED) {
      this.failures = 0;
      this.successes = 0;
      this.nextAttemptTime = undefined;
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successes = 0;
    }

    this.logger.info(`Circuit breaker state changed: ${oldState} → ${newState}`, {
      failures: this.failures,
      successes: this.successes,
      nextAttemptTime: this.nextAttemptTime
    });
  }

  /**
   * Get current metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalRequests: this.totalRequests,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      stateChangedAt: this.stateChangedAt
    };
  }

  /**
   * Force circuit to specific state (for testing/admin)
   */
  forceState(state: CircuitState): void {
    this.logger.warn(`Forcing circuit breaker state to ${state}`);
    this.transitionTo(state);
  }

  /**
   * Reset all counters and close circuit
   */
  reset(): void {
    this.logger.info('Resetting circuit breaker');
    this.failures = 0;
    this.successes = 0;
    this.totalRequests = 0;
    this.lastFailureTime = undefined;
    this.lastSuccessTime = undefined;
    this.transitionTo(CircuitState.CLOSED);
  }

  /**
   * Check if circuit is healthy
   */
  isHealthy(): boolean {
    return this.state === CircuitState.CLOSED;
  }
}
