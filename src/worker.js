/**
 * Hollis Backend — Cloudflare Worker Entry Point
 * Handles request routing, CORS preflight, and top-level error boundaries.
 */

import { corsPreflightResponse, errorResponse, jsonResponse } from './utils/response.js';
import { handleRegister, handleLogin, handleVerifyToken, handleLogout } from './routes/auth.js';
import { handleGetMe, handleUpdateSettings } from './routes/users.js';
import { handleTasksRoute } from './routes/tasks.js';
import { handleWebSocketRoute } from './routes/websocket.js';

export default {
  /**
   * Main fetch handler for Cloudflare Workers.
   *
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();

      // Root service discovery / health check
      if (path === '/' || path === '/health' || path === '/api/health') {
        return jsonResponse({
          status: 'ok',
          service: 'hollis-backend',
          phase: 3,
          message: 'Hollis Backend Edge Service running (Phases 1, 2 & 3 active).',
        });
      }

      // Authentication routes
      if (path === '/api/auth/register') {
        if (method !== 'POST') {
          return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
        }
        return await handleRegister(request, env);
      }

      if (path === '/api/auth/login') {
        if (method !== 'POST') {
          return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
        }
        return await handleLogin(request, env);
      }

      if (path === '/api/auth/verify-token' || path === '/api/auth/google-login') {
        if (method !== 'POST') {
          return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
        }
        return await handleVerifyToken(request, env);
      }

      if (path === '/api/auth/logout') {
        if (method !== 'POST') {
          return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
        }
        return await handleLogout(request, env);
      }

      // User profile & settings routes
      if (path === '/api/users/me') {
        if (method !== 'GET') {
          return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
        }
        return await handleGetMe(request, env);
      }

      if (path === '/api/users/settings') {
        if (method !== 'PUT') {
          return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
        }
        return await handleUpdateSettings(request, env);
      }

      // Tasks routes (Session management, history, replay)
      if (path === '/api/tasks' || path.startsWith('/api/tasks/')) {
        return await handleTasksRoute(request, env, ctx, url, method);
      }

      // WebSocket routes (Real-time task streaming & cancellation)
      if (path === '/ws/tasks' || path.startsWith('/ws/tasks/')) {
        return await handleWebSocketRoute(request, env, ctx, url);
      }

      // Route not found
      return errorResponse('Route not found.', 404, 'not_found');
    } catch (err) {
      console.error('Unhandled worker error:', err);
      return errorResponse(err.message || 'Internal server error.', 500, 'internal_error');
    }
  },
};