const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { Prisma } = require('@prisma/client');
const { AccessToken, TrackSource } = require('livekit-server-sdk');

function createApiHarness(fetchImpl) {
  const values = new Map();
  const events = [];
  const window = { dispatchEvent: (event) => events.push(event) };
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  const context = {
    window,
    localStorage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) },
    fetch: fetchImpl,
    Headers,
    URLSearchParams,
    CustomEvent,
    Date,
    console,
    Set,
    Error,
    JSON,
    encodeURIComponent
  };
  const source = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'js/api.js' });
  return { api: window.pulseAPI, values, events };
}

test('request attaches the bearer token and parses JSON', async () => {
  let observed;
  const { api, values } = createApiHarness(async (_url, options) => {
    observed = options;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  values.set('pulsecord_access_token', 'test-token');
  const result = await api.request('/auth/me');
  assert.equal(result.ok, true);
  assert.equal(observed.headers.get('Authorization'), 'Bearer test-token');
});

test('401 clears the saved access token, dispatches expiration, and rejects', async () => {
  const { api, values, events } = createApiHarness(async () => new Response(JSON.stringify({ error: 'Invalid or expired access token' }), { status: 401 }));
  values.set('pulsecord_access_token', 'expired');
  await assert.rejects(api.request('/tables/messages'), /Invalid or expired access token/);
  assert.equal(values.has('pulsecord_access_token'), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'pulsecord:auth-expired');
});

test('API errors preserve safe LiveKit reference and missing variable names without exposing values', async () => {
  const { api } = createApiHarness(async () => new Response(JSON.stringify({
    error: 'LiveKit service is not configured',
    code: 'LIVEKIT_CONFIG_MISSING',
    errorId: 'e7fbd222-0c9c-41dc-a526-cc217c67281e',
    missingVariables: ['LIVEKIT_API_SECRET', 'OTHER_SECRET'],
    secret: 'must-not-be-copied-into-the-error'
  }), { status: 503, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(api.request('/api/voice/token'), (error) => {
    assert.equal(error.code, 'LIVEKIT_CONFIG_MISSING');
    assert.equal(error.errorId, 'e7fbd222-0c9c-41dc-a526-cc217c67281e');
    assert.deepEqual(error.missingVariables, ['LIVEKIT_API_SECRET']);
    assert.equal(error.secret, undefined);
    return true;
  });
});

test('list encodes resource path and includes paging parameters', async () => {
  let url;
  const { api } = createApiHarness(async (requestUrl) => {
    url = requestUrl;
    return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const rows = await api.list('voice sessions', { page: 2, limit: 25, search: 'hello world' });
  assert.equal(rows.length, 1);
  assert.match(url, /^\/tables\/voice%20sessions\?/);
  assert.match(url, /page=2/);
  assert.match(url, /limit=25/);
  assert.match(url, /search=hello\+world/);
});

test('create, patch, and delete persist through the HTTP method and emit mutation events', async () => {
  const requests = [];
  const { api } = createApiHarness(async (url, options) => {
    requests.push({ url, method: options.method || 'GET', body: options.body });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const result = options.method === 'PATCH' ? { id: 'm1', content: 'updated' } : { id: 'm1', content: 'hello' };
    return new Response(JSON.stringify(result), { status: options.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  });
  const events = [];
  api.onEvent((event) => events.push(event));
  await api.create('messages', { id: 'm1', content: 'hello' });
  await api.patch('messages', 'm1', { content: 'updated' });
  await api.remove('messages', 'm1');
  assert.deepEqual(requests.map((r) => r.method), ['POST', 'PATCH', 'DELETE']);
  assert.equal(JSON.parse(requests[0].body).content, 'hello');
  assert.deepEqual(events.map((event) => event.payload.action), ['create', 'patch', 'delete']);
});

test('UI uses delegated CSP-safe actions that resolve to implemented class methods', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const firstPartyJs = ['../js/app.js', '../js/api.js', '../js/webrtc.js', '../js/livekit-browser-entry.js']
    .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'));
  const inlineHandler = /\bon(click|input|change|keydown|submit|keyup|blur|focus)\s*=/i;
  assert.equal(inlineHandler.test(indexSource), false, 'index.html must not contain inline event handlers');
  for (const [index, source] of firstPartyJs.entries()) assert.equal(inlineHandler.test(source), false, `first-party JS source ${index} must not contain inline event attributes`);
  const methods = new Set([...appSource.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((match) => match[1]));
  const whitelistBlock = appSource.match(/const DELEGATED_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(whitelistBlock, 'delegated UI actions must have an explicit allowlist');
  const allowed = new Set([...whitelistBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
  const actions = new Set([indexSource, appSource].flatMap((source) => [...source.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1])));
  const special = new Set(['closeModalAndStartDm', 'toggleSelectedMemberRole', 'toggleEmojiPicker']);
  const missingAllowed = [...actions].filter((name) => !allowed.has(name));
  const missingMethods = [...actions].filter((name) => !special.has(name) && !methods.has(name));
  assert.deepEqual(missingAllowed, []);
  assert.deepEqual(missingMethods, []);
  const buttonTags = [indexSource, appSource].flatMap((source) => [...source.matchAll(/<button\b[^>]*>/gi)].map((match) => match[0]));
  const unboundButtons = buttonTags.filter((tag) => !/\bdata-action=/.test(tag) && !/\btype="submit"/.test(tag));
  assert.deepEqual(unboundButtons, [], 'every non-submit button template must have a delegated action');
  const keyActions = new Set([...appSource.matchAll(/data-key-action="([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...keyActions].sort(), ['edit-message', 'send-message', 'thread-reply']);
  for (const eventName of ['click', 'input', 'change', 'keydown']) assert.ok(appSource.includes(`document.addEventListener('${eventName}'`), `${eventName} delegation must be registered`);
  assert.ok(appSource.includes('data-stop-click="true"'), 'nested interactive rows must suppress parent actions where needed');
});

test('Tailwind is compiled locally and JavaScript CSP does not permit inline/eval scripts', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const backend = fs.readFileSync(path.join(__dirname, '../server/index.ts'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  assert.match(indexSource, /css\/tailwind\.generated\.css/);
  assert.match(indexSource, /rel="icon" href="\/favicon\.ico"/);
  assert.equal(fs.existsSync(path.join(__dirname, '../favicon.ico')), true);
  assert.match(dockerfile, /COPY --from=builder \/app\/favicon\.ico \.\/favicon\.ico/);
  assert.match(backend, /app\.get\('\/favicon\.ico'/);
  assert.doesNotMatch(indexSource, /cdn\.tailwindcss\.com/);
  assert.match(packageJson.scripts.build, /tailwindcss .*--minify/);
  assert.equal(packageJson.devDependencies.tailwindcss !== undefined, true);
  const csp = backend.match(/scriptSrc:\s*\[([^\]]+)\]/)?.[1] || '';
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|cdn\.tailwindcss\.com/);
  assert.ok(backend.includes("scriptSrc: [\"'self'\"]"));
});

test('source does not embed first-party SVG path data', () => {
  const files = ['../index.html', '../js/app.js', '../js/webrtc.js', '../css/style.css'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(source, /<svg\b|<path\b|createElementNS\s*\(/i, `${file} should not contain first-party SVG path markup`);
  }
});

test('backend orderBy fields exist on every Prisma model, including joinedAt exceptions', () => {
  const backend = fs.readFileSync(path.join(__dirname, '../server/index.ts'), 'utf8');
  const mappingBlock = backend.match(/const tableOrderFields:[^{]+\{([\s\S]*?)\n\};/);
  assert.ok(mappingBlock, 'tableOrderFields mapping must exist');
  const tableToModel = {
    users: 'User', servers: 'Server', roles: 'Role', server_members: 'ServerMember', channels: 'Channel',
    messages: 'Message', direct_messages: 'DirectMessage', friends: 'Friend', voice_sessions: 'VoiceSession',
    audit_logs: 'AuditLog', notifications: 'Notification'
  };
  const mapping = Object.fromEntries([...mappingBlock[1].matchAll(/([a-z_]+): '(createdAt|joinedAt)'/g)].map((m) => [m[1], m[2]]));
  const models = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, new Set(model.fields.map((field) => field.name))]));
  assert.deepEqual(Object.keys(mapping).sort(), Object.keys(tableToModel).sort());
  for (const [table, modelName] of Object.entries(tableToModel)) assert.ok(models.get(modelName)?.has(mapping[table]), `${table} must order by a field on ${modelName}`);
  assert.equal(mapping.server_members, 'joinedAt');
  assert.equal(mapping.voice_sessions, 'joinedAt');
  assert.equal(mapping.messages, 'createdAt');
});

test('LiveKit token uses SDK TrackSource enums and grants room join, audio, camera, and screen share', async () => {
  const backend = fs.readFileSync(path.join(__dirname, '../server/index.ts'), 'utf8');
  assert.match(backend, /import \{ AccessToken, RoomServiceClient, TrackSource \} from 'livekit-server-sdk'/);
  assert.match(backend, /const allowedSources: TrackSource\[\]/);
  assert.match(backend, /TrackSource\.MICROPHONE/);
  assert.match(backend, /TrackSource\.CAMERA/);
  assert.match(backend, /TrackSource\.SCREEN_SHARE/);
  assert.match(backend, /TrackSource\.SCREEN_SHARE_AUDIO/);
  assert.match(backend, /canPublishSources: allowedSources, canSubscribe: true/);
  assert.doesNotMatch(backend, /canPublishSources: allowedSources as any/);
  assert.match(backend, /url: clientUrl/);
  assert.match(backend, /new URL\(rawUrl!\)/);
  assert.match(backend, /clientUrl = `\$\{isSecure \? 'wss:' : 'ws:'\}\/\/\$\{authority\}`/);
  assert.match(backend, /LIVEKIT_URL must use a secure wss:\/\/ or https:\/\/ URL in production/);
  assert.match(backend, /message: safeMessage/);
  assert.doesNotMatch(backend, /console\.error\([^\n]*(apiSecret|LIVEKIT_API_SECRET)/);
  assert.match(backend, /LIVEKIT_TOKEN_ISSUE_FAILED/);
  for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) assert.ok(backend.includes(`process.env.${name}`), `${name} must be read server-side`);

  const tokenBuilder = new AccessToken('qa-api-key', 'qa-api-secret-not-a-real-credential', { identity: 'qa-user', name: 'QA', ttl: '30m' });
  tokenBuilder.addGrant({
    roomJoin: true,
    room: 'qa-voice-room',
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    canSubscribe: true,
    canPublishData: true
  });
  const claims = JSON.parse(Buffer.from((await tokenBuilder.toJwt()).split('.')[1], 'base64url').toString());
  assert.equal(claims.sub, 'qa-user');
  assert.deepEqual(claims.video, {
    roomJoin: true,
    room: 'qa-voice-room',
    canPublish: true,
    canPublishSources: ['microphone', 'camera', 'screen_share', 'screen_share_audio'],
    canSubscribe: true,
    canPublishData: true
  });
});
