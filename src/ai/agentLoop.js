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

import { decide_action, AIEngineError } from './adapter.js';
import { check_risk } from './riskEngine.js';
import { verify_step } from './diffEngine.js';
import { findElement } from './prompt.js';

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

/**
 * Pulls the screen out of an `observe` / `action_done` frame.
 * The Android client (and API docs) send a flat `screen_elements` array; `screen_tree` is the
 * older nested form. Accept both so the model never sees an empty screen.
 * @param {object} data
 * @returns {any}
 */
function extractScreen(data) {
  if (!data || typeof data !== 'object') return null;
  return data.screen_tree ?? data.screen_elements ?? null;
}

/** Tools whose whole point is to leave the screen as it is (or end the task); "unchanged" is not a failure for them. */
const NO_VISIBLE_EFFECT_TOOLS = new Set(['wait_and_poll', 'task_finish']);
/** Tools that can touch money, messages or data, so their real target is checked for risky words. */
const RISK_CHECKED_TOOLS = new Set(['click_element', 'click_coordinate', 'input_text']);
const MAX_INSTALLED_APPS = 400;

/**
 * What to scan for risky words. The model's own description of a tap is not enough ("button 3"),
 * so the label of the element that will really be tapped is included. Text the user asked to
 * type is deliberately left out: typing "send" into a search box is not a risky act.
 * @returns {object | null} null when the tool cannot cause anything irreversible.
 */
function buildRiskSubject(decision, screenTree) {
  const tool = decision.tool_name || decision.action_type;
  if (!RISK_CHECKED_TOOLS.has(tool)) return null;
  const params = decision.parameters || {};
  const element = findElement(screenTree, params.element_id);
  const subject = { element_text: element?.text, element_desc: element?.desc };
  if (tool !== 'input_text') {
    subject.target = decision.target;
    subject.target_description = params.target_description;
  }
  return subject;
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
    /** What the phone has told us about itself: foreground app, screen size, installed apps. */
    this.deviceContext = { package: null, screen: null, installed_apps: [] };

    this.pendingConfirmResolver = null;
    this.pendingConfirmStepId = null;
    this.pendingActionResolver = null;
    this.loopRunning = false;
    this.isSuperseded = false;
    this.remoteSyncStarted = false;

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
    this.absorbDeviceFacts(data);
    const screenTree = extractScreen(data);
    this.latestObservation = {
      screen_tree: screenTree,
      screenshot: data.screenshot || null,
    };

    // If waiting for action execution result, unblock it with the fresh observation
    if (this.pendingActionResolver) {
      const resolver = this.pendingActionResolver;
      this.pendingActionResolver = null;
      resolver({
        screen_tree: screenTree,
        screenshot: data.screenshot || null,
        package: data.package || null,
        status: 'ok',
      });
      return;
    }

    if (!this.loopRunning) {
      await this.runLoopCycle();
    }
  }

  /**
   * Remembers what the phone reports about itself so the model can use it on every turn.
   * All fields are optional (older clients send none of them).
   * @param {object} data - observe / action_done frame: { package, screen: {w, h}, installed_apps: [{name, package}] }
   */
  absorbDeviceFacts(data) {
    if (!data || typeof data !== 'object') return;
    const ctx = this.deviceContext;
    if (typeof data.package === 'string' && data.package) {
      ctx.package = data.package;
    }
    const w = Number(data.screen?.w);
    const h = Number(data.screen?.h);
    if (w > 0 && h > 0) {
      ctx.screen = { w: Math.round(w), h: Math.round(h) };
    }
    if (Array.isArray(data.installed_apps) && data.installed_apps.length > 0) {
      ctx.installed_apps = data.installed_apps
        .filter((a) => a && typeof a.name === 'string' && typeof a.package === 'string' && a.name.trim())
        .slice(0, MAX_INSTALLED_APPS)
        .map((a) => ({ name: a.name.trim(), package: a.package }));
    }
  }

  /**
   * Handles incoming `action_done` frame from client.
   * @param {object} data - { step_no, screen_tree | screen_elements, screenshot, status, message, package }
   */
  handleActionDone(data) {
    this.absorbDeviceFacts(data);
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
   * Keeps this loop in sync with REST calls handled by a *different* Worker isolate.
   *
   * POST /cancel and POST /confirm only reach this loop directly (via wsRegistry) when they
   * land on the same isolate that holds the WebSocket. Both endpoints always write to D1 first,
   * so this watcher polls D1 while the connection is alive and applies:
   * - an external cancellation (sessions.status = 'cancelled')
   * - an external risk confirmation answer (risk_confirmations.user_response) while one is pending
   * Same-isolate behaviour is unchanged; this is only a fallback.
   *
   * @param {number} [intervalMs=2000]
   */
  startRemoteSync(intervalMs = 2000) {
    if (this.remoteSyncStarted) return;
    this.remoteSyncStarted = true;

    const tick = async () => {
      if (this.abortController.signal.aborted || this.isSuperseded || this.status !== 'running') {
        return;
      }

      try {
        // 1. External risk-confirmation answer
        if (this.pendingConfirmResolver && this.pendingConfirmStepId) {
          const row = await this.env.DB.prepare(
            `SELECT user_response FROM risk_confirmations WHERE step_id = ?`
          )
            .bind(this.pendingConfirmStepId)
            .first();
          if (row && row.user_response && this.pendingConfirmResolver) {
            this.handleConfirm({ approved: row.user_response === 'approved' });
          }
        }

        // 2. External cancellation
        const session = await this.env.DB.prepare(
          `SELECT status FROM sessions WHERE id = ? AND user_id = ?`
        )
          .bind(this.sessionId, this.userId)
          .first();
        if (
          session &&
          session.status === 'cancelled' &&
          this.status === 'running' &&
          !this.isSuperseded
        ) {
          this.handleAbortOrCancellation();
          this.abortController.abort();
          return;
        }
      } catch (err) {
        console.warn(`[AgentLoop ${this.sessionId}] Remote sync poll failed:`, err.message);
      }

      setTimeout(tick, intervalMs);
    };

    setTimeout(tick, intervalMs);
  }

  /**
   * The AI engine could not decide (not configured, API down, no readable screen). Tell the phone
   * plainly and end the task as failed, rather than pretending it succeeded.
   * @param {unknown} err
   */
  async failWithAiError(err) {
    const code = err instanceof AIEngineError ? err.code : 'ai_unavailable';
    const message =
      err instanceof AIEngineError ? err.message : 'ระบบ AI ขัดข้อง ไม่สามารถทำงานต่อได้ กรุณาลองใหม่อีกครั้ง';
    console.error(`[AgentLoop ${this.sessionId}] AI engine error (${code}):`, err?.message, err?.details || '');

    this.status = 'failed';
    const endedAt = new Date().toISOString();
    try {
      await this.env.DB.prepare(
        `UPDATE sessions SET status = 'failed', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'`
      ).bind(endedAt, this.sessionId, this.userId).run();
    } catch (dbErr) {
      console.warn(`[AgentLoop ${this.sessionId}] Failed to persist ai_error:`, dbErr.message);
    }

    this.sendFrame({
      event: 'ai_error',
      session_id: this.sessionId,
      status: 'failed',
      code,
      message,
      // The provider's own error text (e.g. "HTTP 404 model_not_found"), so a misconfiguration is diagnosable from the phone's log.
      detail: err instanceof AIEngineError && err.details?.length ? String(err.details[0]).slice(0, 300) : undefined,
      summary_message: message,
      total_steps: this.currentStep,
      step_count: this.currentStep,
    });
    try { this.ws?.close(1000, 'AI engine error'); } catch (_) {}
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
        let decision;
        try {
          decision = await decide_action({
            instruction: this.instruction,
            screen_tree: stateBefore.screen_tree,
            screenshot: stateBefore.screenshot,
            history: this.history,
            context: this.deviceContext,
            env: this.env,
            options: { stepIndex: this.currentStep },
          });
        } catch (err) {
          if (this.isSuperseded || this.abortController.signal.aborted) {
            break;
          }
          await this.failWithAiError(err);
          break;
        }

        if (this.isSuperseded) {
          break;
        }

        if (this.abortController.signal.aborted) {
          this.handleAbortOrCancellation();
          break;
        }

        // Say which element the id really is. The model's own words ("search button") can disagree with
        // its id, and this makes such a mix-up visible in the chat, the stored log and the phone's logcat.
        if (decision.resolved_label && (decision.tool_name === 'click_element' || decision.tool_name === 'input_text')) {
          decision.log_message = `${decision.log_message} → ${decision.resolved_label}`;
        }

        // Step 3: RISK CHECK
        const riskResult = check_risk(buildRiskSubject(decision, stateBefore.screen_tree));
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
          this.pendingConfirmStepId = stepId;
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
          this.pendingConfirmStepId = null;

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

        const toolName = decision.tool_name || decision.action_type || 'click_element';
        const toolParams = decision.parameters || {};

        this.sendFrame({
          event: 'action',
          session_id: this.sessionId,
          step_no: nextStepNo,
          step_id: stepId,
          tool: toolName,
          tool_name: toolName,
          parameters: toolParams,
          action: decision,
          mode_used: decision.mode_used,
          engine_used: decision.engine_used,
          model_used: decision.model_used,
          resolved_label: decision.resolved_label,
          is_risky: isRisky,
        });

        this.sendFrame({
          event: 'log',
          session_id: this.sessionId,
          step_no: nextStepNo,
          log_message: decision.log_message,
          timestamp,
          is_risky: isRisky,
          action_type: toolName,
          tool_name: toolName,
          engine_used: decision.engine_used,
          model_used: decision.model_used,
        });

        const isTaskFinish =
          decision.is_completed ||
          toolName === 'task_finish' ||
          decision.action_type === 'complete' ||
          decision.action_type === 'task_finish';

        if (isTaskFinish) {
          // The model may report that it could not do the task; record that honestly.
          const finalStatus = toolParams.status === 'failed' ? 'failed' : 'completed';
          this.status = finalStatus;
          const endedAt = new Date().toISOString();
          await this.env.DB.prepare(
            `UPDATE sessions SET status = ?, ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'`
          ).bind(finalStatus, endedAt, this.sessionId, this.userId).run();

          const summaryMsg = toolParams.message || decision.log_message || 'งานเสร็จสมบูรณ์เรียบร้อยแล้ว';
          this.sendFrame({
            event: 'finished',
            session_id: this.sessionId,
            status: finalStatus,
            total_steps: this.currentStep,
            step_count: this.currentStep,
            summary_message: summaryMsg,
          });
          try { this.ws?.close(1000, 'Task completed successfully'); } catch (_) {}
          break;
        }

        // Wait for action execution
        let stateAfter = null;
        /** What the phone says happened: { status: 'ok' | 'error' | 'timeout', message, package } */
        let result = { status: 'ok', message: null, package: null };
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
              screen_tree: extractScreen(actionDoneData),
              screenshot: actionDoneData.screenshot || null,
            };
            result = {
              status: actionDoneData.status === 'error' ? 'error' : 'ok',
              message: typeof actionDoneData.message === 'string' ? actionDoneData.message : null,
              package: actionDoneData.package || null,
            };
          } else {
            result = { status: 'timeout', message: null, package: null };
          }
        } else {
          // Autonomous delay (respect wait_and_poll duration if specified)
          const delayMs = toolName === 'wait_and_poll' && toolParams.duration_ms
            ? Math.max(500, Math.min(3000, Number(toolParams.duration_ms)))
            : 300;
          await abortableSleep(delayMs, this.abortController.signal);

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
        // No screen came back (the phone never answered): nothing was verified, so it is not a change.
        const verifiedChanged = stateAfter ? verify_step(stateBefore, stateAfter).verified_changed : 0;

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
          result,
        });

        if (stateAfter) {
          this.latestObservation = stateAfter;
        }

        // --- TERMINATION CHECKS ---

        // 1. Loop Detection (a deliberate wait leaves the screen alone, so it neither adds to nor resets the streak)
        if (!NO_VISIBLE_EFFECT_TOOLS.has(toolName)) {
          this.unchangedStreak = verifiedChanged === 0 ? this.unchangedStreak + 1 : 0;
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
