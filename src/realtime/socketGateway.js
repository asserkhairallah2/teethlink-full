import crypto from 'node:crypto';
import { Server as SocketIOServer } from 'socket.io';
import { pool } from '../db/pool.js';
import { extractBearerToken, verifyAndLoadUserContext } from '../middlewares/auth.js';

/** @type {SocketIOServer | null} */
let ioInstance = null;

/** @type {import('socket.io').Namespace | null} */
let realtimeNamespace = null;

const DATE_ROOM_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Evaluates whether `socket.user` is authorized to join `room` according to §5.1
 * of BACKEND_SYSTEM_PLAN.md.
 *
 * @param {import('socket.io').Socket} socket
 * @param {string} room
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
async function canJoinRoom(socket, room) {
  const user = socket.user;
  if (!user) {
    return { allowed: false, reason: 'Unauthenticated socket connection.' };
  }

  if (typeof room !== 'string' || room.trim().length === 0) {
    return { allowed: false, reason: 'Room name must be a non-empty string.' };
  }

  const parts = room.split(':');
  const prefix = parts[0];

  // 1. Personal room: user:{userId}
  if (prefix === 'user' && parts.length === 2) {
    const targetUserId = Number(parts[1]);
    if (targetUserId === user.userId) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'Cannot subscribe to another user personal channel.' };
  }

  // 2. Exam slots calendar board: exam_slots:{YYYY-MM-DD}
  if (prefix === 'exam_slots' && parts.length === 2 && DATE_ROOM_REGEX.test(parts[1])) {
    if (['PATIENT', 'SUPERVISOR', 'ADMIN'].includes(user.role)) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'Role is not permitted to watch exam slot boards.' };
  }

  // 3. Triage queue board: triage:{YYYY-MM-DD}
  if (prefix === 'triage' && parts.length === 2 && DATE_ROOM_REGEX.test(parts[1])) {
    if (['SUPERVISOR', 'ADMIN'].includes(user.role)) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'Only SUPERVISOR and ADMIN can subscribe to triage queues.' };
  }

  // 4. Department case pool: dept:{departmentId}
  // 5. Department live bed board: dept:{departmentId}:beds
  if (prefix === 'dept' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'beds'))) {
    const departmentId = Number(parts[1]);
    if (!Number.isInteger(departmentId) || departmentId <= 0) {
      return { allowed: false, reason: 'Invalid department ID in room name.' };
    }

    if (user.role === 'ADMIN' || user.role === 'SUPERVISOR') {
      return { allowed: true };
    }

    if (user.role === 'DOCTOR') {
      if (Array.isArray(user.departmentIds) && user.departmentIds.includes(departmentId)) {
        return { allowed: true };
      }

      // Double-check DB in case doctor was recently assigned to this department
      const { rowCount } = await pool.query(
        `SELECT 1
         FROM doctor_departments
         WHERE doctor_id = $1
           AND department_id = $2
           AND is_active = TRUE
         LIMIT 1`,
        [user.userId, departmentId]
      );

      if (rowCount > 0) {
        if (!user.departmentIds.includes(departmentId)) {
          user.departmentIds.push(departmentId);
        }
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Doctor is not an active member of department ${departmentId}.`,
      };
    }

    return { allowed: false, reason: 'Patients cannot subscribe to department broadcast channels.' };
  }

  // 6. Doctor-Patient chat & call room: conv:{conversationId}
  if (prefix === 'conv' && parts.length === 2) {
    const conversationId = Number(parts[1]);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return { allowed: false, reason: 'Invalid conversation ID.' };
    }

    const { rows } = await pool.query(
      `SELECT conversation_id, patient_id, doctor_id, status
       FROM chat_conversations
       WHERE conversation_id = $1
       LIMIT 1`,
      [conversationId]
    );

    if (rows.length === 0) {
      return { allowed: false, reason: 'Conversation does not exist.' };
    }

    const conv = rows[0];
    if (
      Number(conv.patient_id) === user.userId ||
      Number(conv.doctor_id) === user.userId ||
      user.role === 'ADMIN'
    ) {
      return { allowed: true };
    }

    return { allowed: false, reason: 'User is not a participant in this conversation.' };
  }

  // 7. Admin live hospital metrics room: admin:dashboard
  if (room === 'admin:dashboard') {
    if (user.role === 'ADMIN') {
      return { allowed: true };
    }
    return { allowed: false, reason: 'Only ADMIN users can join admin:dashboard.' };
  }

  return { allowed: false, reason: `Unknown or unsupported room pattern '${room}'.` };
}

/**
 * Initializes the Socket.io server on the `/realtime` namespace and attaches
 * JWT handshake authentication and room authorization handlers (§5.1–§5.3).
 *
 * @param {import('node:http').Server} httpServer
 * @returns {import('socket.io').Namespace}
 */
export function initSocketGateway(httpServer) {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : '*';

  ioInstance = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  realtimeNamespace = ioInstance.of('/realtime');

  // Handshake JWT authentication middleware
  realtimeNamespace.use(async (socket, next) => {
    try {
      const authToken =
        (typeof socket.handshake.auth?.token === 'string' && socket.handshake.auth.token.trim()) ||
        extractBearerToken(socket.handshake.headers?.authorization);

      if (!authToken) {
        const err = new Error('AUTHENTICATION_REQUIRED: Missing JWT token in handshake.');
        err.data = { code: 'AUTHENTICATION_REQUIRED' };
        return next(err);
      }

      const rawToken = authToken.toLowerCase().startsWith('bearer ')
        ? extractBearerToken(authToken)
        : authToken;

      const userContext = await verifyAndLoadUserContext(rawToken);
      socket.user = userContext;
      return next();
    } catch (err) {
      const authErr = new Error(err.message || 'Socket authentication failed.');
      authErr.data = {
        code: err.code || 'SOCKET_AUTH_FAILED',
        statusCode: err.statusCode || 401,
      };
      return next(authErr);
    }
  });

  realtimeNamespace.on('connection', async (socket) => {
    const user = socket.user;

    // 1. Auto-join personal room
    const personalRoom = `user:${user.userId}`;
    await socket.join(personalRoom);

    // 2. Auto-join active department rooms for DOCTOR
    if (user.role === 'DOCTOR' && Array.isArray(user.departmentIds)) {
      for (const deptId of user.departmentIds) {
        await socket.join(`dept:${deptId}`);
      }
    }

    // 3. Auto-join admin:dashboard for ADMIN
    if (user.role === 'ADMIN') {
      await socket.join('admin:dashboard');
    }

    // Client -> Server: room.subscribe
    socket.on('room.subscribe', async (payload, ack) => {
      try {
        const room = typeof payload?.room === 'string' ? payload.room.trim() : '';
        const check = await canJoinRoom(socket, room);

        if (!check.allowed) {
          if (typeof ack === 'function') {
            ack({ ok: false, code: 'ROOM_FORBIDDEN', message: check.reason, room });
          }
          return;
        }

        await socket.join(room);
        if (typeof ack === 'function') {
          ack({ ok: true, room });
        }
      } catch (err) {
        if (typeof ack === 'function') {
          ack({
            ok: false,
            code: 'ROOM_SUBSCRIBE_ERROR',
            message: err.message || 'Failed to subscribe to room.',
          });
        }
      }
    });

    // Client -> Server: room.unsubscribe
    socket.on('room.unsubscribe', async (payload, ack) => {
      try {
        const room = typeof payload?.room === 'string' ? payload.room.trim() : '';
        if (!room || room === `user:${user.userId}`) {
          if (typeof ack === 'function') {
            ack({
              ok: false,
              code: 'CANNOT_LEAVE_PERSONAL_ROOM',
              message: 'Cannot unsubscribe from personal user channel.',
            });
          }
          return;
        }

        await socket.leave(room);
        if (typeof ack === 'function') {
          ack({ ok: true, room });
        }
      } catch (err) {
        if (typeof ack === 'function') {
          ack({
            ok: false,
            code: 'ROOM_UNSUBSCRIBE_ERROR',
            message: err.message || 'Failed to unsubscribe from room.',
          });
        }
      }
    });

    // Client -> Server: chat.typing (§5.3)
    socket.on('chat.typing', async (payload, ack) => {
      try {
        const conversationId = Number(payload?.conversationId);
        const isTyping = Boolean(payload?.isTyping);

        if (!Number.isInteger(conversationId) || conversationId <= 0) {
          if (typeof ack === 'function') {
            ack({ ok: false, code: 'INVALID_CONVERSATION_ID' });
          }
          return;
        }

        const room = `conv:${conversationId}`;
        if (!socket.rooms.has(room)) {
          const check = await canJoinRoom(socket, room);
          if (!check.allowed) {
            if (typeof ack === 'function') {
              ack({ ok: false, code: 'FORBIDDEN_CONVERSATION', message: check.reason });
            }
            return;
          }
          await socket.join(room);
        }

        socket.to(room).emit('chat.typing', {
          eventId: `evt_${crypto.randomUUID()}`,
          eventType: 'chat.typing',
          occurredAt: new Date().toISOString(),
          data: {
            conversationId,
            userId: user.userId,
            fullName: user.fullName,
            role: user.role,
            isTyping,
          },
        });

        if (typeof ack === 'function') {
          ack({ ok: true });
        }
      } catch (err) {
        if (typeof ack === 'function') {
          ack({ ok: false, code: 'TYPING_EVENT_ERROR', message: err.message });
        }
      }
    });

    // Client -> Server: call.signal (§5.3)
    socket.on('call.signal', async (payload, ack) => {
      try {
        const callId = Number(payload?.callId);
        const conversationId = Number(payload?.conversationId);
        const signalType = String(payload?.signalType || '').toUpperCase();
        const sdpOrCandidate = payload?.sdpOrCandidate ?? null;

        const validSignals = ['RINGING', 'ANSWER', 'DECLINE', 'HANGUP', 'ICE_CANDIDATE'];
        if (
          !Number.isInteger(callId) ||
          callId <= 0 ||
          !Number.isInteger(conversationId) ||
          conversationId <= 0 ||
          !validSignals.includes(signalType)
        ) {
          if (typeof ack === 'function') {
            ack({
              ok: false,
              code: 'INVALID_CALL_SIGNAL',
              message: 'Valid callId, conversationId, and signalType are required.',
            });
          }
          return;
        }

        const { rows } = await pool.query(
          `SELECT call_id, conversation_id, initiator_id, callee_id, status, answered_at
           FROM call_logs
           WHERE call_id = $1
             AND conversation_id = $2
           LIMIT 1`,
          [callId, conversationId]
        );

        if (rows.length === 0) {
          if (typeof ack === 'function') {
            ack({ ok: false, code: 'CALL_NOT_FOUND', message: 'Call log record not found.' });
          }
          return;
        }

        const callRecord = rows[0];
        const callerId = Number(callRecord.initiator_id);
        const calleeId = Number(callRecord.callee_id);

        if (user.userId !== callerId && user.userId !== calleeId) {
          if (typeof ack === 'function') {
            ack({ ok: false, code: 'CALL_FORBIDDEN', message: 'User is not a participant in this call.' });
          }
          return;
        }

        // Persist state transitions on call_logs when RINGING, ANSWER, DECLINE, or HANGUP occurs
        if (signalType === 'RINGING' && callRecord.status === 'INITIATED') {
          await pool.query(
            `UPDATE call_logs SET status = 'RINGING' WHERE call_id = $1`,
            [callId]
          );
        } else if (signalType === 'ANSWER' && ['INITIATED', 'RINGING'].includes(callRecord.status)) {
          await pool.query(
            `UPDATE call_logs
             SET status = 'ANSWERED',
                 answered_at = COALESCE(answered_at, now())
             WHERE call_id = $1`,
            [callId]
          );
        } else if (signalType === 'DECLINE' && ['INITIATED', 'RINGING'].includes(callRecord.status)) {
          await pool.query(
            `UPDATE call_logs
             SET status = 'DECLINED',
                 ended_at = now()
             WHERE call_id = $1`,
            [callId]
          );
        } else if (signalType === 'HANGUP' && ['INITIATED', 'RINGING', 'ANSWERED'].includes(callRecord.status)) {
          await pool.query(
            `UPDATE call_logs
             SET status = CASE WHEN status IN ('INITIATED', 'RINGING') THEN 'MISSED'::call_status ELSE 'ENDED'::call_status END,
                 ended_at = now()
             WHERE call_id = $1`,
            [callId]
          );
        }

        const peerUserId = user.userId === callerId ? calleeId : callerId;
        const envelope = {
          eventId: `evt_${crypto.randomUUID()}`,
          eventType: 'call.signal',
          occurredAt: new Date().toISOString(),
          data: {
            callId,
            conversationId,
            fromUserId: user.userId,
            toUserId: peerUserId,
            signalType,
            sdpOrCandidate,
          },
        };

        socket.to(`conv:${conversationId}`).to(`user:${peerUserId}`).emit('call.signal', envelope);

        if (typeof ack === 'function') {
          ack({ ok: true, callId, signalType });
        }
      } catch (err) {
        if (typeof ack === 'function') {
          ack({ ok: false, code: 'CALL_SIGNAL_ERROR', message: err.message });
        }
      }
    });
  });

  return realtimeNamespace;
}

/**
 * Returns the initialized `/realtime` Socket.io namespace (or `null` if not yet initialized).
 *
 * @returns {import('socket.io').Namespace | null}
 */
export function getRealtimeNamespace() {
  return realtimeNamespace;
}

/**
 * Builds the standardized real-time Socket.io event envelope (§5.2) and emits it to one or more rooms.
 *
 * @param {string | string[]} rooms - Single room name or array of room names
 * @param {string} eventType - Event name (e.g. 'case.pool.added', 'exam.slot.updated')
 * @param {Record<string, any>} data - Event data payload
 */
export function emitToRooms(rooms, eventType, data) {
  if (!realtimeNamespace) {
    return;
  }

  const roomList = (Array.isArray(rooms) ? rooms : [rooms]).filter(
    (r) => typeof r === 'string' && r.trim().length > 0
  );

  if (roomList.length === 0) {
    return;
  }

  const nowIso = new Date().toISOString();
  const envelope = {
    event: eventType,
    eventType,
    eventId: crypto.randomUUID(),
    timestamp: nowIso,
    occurredAt: nowIso,
    data,
  };

  let broadcaster = realtimeNamespace;
  for (const room of roomList) {
    broadcaster = broadcaster.to(room);
  }
  broadcaster.emit(eventType, envelope);
}

/**
 * Emits a standardized real-time event directly to a specific user's personal room (`user:{userId}`).
 *
 * @param {number} userId
 * @param {string} eventType
 * @param {Record<string, any>} data
 */
export function emitToUser(userId, eventType, data) {
  if (!userId) return;
  emitToRooms(`user:${userId}`, eventType, data);
}

/**
 * Checks whether a given `userId` currently has at least one active socket joined to `room`.
 * Used for smart notification suppression when a user is actively viewing a conversation room.
 *
 * @param {number} userId
 * @param {string} room
 * @returns {boolean}
 */
export function isUserPresentInRoom(userId, room) {
  if (!realtimeNamespace) {
    return false;
  }

  const roomSockets = realtimeNamespace.adapter.rooms.get(room);
  if (!roomSockets || roomSockets.size === 0) {
    return false;
  }

  for (const socketId of roomSockets) {
    const socket = realtimeNamespace.sockets.get(socketId);
    if (socket?.user?.userId === Number(userId)) {
      return true;
    }
  }

  return false;
}

/**
 * Gracefully closes the Socket.io server during shutdown.
 *
 * @returns {Promise<void>}
 */
export async function closeSocketGateway() {
  if (!ioInstance) {
    return;
  }
  await new Promise((resolve) => {
    ioInstance.close(() => resolve());
  });
  ioInstance = null;
  realtimeNamespace = null;
}
