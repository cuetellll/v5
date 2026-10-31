import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import { Prisma, PrismaClient } from '@prisma/client';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import bcrypt from 'bcrypt';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';

const prisma = new PrismaClient();
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const allowedOrigin = process.env.CORS_ORIGIN || false;
const io = new SocketIOServer(server, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
  pingInterval: 10000,
  pingTimeout: 20000
});

type AuthedRequest = Request & { userId?: string };
const secret = process.env.JWT_ACCESS_SECRET;
if (process.env.NODE_ENV === 'production' && (!secret || secret.length < 32)) {
  throw new Error('JWT_ACCESS_SECRET must contain at least 32 characters in production');
}
const jwtSecret = secret || 'local-development-only-secret-change-before-deploy';
const issueToken = (userId: string) => jwt.sign({}, jwtSecret, { subject: userId, expiresIn: '30m' });

app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net', 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'", 'blob:', 'https:'],
  connectSrc: ["'self'", 'https:', 'wss:'],
  objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"]
} } }));
app.use(compression());
app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: '256kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false }));
app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/tables/', rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false }));

function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, jwtSecret) as JwtPayload;
    if (typeof decoded.sub !== 'string') throw new Error('Missing subject');
    req.userId = decoded.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}

function toCamel(value: string) { return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()); }
function toSnake(value: string) { return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function serialize(table: string, row: any): any {
  if (!row) return row;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'passwordHash' || key === 'refreshToken' || key === 'email') continue;
    if (key === 'permissions' && table === 'roles') out.permissions = (value as any[]).map((p) => p.node);
    else if (key === 'roles' && table === 'server_members') out.role_ids = (value as any[]).map((r) => r.id);
    else out[toSnake(key)] = value;
  }
  if (row.createdAt) out.created_iso = row.createdAt.toISOString();
  if (row.createdAt && table !== 'users') out.timestamp_iso = row.createdAt.toISOString();
  if (row.joinedAt) out.joined_iso = row.joinedAt.toISOString();
  if (table === 'users') {
    out.display_name = row.displayName;
    out.avatar_color = row.avatarColor;
    if (row.status) out.status = String(row.status).toLowerCase();
  }
  if (table === 'servers') {
    out.owner_id = row.ownerId;
    out.invite_code = row.inviteCode;
    out.icon_text = row.iconText;
    out.icon_color = row.iconColor;
  }
  if (table === 'channels') { out.server_id = row.serverId; if (row.type) out.type = String(row.type).toLowerCase(); }
  if (table === 'friends' && row.status) out.status = String(row.status).toLowerCase();
  if (table === 'messages') {
    out.channel_id = row.channelId; out.server_id = row.channel?.serverId;
    out.user_id = row.userId; out.reply_to_id = row.replyToId;
    out.attachments_json = row.attachmentsJson || '[]'; out.reactions_json = row.reactionsJson || '{}';
    out.author = row.author ? serialize('users', row.author) : undefined;
  }
  if (table === 'direct_messages') {
    out.conversation_id = row.conversationId; out.participant_ids = row.participantIds;
    out.sender_id = row.senderId; out.reply_to_id = row.replyToId;
    out.group_name = row.groupName; out.is_group = row.isGroup;
    out.attachments_json = row.attachmentsJson || '[]'; out.reactions_json = row.reactionsJson || '{}';
    out.author = row.sender ? serialize('users', row.sender) : undefined;
  }
  if (table === 'server_members') { out.server_id = row.serverId; out.user_id = row.userId; out.joined_at = row.joinedAt; }
  if (table === 'voice_sessions') { out.channel_id = row.channelId; out.user_id = row.userId; out.server_id = row.channel?.serverId; }
  if (table === 'audit_logs') { out.server_id = row.serverId; out.actor_id = row.actorId; }
  return out;
}

const tableModels: Record<string, { delegate: any; allowed: string[] }> = {
  users: { delegate: prisma.user, allowed: ['displayName', 'avatarUrl', 'avatarColor', 'bannerColor', 'status', 'customStatus', 'bio'] },
  servers: { delegate: prisma.server, allowed: ['name', 'description', 'iconUrl', 'iconText', 'iconColor', 'ownerId', 'inviteCode', 'region', 'verificationLevel'] },
  roles: { delegate: prisma.role, allowed: ['serverId', 'name', 'color', 'position', 'hoist'] },
  server_members: { delegate: prisma.serverMember, allowed: ['serverId', 'userId', 'nickname'] },
  channels: { delegate: prisma.channel, allowed: ['serverId', 'name', 'category', 'type', 'topic', 'position', 'slowmode', 'isPrivate'] },
  messages: { delegate: prisma.message, allowed: ['channelId', 'userId', 'content', 'replyToId', 'attachmentsJson', 'reactionsJson', 'pinned', 'edited', 'threadName'] },
  direct_messages: { delegate: prisma.directMessage, allowed: ['conversationId', 'participantIds', 'senderId', 'content', 'replyToId', 'attachmentsJson', 'reactionsJson', 'isGroup', 'groupName', 'pinned', 'edited'] },
  friends: { delegate: prisma.friend, allowed: ['userId', 'friendId', 'status'] },
  voice_sessions: { delegate: prisma.voiceSession, allowed: ['channelId', 'userId', 'muted', 'deafened', 'videoEnabled', 'screenSharing'] },
  audit_logs: { delegate: prisma.auditLog, allowed: ['serverId', 'actorId', 'actionType', 'targetName', 'details'] },
  notifications: { delegate: prisma.notification, allowed: ['userId', 'title', 'body', 'type', 'read'] }
};
const tableOrderFields: Record<string, 'createdAt' | 'joinedAt'> = {
  users: 'createdAt', servers: 'createdAt', roles: 'createdAt', server_members: 'joinedAt',
  channels: 'createdAt', messages: 'createdAt', direct_messages: 'createdAt', friends: 'createdAt',
  voice_sessions: 'joinedAt', audit_logs: 'createdAt', notifications: 'createdAt'
};

function cleanData(table: string, input: Record<string, any>) {
  const allowed = tableModels[table].allowed;
  const data: Record<string, any> = {};
  for (const [key, value] of Object.entries(input || {})) {
    const field = toCamel(key);
    if (allowed.includes(field) && value !== undefined) data[field] = value;
  }
  if (table === 'channels' && data.type) data.type = String(data.type).toUpperCase();
  if (table === 'friends' && data.status) data.status = String(data.status).toUpperCase();
  if (table === 'users' && data.status) data.status = String(data.status).toUpperCase();
  if (table === 'messages' || table === 'direct_messages') {
    for (const key of ['attachmentsJson', 'reactionsJson']) {
      const legacy = input?.[toSnake(key)];
      if (typeof legacy === 'string') data[key] = legacy;
    }
  }
  if ((table === 'messages' || table === 'direct_messages') && typeof data.content === 'string' && (data.content.length === 0 || data.content.length > 8000)) {
    throw Object.assign(new Error('Message content must be between 1 and 8000 characters'), { status: 400 });
  }
  if (table === 'messages' || table === 'direct_messages') data.attachmentsJson = '[]';
  if (table === 'messages' || table === 'direct_messages') {
    try {
      const reactions = JSON.parse(data.reactionsJson || '{}');
      const allowed = new Set(['🚀', '🔥', '👍', '❤️', '🎉', '⚡', '👀', '💯', '✅', '🎧', '🛡️', '💜']);
      if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions) || Object.keys(reactions).some((key) => !allowed.has(key) || !Array.isArray(reactions[key]) || reactions[key].some((id: any) => typeof id !== 'string' || id.length > 64))) throw new Error('bad reactions');
      data.reactionsJson = JSON.stringify(reactions);
    } catch { throw Object.assign(new Error('Invalid reaction payload'), { status: 400 }); }
  }
  if (table === 'direct_messages' && Array.isArray(input?.participant_ids)) data.participantIds = input.participant_ids.map(String);
  return data;
}

async function serverPermission(userId: string, serverId: string, permission: string): Promise<boolean> {
  const row = await prisma.server.findUnique({ where: { id: serverId }, include: { members: { where: { userId }, include: { roles: { include: { permissions: true } } } }, roles: { where: { name: '@everyone' }, include: { permissions: true } } } });
  if (!row) return false;
  if (row.ownerId === userId) return true;
  const member = row.members[0];
  if (!member) return false;
  return [...member.roles, ...row.roles].some((role) => role.permissions.some((p) => p.node === 'ADMINISTRATOR' || p.node === permission));
}
async function requireServerPermission(userId: string, serverId: string, permission: string) {
  if (!await serverPermission(userId, serverId, permission)) throw Object.assign(new Error(`Missing ${permission} permission`), { status: 403 });
}
async function hasBlockedConversationPair(userId: string, participantIds: string[]) {
  const others = participantIds.filter((id) => id !== userId);
  if (!others.length) return false;
  return Boolean(await prisma.friend.findFirst({ where: { status: 'BLOCKED', OR: [
    { userId, friendId: { in: others } }, { friendId: userId, userId: { in: others } }
  ] }, select: { id: true } }));
}
async function refreshMemberVoicePermissions(serverId: string, userId: string) {
  const channels = await prisma.channel.findMany({ where: { serverId }, select: { id: true, type: true } });
  const voiceChannels = channels.filter((channel) => channel.type === 'VOICE');
  const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  let livekitUrl = process.env.LIVEKIT_URL;
  if (livekitUrl && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
    livekitUrl = livekitUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const rooms = new RoomServiceClient(livekitUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await Promise.allSettled(voiceChannels.map((channel) => rooms.removeParticipant(channel.id, userId, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) })));
  }
  const staleSessions = await prisma.voiceSession.findMany({ where: { userId, channelId: { in: channels.map((channel) => channel.id) } }, select: { id: true, channelId: true } });
  await prisma.voiceSession.deleteMany({ where: { id: { in: staleSessions.map((session) => session.id) } } });
  for (const session of staleSessions) io.to(`channel:${session.channelId}`).emit('voice:updated', { channel_id: session.channelId, user_id: userId, removed: true });
  io.to(`user:${userId}`).emit('server:permissions_changed', { server_id: serverId });
}
async function revokeServerMember(serverId: string, userId: string) {
  const channels = await prisma.channel.findMany({ where: { serverId }, select: { id: true } });
  await refreshMemberVoicePermissions(serverId, userId);
  const userSockets = await io.in(`user:${userId}`).fetchSockets();
  for (const socket of userSockets) {
    for (const channel of channels) await socket.leave(`channel:${channel.id}`);
    socket.emit('server:membership_revoked', { server_id: serverId });
  }
}
async function channelContext(channelId: string) {
  return prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, type: true } });
}
async function checkTableAccess(table: string, userId: string, row: any, operation: 'read' | 'write' | 'delete') {
  if (table === 'users') return operation === 'read' || row?.id === userId;
  if (table === 'servers') return operation === 'read' ? serverPermission(userId, row.id, 'VIEW_CHANNELS') : row.ownerId === userId || serverPermission(userId, row.id, 'MANAGE_SERVER');
  if (table === 'roles') return serverPermission(userId, row.serverId, operation === 'read' ? 'VIEW_CHANNELS' : 'MANAGE_ROLES');
  if (table === 'channels') return serverPermission(userId, row.serverId, operation === 'read' ? 'VIEW_CHANNELS' : 'MANAGE_CHANNELS');
  if (table === 'server_members') return serverPermission(userId, row.serverId, operation === 'read' ? 'VIEW_CHANNELS' : (row.userId === userId ? 'VIEW_CHANNELS' : 'KICK_MEMBERS'));
  if (table === 'messages') {
    const ctx = row.channelId ? await channelContext(row.channelId) : await prisma.message.findUnique({ where: { id: row.id }, select: { channel: { select: { serverId: true } } } }).then((m) => m?.channel);
    if (!ctx) return false;
    if (operation === 'read') return serverPermission(userId, ctx.serverId, 'VIEW_CHANNELS');
    if (operation === 'write') return serverPermission(userId, ctx.serverId, 'SEND_MESSAGES');
    return row.userId === userId || serverPermission(userId, ctx.serverId, 'MANAGE_MESSAGES');
  }
  if (table === 'direct_messages') return Array.isArray(row.participantIds) && row.participantIds.includes(userId) && (operation === 'read' || row.senderId === userId);
  if (table === 'friends') return row.userId === userId || row.friendId === userId;
  if (table === 'voice_sessions') {
    const ctx = await channelContext(row.channelId);
    if (!ctx) return false;
    const permitted = await serverPermission(userId, ctx.serverId, operation === 'read' ? 'VIEW_CHANNELS' : 'CONNECT_VOICE');
    if (!permitted) return false;
    if (operation === 'write' && row.userId !== userId && !await serverPermission(userId, ctx.serverId, 'MOVE_MEMBERS')) return false;
    return operation !== 'delete' || row.userId === userId || await serverPermission(userId, ctx.serverId, 'KICK_MEMBERS');
  }
  if (table === 'audit_logs') return serverPermission(userId, row.serverId, 'VIEW_AUDIT_LOG');
  if (table === 'notifications') return row.userId === userId;
  return false;
}

const registerSchema = z.object({ username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/), display_name: z.string().trim().min(1).max(64), email: z.string().email().max(254), password: z.string().min(12).max(128) });
app.post('/auth/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const user = await prisma.user.create({ data: { username: input.username.toLowerCase(), displayName: input.display_name, email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, Number(process.env.BCRYPT_ROUNDS) || 12) } });
    res.status(201).json({ accessToken: issueToken(user.id), user: serialize('users', user) });
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'Email or username is already registered' });
    next(error);
  }
});
app.post('/auth/login', async (req, res, next) => {
  try {
    const schema = z.object({ email: z.string().email(), password: z.string().min(1).max(128) });
    const input = schema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !await bcrypt.compare(input.password, user.passwordHash)) return res.status(401).json({ error: 'Invalid email or password' });
    return res.json({ accessToken: issueToken(user.id), user: serialize('users', user) });
  } catch (error) { return next(error); }
});
app.get('/auth/me', auth, async (req: AuthedRequest, res, next) => {
  try { const user = await prisma.user.findUnique({ where: { id: req.userId } }); if (!user) return res.status(401).json({ error: 'Account no longer exists' }); return res.json({ user: serialize('users', user) }); }
  catch (error) { return next(error); }
});

app.get('/api/health', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ok', service: 'pulsecord-api', connectedSockets: io.engine.clientsCount, uptimeSeconds: Math.round(process.uptime()) }); }
  catch { res.status(503).json({ status: 'degraded', error: 'Database connectivity check failed' }); }
});

app.get('/api/invites/:code', auth, async (req: AuthedRequest, res, next) => {
  try {
    const server = await prisma.server.findUnique({ where: { inviteCode: req.params.code } });
    if (!server) return res.status(404).json({ error: 'Invite not found' });
    if (await prisma.ban.findUnique({ where: { serverId_userId: { serverId: server.id, userId: req.userId! } } })) return res.status(403).json({ error: 'You are banned from this server' });
    return res.json({ id: server.id, name: server.name, description: server.description, invite_code: server.inviteCode });
  } catch (error) { return next(error); }
});
app.post('/api/servers/join', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(3).max(64) }).parse(req.body);
    const server = await prisma.server.findUnique({ where: { inviteCode: code } });
    if (!server) return res.status(404).json({ error: 'Invite not found' });
    if (await prisma.ban.findUnique({ where: { serverId_userId: { serverId: server.id, userId: req.userId! } } })) return res.status(403).json({ error: 'You are banned from this server' });
    const member = await prisma.serverMember.upsert({ where: { serverId_userId: { serverId: server.id, userId: req.userId! } }, update: {}, create: { serverId: server.id, userId: req.userId! } });
    return res.json({ server: { id: server.id, name: server.name, invite_code: server.inviteCode }, member: serialize('server_members', member) });
  } catch (error) { return next(error); }
});
app.post('/api/servers/:serverId/bans', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { userId, reason } = z.object({ userId: z.string().min(1).max(64), reason: z.string().max(500).optional() }).parse(req.body);
    const server = await prisma.server.findUnique({ where: { id: req.params.serverId } });
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.ownerId === userId) return res.status(400).json({ error: 'The server owner cannot be banned' });
    await requireServerPermission(req.userId!, server.id, 'BAN_MEMBERS');
    const ban = await prisma.$transaction(async (tx) => {
      await tx.serverMember.deleteMany({ where: { serverId: server.id, userId } });
      const created = await tx.ban.upsert({ where: { serverId_userId: { serverId: server.id, userId } }, update: { reason }, create: { serverId: server.id, userId, reason } });
      await tx.auditLog.create({ data: { serverId: server.id, actorId: req.userId!, actionType: 'MEMBER_BAN', targetName: userId, details: reason || 'Banned member' } });
      return created;
    });
    await revokeServerMember(server.id, userId);
    return res.status(201).json({ id: ban.id, server_id: ban.serverId, user_id: ban.userId });
  } catch (error) { return next(error); }
});

app.get('/tables/:table', auth, async (req: AuthedRequest, res, next) => {
  try {
    const { table } = req.params; const model = tableModels[table];
    if (!model) return res.status(404).json({ error: 'Unknown resource' });
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
    const page = Math.max(1, Number(req.query.page) || 1);
    const where: any = {};
    if (table === 'users') { /* public profile directory; serializer omits credentials */ }
    else if (table === 'servers') where.OR = [{ ownerId: req.userId }, { members: { some: { userId: req.userId } } }];
    else if (table === 'roles' || table === 'channels' || table === 'server_members' || table === 'audit_logs') where.server = { members: { some: { userId: req.userId } } };
    else if (table === 'messages') where.channel = { server: { members: { some: { userId: req.userId } } } };
    else if (table === 'direct_messages') where.participantIds = { has: req.userId };
    else if (table === 'friends') where.OR = [{ userId: req.userId }, { friendId: req.userId }];
    else if (table === 'voice_sessions') where.channel = { server: { members: { some: { userId: req.userId } } } };
    else if (table === 'notifications') where.userId = req.userId;
    const include: any = table === 'roles' ? { permissions: true } : table === 'server_members' ? { roles: true } : table === 'messages' ? { author: true, channel: true } : table === 'direct_messages' ? { sender: true } : table === 'voice_sessions' ? { channel: true } : undefined;
    const orderByField = tableOrderFields[table];
    const rows = await model.delegate.findMany({ where, include, orderBy: { [orderByField]: 'desc' }, take: limit, skip: (page - 1) * limit });
    const visible = [];
    for (const row of rows) if (await checkTableAccess(table, req.userId!, row, 'read')) visible.push(serialize(table, row));
    return res.json({ data: visible, page, limit });
  } catch (error) { return next(error); }
});
app.get('/tables/:table/:id', auth, async (req: AuthedRequest, res, next) => {
  try {
    const model = tableModels[req.params.table]; if (!model) return res.status(404).json({ error: 'Unknown resource' });
    const include: any = req.params.table === 'roles' ? { permissions: true } : req.params.table === 'server_members' ? { roles: true } : req.params.table === 'messages' ? { author: true, channel: true } : req.params.table === 'direct_messages' ? { sender: true } : undefined;
    const row = await model.delegate.findUnique({ where: { id: req.params.id }, include });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!await checkTableAccess(req.params.table, req.userId!, row, 'read')) return res.status(403).json({ error: 'Forbidden' });
    return res.json(serialize(req.params.table, row));
  } catch (error) { return next(error); }
});
app.post('/tables/:table', auth, async (req: AuthedRequest, res, next) => {
  try {
    const table = req.params.table; const model = tableModels[table];
    if (!model || table === 'users') return res.status(404).json({ error: 'Unknown or restricted resource' });
    const data = cleanData(table, req.body);
    if (table === 'messages') {
      const channel = await channelContext(String(data.channelId || ''));
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      await requireServerPermission(req.userId!, channel.serverId, 'SEND_MESSAGES');
      data.userId = req.userId; data.channelId = channel.id;
      if (req.body.reply_to_id) data.replyToId = String(req.body.reply_to_id);
    } else if (table === 'servers') {
      data.ownerId = req.userId; data.inviteCode = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    } else if (table === 'channels' || table === 'roles') {
      if (table === 'roles' && String(data.name || '').trim().toLowerCase() === '@everyone') return res.status(400).json({ error: 'The @everyone role name is reserved' });
      if (table === 'channels' && req.body.is_private === true) return res.status(501).json({ error: 'Private channel permissions are not implemented' });
      await requireServerPermission(req.userId!, String(data.serverId), table === 'channels' ? 'MANAGE_CHANNELS' : 'MANAGE_ROLES');
    } else if (table === 'server_members') {
      const server = await prisma.server.findUnique({ where: { id: String(data.serverId) } });
      if (!server) return res.status(404).json({ error: 'Server not found' });
      if (data.userId !== req.userId) await requireServerPermission(req.userId!, server.id, 'MANAGE_SERVER');
      else if (req.body.invite_code !== server.inviteCode && server.ownerId !== req.userId) return res.status(403).json({ error: 'A valid invite code is required' });
      data.userId = data.userId === req.userId ? req.userId : data.userId;
    } else if (table === 'direct_messages') {
      const participants = Array.isArray(req.body.participant_ids) ? req.body.participant_ids.map(String) : [];
      const uniqueParticipants: string[] = [...new Set<string>(participants)];
      if (!uniqueParticipants.includes(req.userId!) || uniqueParticipants.length < 2 || uniqueParticipants.length > 50) return res.status(403).json({ error: 'Conversation must include the sender and 1-49 other users' });
      if (Boolean(data.isGroup) !== (uniqueParticipants.length > 2)) return res.status(400).json({ error: 'Group status must match the participant count' });
      if (await hasBlockedConversationPair(req.userId!, uniqueParticipants)) return res.status(403).json({ error: 'A blocked relationship prevents this direct message' });
      const existingUsers = await prisma.user.findMany({ where: { id: { in: uniqueParticipants } }, select: { id: true } });
      if (existingUsers.length !== uniqueParticipants.length) return res.status(400).json({ error: 'A conversation participant does not exist' });
      const conversationId = String(data.conversationId || '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return res.status(400).json({ error: 'Invalid conversation id' });
      const priorMessage = await prisma.directMessage.findFirst({ where: { conversationId }, select: { participantIds: true } });
      if (priorMessage) {
        const original = [...priorMessage.participantIds].sort();
        const incoming = [...uniqueParticipants].sort();
        if (original.length !== incoming.length || original.some((id, index) => id !== incoming[index])) return res.status(409).json({ error: 'Conversation participants cannot be changed' });
      }
      data.participantIds = uniqueParticipants; data.senderId = req.userId;
    } else if (table === 'friends') {
      if (data.userId !== req.userId) return res.status(403).json({ error: 'Friend request must be created by the current user' });
      if (!data.friendId || data.friendId === req.userId || !await prisma.user.findUnique({ where: { id: String(data.friendId) }, select: { id: true } })) return res.status(400).json({ error: 'Invalid friend target' });
      data.status = 'PENDING';
    } else if (table === 'voice_sessions') {
      const channel = await channelContext(String(data.channelId || ''));
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      await requireServerPermission(req.userId!, channel.serverId, 'CONNECT_VOICE'); data.userId = req.userId;
    } else if (table === 'audit_logs') {
      await requireServerPermission(req.userId!, String(data.serverId), 'MANAGE_SERVER'); data.actorId = req.userId;
    } else if (table === 'notifications') return res.status(403).json({ error: 'Notifications are system-managed' });
    if (req.body.id) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(req.body.id))) return res.status(400).json({ error: 'Invalid identifier' });
      data.id = String(req.body.id);
    }
    if (table === 'roles' && Array.isArray(req.body.permissions)) {
      const nodes = req.body.permissions.map(String);
      const known = new Set(['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'STREAM_VIDEO', 'VIEW_CHANNELS', 'VIEW_AUDIT_LOG', 'MOVE_MEMBERS']);
      if (nodes.some((node: string) => !known.has(node))) return res.status(400).json({ error: 'Unknown permission node' });
      const owner = await prisma.server.findUnique({ where: { id: String(data.serverId) }, select: { ownerId: true } });
      const privileged = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MOVE_MEMBERS', 'VIEW_AUDIT_LOG', 'STREAM_VIDEO'];
      if (!owner || owner.ownerId !== req.userId && nodes.some((node: string) => privileged.includes(node))) return res.status(403).json({ error: 'Only the server owner may grant privileged permissions' });
      data.permissions = { create: nodes.map((node: string) => ({ node })) };
    }
    if (table === 'server_members' && Array.isArray(req.body.role_ids)) {
      const roleIds = req.body.role_ids.map(String);
      const server = await prisma.server.findUnique({ where: { id: String(data.serverId) }, select: { id: true, ownerId: true } });
      const mayAssign = data.userId !== req.userId || server?.ownerId === req.userId;
      if (!mayAssign && roleIds.length) return res.status(403).json({ error: 'Members cannot assign roles to themselves' });
      if (roleIds.length) {
        const matching = await prisma.role.findMany({ where: { id: { in: roleIds }, serverId: String(data.serverId) }, select: { id: true } });
        if (matching.length !== roleIds.length) return res.status(400).json({ error: 'A role does not belong to this server' });
        data.roles = { connect: roleIds.map((id: string) => ({ id })) };
      }
    }
    if (table === 'servers') {
      const created = await prisma.$transaction(async (tx) => {
        const server = await tx.server.create({ data: data as Prisma.ServerUncheckedCreateInput });
        await tx.role.create({ data: { serverId: server.id, name: '@everyone', color: '#99AAB5', position: 0, permissions: { create: ['VIEW_CHANNELS', 'SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE'].map((node) => ({ node })) } } });
        return server;
      });
      return res.status(201).json(serialize(table, created));
    }
    const row = await model.delegate.create({ data, include: table === 'roles' ? { permissions: true } : table === 'server_members' ? { roles: true } : table === 'messages' ? { author: true, channel: true } : undefined });
    const result = serialize(table, row);
    if (table === 'messages') io.to(`channel:${row.channelId}`).emit('message:new', result);
    if (table === 'voice_sessions') io.to(`channel:${row.channelId}`).emit('voice:updated', result);
    if (table === 'direct_messages') for (const participantId of row.participantIds) io.to(`user:${participantId}`).emit('direct_message:new', result);
    return res.status(201).json(result);
  } catch (error) { return next(error); }
});
app.patch('/tables/:table/:id', auth, async (req: AuthedRequest, res, next) => {
  try {
    const table = req.params.table; const model = tableModels[table];
    if (!model || table === 'users' && req.params.id !== req.userId) return res.status(404).json({ error: 'Unknown resource' });
    if (table === 'audit_logs') return res.status(403).json({ error: 'Audit log records are append-only' });
    const include: any = table === 'roles' ? { permissions: true } : table === 'server_members' ? { roles: true } : table === 'messages' ? { author: true, channel: true } : table === 'direct_messages' ? { sender: true } : undefined;
    const old = await model.delegate.findUnique({ where: { id: req.params.id }, include });
    if (!old) return res.status(404).json({ error: 'Not found' });
    if (table === 'channels' && req.body.is_private === true) return res.status(501).json({ error: 'Private channel permissions are not implemented' });
    if (table === 'server_members' && Array.isArray(req.body.role_ids)) {
      await requireServerPermission(req.userId!, old.serverId, 'MANAGE_ROLES');
      const server = await prisma.server.findUnique({ where: { id: old.serverId }, select: { ownerId: true } });
      if (old.userId === server?.ownerId) return res.status(403).json({ error: 'The server owner role assignment cannot be changed here' });
    } else if (!await checkTableAccess(table, req.userId!, old, 'write')) return res.status(403).json({ error: 'Forbidden' });
    if (table === 'direct_messages' && old.senderId === req.userId && await hasBlockedConversationPair(req.userId!, old.participantIds)) return res.status(403).json({ error: 'A blocked relationship prevents this direct message' });
    if (table === 'friends' && String(req.body.status || '').toLowerCase() === 'accepted' && old.friendId !== req.userId) return res.status(403).json({ error: 'Only the recipient may accept a friend request' });
    if (table === 'messages' && old.userId !== req.userId) {
      const serverId = old.channel.serverId; await requireServerPermission(req.userId!, serverId, 'MANAGE_MESSAGES');
    }
    const data = cleanData(table, req.body);
    for (const key of ['ownerId', 'userId', 'senderId', 'actorId', 'serverId', 'channelId', 'participantIds']) delete data[key];
    if (table === 'server_members' && Array.isArray(req.body.role_ids)) {
      const roleIds: string[] = [...new Set((req.body.role_ids as unknown[]).map(String))];
      const server = await prisma.server.findUnique({ where: { id: old.serverId }, select: { ownerId: true } });
      const roles = await prisma.role.findMany({ where: { id: { in: roleIds }, serverId: old.serverId }, select: { id: true } });
      const rolePermissions = await prisma.permission.findMany({ where: { roleId: { in: roleIds } }, select: { roleId: true, node: true } });
      if (roles.length !== roleIds.length) return res.status(400).json({ error: 'A role does not belong to this server' });
      const privileged = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MOVE_MEMBERS', 'VIEW_AUDIT_LOG', 'STREAM_VIDEO'];
      if (server?.ownerId !== req.userId && rolePermissions.some((permission) => roleIds.includes(permission.roleId) && privileged.includes(permission.node))) return res.status(403).json({ error: 'Only the server owner may assign privileged roles' });
      data.roles = { set: roleIds.map((id) => ({ id })) };
    }
    if (table === 'roles' && String(data.name || '').trim().toLowerCase() === '@everyone') return res.status(400).json({ error: 'The @everyone role name is reserved' });
    if (table === 'roles' && Array.isArray(req.body.permissions)) {
      const nodes = req.body.permissions.map(String);
      const known = new Set(['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'STREAM_VIDEO', 'VIEW_CHANNELS', 'VIEW_AUDIT_LOG', 'MOVE_MEMBERS']);
      if (nodes.some((node: string) => !known.has(node))) return res.status(400).json({ error: 'Unknown permission node' });
      const owner = await prisma.server.findUnique({ where: { id: old.serverId }, select: { ownerId: true } });
      const privileged = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MOVE_MEMBERS', 'VIEW_AUDIT_LOG', 'STREAM_VIDEO'];
      if (!owner || owner.ownerId !== req.userId && nodes.some((node: string) => privileged.includes(node))) return res.status(403).json({ error: 'Only the server owner may grant privileged permissions' });
      data.permissions = { deleteMany: {}, create: nodes.map((node: string) => ({ node })) };
    }
    const row = await model.delegate.update({ where: { id: req.params.id }, data, include });
    if (table === 'server_members' && Array.isArray(req.body.role_ids)) await refreshMemberVoicePermissions(row.serverId, row.userId);
    if (table === 'roles' && Array.isArray(req.body.permissions)) {
      const members = await prisma.serverMember.findMany({ where: { serverId: row.serverId, roles: { some: { id: row.id } } }, select: { userId: true } });
      await Promise.allSettled(members.map((member) => refreshMemberVoicePermissions(row.serverId, member.userId)));
    }
    if (table === 'voice_sessions') io.to(`channel:${row.channelId}`).emit('voice:updated', serialize(table, row));
    if (table === 'messages') io.to(`channel:${row.channelId}`).emit('message:updated', serialize(table, row));
    if (table === 'direct_messages') for (const participantId of row.participantIds) io.to(`user:${participantId}`).emit('direct_message:updated', serialize(table, row));
    return res.json(serialize(table, row));
  } catch (error) { return next(error); }
});
app.delete('/tables/:table/:id', auth, async (req: AuthedRequest, res, next) => {
  try {
    const table = req.params.table; const model = tableModels[table];
    if (!model || table === 'users') return res.status(404).json({ error: 'Unknown resource' });
    if (table === 'audit_logs') return res.status(403).json({ error: 'Audit log records are append-only' });
    const row = await model.delegate.findUnique({ where: { id: req.params.id }, include: table === 'messages' ? { channel: true } : undefined });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (table === 'roles' && row.name === '@everyone') return res.status(403).json({ error: 'The @everyone role cannot be deleted' });
    if (table === 'server_members' && row.userId === req.userId) {
      const server = await prisma.server.findUnique({ where: { id: row.serverId }, select: { ownerId: true } });
      if (server?.ownerId === req.userId) return res.status(403).json({ error: 'The server owner cannot leave without transferring ownership' });
    }
    if (!await checkTableAccess(table, req.userId!, row, 'delete')) return res.status(403).json({ error: 'Forbidden' });
    if (table === 'servers' && row.ownerId !== req.userId) return res.status(403).json({ error: 'Only the owner may delete a server' });
    if (table === 'channels') await requireServerPermission(req.userId!, row.serverId, 'MANAGE_CHANNELS');
    if (table === 'roles') await requireServerPermission(req.userId!, row.serverId, 'MANAGE_ROLES');
    const roleMembers = table === 'roles' ? await prisma.serverMember.findMany({ where: { serverId: row.serverId, roles: { some: { id: row.id } } }, select: { userId: true } }) : [];
    await model.delegate.delete({ where: { id: req.params.id } });
    if (table === 'roles') await Promise.allSettled(roleMembers.map((member) => refreshMemberVoicePermissions(row.serverId, member.userId)));
    if (table === 'server_members') await revokeServerMember(row.serverId, row.userId);
    if (table === 'voice_sessions') io.to(`channel:${row.channelId}`).emit('voice:updated', { channel_id: row.channelId, user_id: row.userId, removed: true });
    if (table === 'messages') io.to(`channel:${row.channelId}`).emit('message:deleted', { id: row.id, channel_id: row.channelId });
    if (table === 'direct_messages') for (const participantId of row.participantIds) io.to(`user:${participantId}`).emit('direct_message:deleted', { id: row.id, conversation_id: row.conversationId });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

app.post('/api/voice/token', auth, async (req: AuthedRequest, res, next) => {
  try {
    const input = z.object({ channelId: z.string().min(1) }).parse(req.body);
    const channel = await prisma.channel.findUnique({ where: { id: input.channelId }, include: { server: true } });
    if (!channel || channel.type !== 'VOICE') return res.status(404).json({ error: 'Voice channel not found' });
    await requireServerPermission(req.userId!, channel.serverId, 'CONNECT_VOICE');
    const canSpeak = await serverPermission(req.userId!, channel.serverId, 'SPEAK_VOICE');
    const canStream = await serverPermission(req.userId!, channel.serverId, 'STREAM_VIDEO');
    const apiKey = process.env.LIVEKIT_API_KEY?.trim();
    const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
    const rawUrl = process.env.LIVEKIT_URL?.trim();
    const missingVariables = [
      !rawUrl && 'LIVEKIT_URL',
      !apiKey && 'LIVEKIT_API_KEY',
      !apiSecret && 'LIVEKIT_API_SECRET'
    ].filter((name): name is string => Boolean(name));
    if (missingVariables.length) {
      console.error('[LiveKit] token configuration incomplete', { missingVariables });
      return res.status(503).json({ error: 'LiveKit service is not configured', code: 'LIVEKIT_CONFIG_MISSING', missingVariables });
    }

    let parsedUrl: URL;
    try { parsedUrl = new URL(rawUrl!); }
    catch { return res.status(503).json({ error: 'LIVEKIT_URL must be a valid LiveKit server URL', code: 'LIVEKIT_URL_INVALID' }); }
    const isSecure = parsedUrl.protocol === 'wss:' || parsedUrl.protocol === 'https:';
    const isSupportedProtocol = isSecure || parsedUrl.protocol === 'ws:' || parsedUrl.protocol === 'http:';
    if (!isSupportedProtocol || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/')) {
      return res.status(503).json({ error: 'LIVEKIT_URL must be a server origin using ws://, wss://, http://, or https:// without credentials or a path', code: 'LIVEKIT_URL_INVALID' });
    }
    if (process.env.NODE_ENV === 'production' && !isSecure) {
      return res.status(503).json({ error: 'LIVEKIT_URL must use a secure wss:// or https:// URL in production', code: 'LIVEKIT_URL_INSECURE' });
    }
    const authority = parsedUrl.host;
    const clientUrl = `${isSecure ? 'wss:' : 'ws:'}//${authority}`;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    const at = new AccessToken(apiKey, apiSecret, { identity: user.id, name: user.displayName, ttl: '30m' });
    const allowedSources: TrackSource[] = [
      ...(canSpeak ? [TrackSource.MICROPHONE] : []),
      ...(canStream ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [])
    ];
    at.addGrant({ roomJoin: true, room: channel.id, canPublish: allowedSources.length > 0, canPublishSources: allowedSources, canSubscribe: true, canPublishData: true });
    let token: string;
    try { token = await at.toJwt(); }
    catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = [process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, process.env.LIVEKIT_URL]
        .flatMap((value) => value ? [value, value.trim()] : [])
        .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
        .reduce((result, value) => result.split(value).join('[REDACTED]'), message)
        .slice(0, 500);
      const errorId = randomUUID();
      console.error('[LiveKit] token signing failed', { errorId, name: error instanceof Error ? error.constructor.name : 'UnknownError', message: safeMessage });
      return res.status(500).json({ error: 'LiveKit token generation failed', code: 'LIVEKIT_TOKEN_ISSUE_FAILED', errorId });
    }
    return res.json({ token, url: clientUrl, permissions: { canSpeak, canStream } });
  } catch (error) { return next(error); }
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string') return next(new Error('Authentication required'));
  try { const decoded = jwt.verify(token, jwtSecret) as JwtPayload; if (typeof decoded.sub !== 'string' || typeof decoded.exp !== 'number') throw new Error('bad subject'); socket.data.userId = decoded.sub; socket.data.expiresAt = decoded.exp * 1000; next(); }
  catch { next(new Error('Invalid or expired token')); }
});
io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
  expiryTimer.unref();
  socket.on('disconnect', () => clearTimeout(expiryTimer));
  let eventStart = Date.now(), eventCount = 0;
  socket.use((_packet, next) => {
    if (Date.now() - eventStart > 10_000) { eventStart = Date.now(); eventCount = 0; }
    eventCount += 1;
    next(eventCount > 60 ? new Error('Socket event rate limit exceeded') : undefined);
  });
  socket.on('server:join', async (serverId: string, ack?: (result: any) => void) => {
    const ok = await serverPermission(socket.data.userId, String(serverId), 'VIEW_CHANNELS').catch(() => false);
    if (!ok) return ack?.({ error: 'Forbidden' });
    socket.join(`server:${serverId}`); ack?.({ ok: true });
  });
  socket.on('channel:join', async (channelId: string, ack?: (result: any) => void) => {
    const channel = await channelContext(String(channelId)).catch(() => null);
    const ok = channel && await serverPermission(socket.data.userId, channel.serverId, 'VIEW_CHANNELS').catch(() => false);
    if (!ok) return ack?.({ error: 'Forbidden' });
    socket.join(`channel:${channelId}`); ack?.({ ok: true });
  });
  socket.on('channel:leave', (channelId: string) => socket.leave(`channel:${String(channelId)}`));
  socket.on('typing:start', async ({ channelId }: { channelId: string }, ack?: (result: any) => void) => {
    const channel = await channelContext(String(channelId)).catch(() => null);
    if (!channel || !await serverPermission(socket.data.userId, channel.serverId, 'VIEW_CHANNELS').catch(() => false)) return ack?.({ error: 'Forbidden' });
    socket.to(`channel:${channelId}`).emit('typing:update', { channelId, userId: socket.data.userId, isTyping: true }); ack?.({ ok: true });
  });
});

// Serve only known static assets; an unknown API route must never fall through to index.html.
const rootDir = path.resolve(process.cwd());
app.use('/css', express.static(path.join(rootDir, 'css'), { fallthrough: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use('/js', express.static(path.join(rootDir, 'js'), { fallthrough: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use('/vendor', express.static(path.join(rootDir, 'public/vendor'), { fallthrough: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('/favicon.ico', (_req, res, next) => res.sendFile(path.join(rootDir, 'favicon.ico'), (error) => error && next(error)));
app.get('/', (_req, res, next) => res.sendFile(path.join(rootDir, 'index.html'), (error) => error && next(error)));
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/tables/') || req.path.startsWith('/files/')) return res.status(404).json({ error: 'Route not found' });
  return res.status(404).type('text').send('Not found');
});
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', details: error.issues.map((i) => ({ path: i.path, message: i.message })) });
  const status = Number(error?.status) || (error instanceof Prisma.PrismaClientKnownRequestError ? 400 : 500);
  if (status >= 500) console.error('Request failed:', error);
  return res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`[PulseCord] listening on 0.0.0.0:${PORT}`));
