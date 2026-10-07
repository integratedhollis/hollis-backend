/**
 * Hollis Screen Control — 5-Step Agent Loop Controller
 *
 * Implements the 5-step autonomous/interactive screen control cycle:
 * 1. Observe   -> Ingest screen state (screen_tree, screenshot)
 * 2. Decide    -> Tree Quality check & Action Decision (Text Mode vs Vision Mode)
 * 3. Risk      -> Risk evaluation & interactive confirmation pause if sensitive
 * 4. Act       -> Dispatch action & log frame to Android client
 * 5. Verify    -> Compute structural diff (verified_changed: 0 or 1), detect loops (stopped_loop) & enforce limits (stopped_limit)
 */

import { decide_action } from './adapter.js';
import { check_risk } from './riskEngine.js';
import { verify_step } from './diffEngine.js';

/**
 * Delays execution for ms milliseconds, resolving immediately if signal aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class AgentLoop {
  /**
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.userId
   * @param {string} params.instruction
   * @param {WebSocket} params.ws
   * @param {Record<string, any>} params.env
   * @param {AbortController} params.abortController
   * @param {object} [params.settings] - User settings { confirmation_mode, max_step_limit }
   * @param {number} [params.initialStepCount=0]
   */
  constructor({
    sessionId,
    userId,
    instruction,
    ws,
    env,
    abortController,
    settings = {},
    initialStepCount = 0,
  }) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.instruction = instruction;
    this.ws = ws;
    this.env = env;
    this.abortController = abortController;

    this.confirmationMode = settings.confirmation_mode || 'popup';
    this.maxStepLimit = Number(settings.max_step_limit) || 20;

    this.currentStep = initialStepCount;
    this.unchangedStreak = 0;
    this.history = [];
    this.status = 'running';

    this.isInteractive = false;
    this.latestObservation = null;

    this.pendingConfirmResolver = null;
    this.loopRunning = false;
    this.isSuperseded = false;

    // Attach abort signal listener to cleanly close socket from within its own execution context
    this.abortController?.signal?.addEventListener(
      'abort',
      () => {
        this.status = 'cancelled';
        if (this.pendingActionResolver) {
          const res = this.pendingActionResolver;
          this.pendingActionResolver = null;
          res(null);
        }
        if (this.pendingConfirmResolver) {
          const res = this.pendingConfirmResolver;
          this.pendingConfirmResolver = null;
          res(false);
        }
        setTimeout(() => {
          try {
            if (this.isSuperseded) {
              this.ws?.close(1000, 'Replaced by new connection');
            } else {
              this.ws?.close(1000, 'Task cancelled');
            }
          } catch (_) {}
        }, 0);
      },
      { once: true }
    );
  }

  /**
   * Safe frame sender over WebSocket in current isolate context.
   * @param {object} data
   */
  sendFrame(data) {
    try {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify(data));
      }
    } catch (err) {
      console.warn(`[AgentLoop ${this.sessionId}] Failed to send WS frame:`, err.message);
    }
  }

  /**
   * Handles abort or cancellation signals cleanly.
   * @param {string} [reason='Task cancelled']
   */
  handleAbortOrCancellation(reason = 'Task cancelled') {
    if (this.isSuperseded) {
      try {
        this.ws?.close(1000, 'Replaced by new connection');
      } catch (_) {}
      return;
    }
    this.status = 'cancelled';
    this.sendFrame({
      event: 'cancelled',
      session_id: this.sessionId,
      status: 'cancelled',
      summary_message:
        reason === 'Risk confirmation rejected'
          ? 'การทำงานถูกยกเลิกเนื่องจากไม่ได้รับการยืนยันขั้นตอนที่มีความเสี่ยง'
          : 'งานถูกยกเลิกโดยผู้ใช้',
    });
    try {
      this.ws?.close(1000, reason);
    } catch (_) {}
  }

  /**
   * Handles incoming `observe` frame from client.
   * @param {object} data - { screen_tree, screenshot }
   */
  async handleObserve(data) {
    this.isInteractive = true;
    this.latestObservation = {
      screen_tree: data.screen_tree || null,
      screenshot: data.screenshot || null,
    };

    // If waiting for action execution result, unblock it with the fresh observation
    if (this.pendingActionResolver) {
      const resolver = this.pendingActionResolver;
      this.pendingActionResolver = null;
      resolver({
        screen_tree: data.screen_tree || null,
        screenshot: data.screenshot || null,
        status: 'ok',
      });
      return;
    }

    if (!this.loopRunning) {
      await this.runLoopCycle();
    }
  }

  /**
   * Handles incoming `action_done` frame from client.
   * @param {object} data - { step_no, screen_tree, screenshot, status }
   */
  handleActionDone(data) {
    if (this.pendingActionResolver) {
      const resolver = this.pendingActionResolver;
      this.pendingActionResolver = null;
      resolver(data);
    }
  }

  /**
   * Handles incoming user risk confirmation (`confirm` frame or REST API).
   * @param {object} data - { approved: boolean }
   */
  handleConfirm(data) {
    if (this.pendingConfirmResolver) {
      const resolver = this.pendingConfirmResolver;
      this.pendingConfirmResolver = null;
      resolver(Boolean(data.approved));
    }
  }

  /**
   * Starts autonomous execution if client has not sent interactive observe messages.
   * @param {number} [initialDelayMs=350]
   * @returns {Promise<void>}
   */
  startAutonomousIfNeeded(initialDelayMs = 350) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        if (this.abortController.signal.aborted || this.status !== 'running' || this.isSuperseded) {
          if (this.isSuperseded) {
            try {
              this.ws?.close(1000, 'Replaced by new connection');
            } catch (_) {}
          }
          return resolve();
        }
        if (!this.isInteractive && !this.loopRunning) {
          await this.runLoopCycle();
        }
        resolve();
      }, initialDelayMs);
    });
  }

  /**
   * Main iterative loop execution.
   */
  async runLoopCycle() {
    if (this.loopRunning) return;
    this.loopRunning = true;

    try {
      while (this.status === 'running') {
        if (this.isSuperseded) {
          break;
        }

        // Edge resilience check: query DB session status in case of external REST cancellation
        const currentSession = await this.env.DB.prepare(
          `SELECT status FROM sessions WHERE id = ? AND user_id = ?`
        )
          .bind(this.sessionId, this.userId)
          .first();

        if (this.isSuperseded) {
          break;
        }

        if (!currentSession || currentSession.status === 'cancelled' || this.abortController.signal.aborted) {
          this.handleAbortOrCancellation();
          break;
        }

        if (currentSession.status !== 'running') {
          break;
        }

        const nextStepNo = this.currentStep + 1;

        // Step 1: OBSERVE
        const stateBefore = this.latestObservation || {
          screen_tree: {
            class: 'android.widget.FrameLayout',
            clickable: true,
            text: 'หน้าจอหลัก',
            children: [
              { class: 'android.widget.Button', clickable: true, text: 'ค้นหา' },
            ],
          },
          screenshot: null,
        };

        // Step 2: DECIDE
        const decision = await decide_action({
          instruction: this.instruction,
          screen_tree: stateBefore.screen_tree,
          screenshot: stateBefore.screenshot,
          history: this.history,
          env: this.env,
          options: { stepIndex: this.currentStep },
        });

        if (this.isSuperseded) {
          break;
        }

        if (this.abortController.signal.aborted) {
          this.handleAbortOrCancellation();
          break;
        }

        // Step 3: RISK CHECK
        const riskResult = check_risk(decision);
        const isRisky = riskResult.is_risky;
        const stepId = crypto.randomUUID();
        const timestamp = new Date().toISOString();

        if (isRisky && this.confirmationMode !== 'none') {
          // Pre-persist step record and risk_confirmation row in D1 atomically
          await this.env.DB.batch([
            this.env.DB.prepare(
              `INSERT INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
            ).bind(
              stepId,
              this.sessionId,
              nextStepNo,
              decision.action_type,
              decision.log_message,
              1,
              timestamp
            ),
            this.env.DB.prepare(
              `INSERT INTO risk_confirmations (id, session_id, step_id, requested_mode, user_response, responded_at)
               VALUES (?, ?, ?, ?, NULL, NULL)`
            ).bind(
              crypto.randomUUID(),
              this.sessionId,
              stepId,
              this.confirmationMode === 'push' ? 'push' : 'popup'
            ),
          ]);

          // Broadcast confirmation required event
          this.sendFrame({
            event: 'risk_confirmation_required',
            session_id: this.sessionId,
            step_no: nextStepNo,
            step_id: stepId,
            action: decision,
            matched_keyword: riskResult.matched_keyword,
            confirmation_mode: this.confirmationMode,
            message: `การกระทำนี้มีความเสี่ยง ("${riskResult.matched_keyword}") ต้องการการยืนยันจากผู้ใช้`,
          });

          // Await confirmation (with 60s timeout)
          const approved = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              if (this.pendingConfirmResolver) {
                this.pendingConfirmResolver = null;
                resolve(false);
              }
            }, 60000);

            this.pendingConfirmResolver = (result) => {
              clearTimeout(timeout);
              resolve(result);
            };
          });

          if (this.abortController.signal.aborted) {
            this.handleAbortOrCancellation();
            break;
          }

          const respondedAt = new Date().toISOString();
          const responseVal = approved ? 'approved' : 'rejected';

          await this.env.DB.prepare(
            `UPDATE risk_confirmations
             SET user_response = ?, responded_at = ?
             WHERE step_id = ?`
          ).bind(responseVal, respondedAt, stepId).run();

          if (!approved) {
            this.status = 'cancelled';
            this.currentStep = nextStepNo;
            await this.env.DB.prepare(
              `UPDATE sessions SET status = 'cancelled', step_count = ?, ended_at = ? WHERE id = ? AND user_id = ?`
            ).bind(nextStepNo, respondedAt, this.sessionId, this.userId).run();

            this.handleAbortOrCancellation('Risk confirmation rejected');
            break;
          }
        }

        // Step 4: ACT
        // Atomically record step and advance sessions.step_count
        if (!isRisky || this.confirmationMode === 'none') {
          await this.env.DB.batch([
            this.env.DB.prepare(
              `INSERT OR IGNORE INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
            ).bind(
              stepId,
              this.sessionId,
              nextStepNo,
              decision.action_type,
              decision.log_message,
              isRisky ? 1 : 0,
              timestamp
            ),
            this.env.DB.prepare(
              `UPDATE sessions SET step_count = ? WHERE id = ? AND status = 'running'`
            ).bind(nextStepNo, this.sessionId),
          ]);
        } else {
          // Risky step was approved; advance step_count in sessions table
          await this.env.DB.prepare(
            `UPDATE sessions SET step_count = ? WHERE id = ? AND status = 'running'`
          ).bind(nextStepNo, this.sessionId).run();
        }

        this.currentStep = nextStepNo;

        this.sendFrame({
          event: 'action',
          session_id: this.sessionId,
          step_no: nextStepNo,
          step_id: stepId,
          action: decision,
          mode_used: decision.mode_used,
          is_risky: isRisky,
        });

        this.sendFrame({
          event: 'log',
          session_id: this.sessionId,
          step_no: nextStepNo,
          log_message: decision.log_message,
          timestamp,
          is_risky: isRisky,
          action_type: decision.action_type,
        });

        // Wait for action execution
        let stateAfter = null;
        if (this.isInteractive) {
          const actionDoneData = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              if (this.pendingActionResolver) {
                this.pendingActionResolver = null;
                resolve(null);
              }
            }, 15000);

            this.pendingActionResolver = (doneData) => {
              clearTimeout(timeout);
              resolve(doneData);
            };
          });

          if (this.abortController.signal.aborted) {
            this.handleAbortOrCancellation();
            break;
          }

          if (actionDoneData) {
            stateAfter = {
              screen_tree: actionDoneData.screen_tree || null,
              screenshot: actionDoneData.screenshot || null,
            };
          }
        } else {
          // Autonomous delay ~300ms (abortable)
          await abortableSleep(300, this.abortController.signal);

          // Check DB cancellation right after sleep
          const postSleepSession = await this.env.DB.prepare(
            `SELECT status FROM sessions WHERE id = ? AND user_id = ?`
          )
            .bind(this.sessionId, this.userId)
            .first();

          if (!postSleepSession || postSleepSession.status === 'cancelled' || this.abortController.signal.aborted) {
            this.handleAbortOrCancellation();
            break;
          }

          if (!decision.is_completed) {
            stateAfter = {
              screen_tree: {
                class: 'android.widget.FrameLayout',
                clickable: true,
                text: `หน้าจอหลังจากขั้นตอนที่ ${nextStepNo}`,
                children: [
                  { class: 'android.widget.TextView', text: `สถานะขั้นตอน ${nextStepNo} สำเร็จ` },
                ],
              },
              screenshot: null,
            };
          } else {
            stateAfter = stateBefore;
          }
        }

        // Step 5: VERIFY
        const diffResult = verify_step(stateBefore, stateAfter);
        const verifiedChanged = diffResult.verified_changed;

        await this.env.DB.prepare(
          `UPDATE task_steps SET verified_changed = ? WHERE id = ?`
        ).bind(verifiedChanged, stepId).run();

        this.currentStep = nextStepNo;
        this.history.push({
          step_no: nextStepNo,
          action: decision,
          state_before: stateBefore,
          state_after: stateAfter,
          verified_changed: verifiedChanged,
        });

        if (stateAfter) {
          this.latestObservation = stateAfter;
        }

        // --- TERMINATION CHECKS ---

        // 1. Goal Completed
        if (decision.is_completed || decision.action_type === 'complete') {
          this.status = 'completed';
          const endedAt = new Date().toISOString();
          await this.env.DB.prepare(
            `UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'`
          ).bind(endedAt, this.sessionId, this.userId).run();

          this.sendFrame({
            event: 'finished',
            session_id: this.sessionId,
            status: 'completed',
            total_steps: this.currentStep,
            step_count: this.currentStep,
            summary_message: 'งานเสร็จสมบูรณ์เรียบร้อยแล้ว',
          });
          try { this.ws?.close(1000, 'Task completed successfully'); } catch (_) {}
          break;
        }

        // 2. Loop Detection
        if (verifiedChanged === 0) {
          this.unchangedStreak++;
        } else {
          this.unchangedStreak = 0;
        }

        if (this.unchangedStreak >= 3) {
          this.status = 'stopped_loop';
          const endedAt = new Date().toISOString();
          await this.env.DB.prepare(
            `UPDATE sessions SET status = 'stopped_loop', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'`
          ).bind(endedAt, this.sessionId, this.userId).run();

          this.sendFrame({
            event: 'stopped_loop',
            session_id: this.sessionId,
            status: 'stopped_loop',
            total_steps: this.currentStep,
            step_count: this.currentStep,
            summary_message: 'ตรวจพบลูปการทำงานซ้ำซ้อน 3 ครั้งโดยหน้าจอไม่เปลี่ยนแปลง ระบบหยุดการทำงานโดยอัตโนมัติ',
          });
          try { this.ws?.close(1000, 'Stopped due to loop detection'); } catch (_) {}
          break;
        }

        // 3. Step Limit Enforcer
        if (this.currentStep >= this.maxStepLimit) {
          this.status = 'stopped_limit';
          const endedAt = new Date().toISOString();
          await this.env.DB.prepare(
            `UPDATE sessions SET status = 'stopped_limit', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'`
          ).bind(endedAt, this.sessionId, this.userId).run();

          this.sendFrame({
            event: 'stopped_limit',
            session_id: this.sessionId,
            status: 'stopped_limit',
            total_steps: this.currentStep,
            step_count: this.currentStep,
            summary_message: `จำนวนขั้นตอนถึงขีดจำกัดสูงสุด (${this.maxStepLimit} ขั้นตอน) ระบบหยุดการทำงานอัตโนมัติ`,
          });
          try { this.ws?.close(1000, 'Stopped due to step limit reached'); } catch (_) {}
          break;
        }

        if (this.isInteractive && !this.latestObservation) {
          break;
        }
      }
    } catch (err) {
      console.error(`[AgentLoop ${this.sessionId}] Error during loop cycle:`, err);
    } finally {
      this.loopRunning = false;
    }
  }
}
