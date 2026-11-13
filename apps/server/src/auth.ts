import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Store, LEGACY_USER_ID } from './db.js';
import type { Runner } from './runner.js';

export type User = { id: string; username: string; displayName: string; role: 'user' | 'admin'; disabled: boolean; mustChangePassword: boolean; createdAt: number; lastLoginAt: number | null };
type UserRow = { id: string; username: string; display_name: string; password_hash: string; role: 'user' | 'admin'; disabled: number; must_change_password: number; created_at: number; password_changed_at: number; last_login_at: number | null };
type Session = { id_hash: string; user_id: string | null; csrf: string; expires_at: number };
declare module 'fastify' { interface FastifyRequest { user: User | null; userStore: Store; authSession: Session | null } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const passwordSchema = z.string().min(8, '密码至少需要 8 个字符').max(128, '密码最多 128 个字符');
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/, '用户名需为 3–32 位字母、数字、点、下划线或短横线');
export function publicUser(row: UserRow): User { return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, disabled: !!row.disabled, mustChangePassword: !!row.must_change_password, createdAt: row.created_at, lastLoginAt: row.last_login_at }; }
export async function passwordHash(password: string, salt = randomBytes(16).toString('hex')): Promise<string> {
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }, (error, derived) => error ? reject(error) : resolve(derived)));
  return `scrypt$131072$8$1$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$'); if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$131072$8$1') return false;
  const actual = await passwordHash(password, parts[4]); return timingSafeEqual(Buffer.from(actual), Buffer.from(stored));
}
export async function initializeUsers(store: Store, root: string, bootstrap?: { username: string; password: string }) {
  if ((store.sqlite.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n) return;
  let credentials = bootstrap;
  if (!credentials && process.env.ADMIN_BOOTSTRAP_FILE) credentials = JSON.parse(await readFile(process.env.ADMIN_BOOTSTRAP_FILE, 'utf8'));
  credentials ??= { username: 'admin', password: randomBytes(20).toString('base64url') };
  const username = usernameSchema.parse(credentials.username); const password = passwordSchema.parse(credentials.password);
  const encoded = await passwordHash(password); const now = Date.now();
  if (!bootstrap && !process.env.ADMIN_BOOTSTRAP_FILE) {
    const directory = path.join(root, 'deployment-secrets'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'initial-admin.txt'), `橙蓝初始管理员\n用户名：${username}\n临时密码：${password}\n首次登录后请设置自己的密码。此文件不进入 Git。\n`, { mode: 0o600, flag: 'wx' });
  }
  store.sqlite.transaction(() => {
    store.sqlite.prepare('INSERT INTO users (id, username, display_name, password_hash, role, created_at, password_changed_at, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(LEGACY_USER_ID, username, '管理员', encoded, 'admin', now, now, bootstrap || process.env.ADMIN_BOOTSTRAP_FILE ? 0 : 1);
    for (const table of ['generation_jobs', 'tracks', 'materials', 'collections', 'drafts']) store.sqlite.prepare(`UPDATE ${table} SET owner_id = ?`).run(LEGACY_USER_ID);
  })();
}

export function registerAuth(app: FastifyInstance, store: Store, runner: Runner, options: { port: number; publicOrigin?: string; controlToken?: string }) {
  const sql = store.sqlite; const secure = !!options.publicOrigin; const cookieName = secure ? '__Host-chenglan_session' : `chenglan_session_${options.port}`;
  const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, secure, path: '/' };
  const origin = options.publicOrigin ? new URL(options.publicOrigin) : null;
  if (origin && (origin.protocol !== 'https:' || origin.pathname !== '/')) throw new Error('PUBLIC_ORIGIN 必须是 HTTPS 网站根地址');
  const hosts = origin ? [origin.host] : [`127.0.0.1:${options.port}`, `localhost:${options.port}`, 'localhost:5173', '127.0.0.1:5173'];
  const origins = origin ? [origin.origin] : hosts.map(h => `http://${h}`);
  app.decorateRequest('user', null); app.decorateRequest('userStore'); app.decorateRequest('authSession', null);
  function issue(reply: FastifyReply, userId: string | null) {
    const token = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex'); const maxAge = userId ? 86400 : 1200;
    sql.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    sql.prepare('INSERT INTO sessions (id_hash,user_id,csrf,created_at,expires_at) VALUES (?,?,?,?,?)').run(hash(token), userId, csrf, Date.now(), Date.now() + maxAge * 1000);
    reply.setCookie(cookieName, token, { ...cookieOptions, maxAge }); return csrf;
  }
  function revoke(request: FastifyRequest) { if (request.authSession) sql.prepare('DELETE FROM sessions WHERE id_hash = ?').run(request.authSession.id_hash); }
  function audit(actor: string, target: string | null, action: string) { sql.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?)').run(randomUUID(), actor, target, action, Date.now()); }
  function userById(id: string) { return sql.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined; }
  function limited(keys: [string, number][]) {
    const now = Date.now(); sql.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').run(now);
    if (keys.some(([key, max]) => ((sql.prepare('SELECT count FROM login_attempts WHERE key = ?').get(hash(key)) as { count: number } | undefined)?.count || 0) >= max)) return true;
    for (const [key] of keys) sql.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(hash(key), now + 15 * 60000);
    return false;
  }
  let hashing = 0;
  const dummy = `scrypt$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (!hosts.includes(request.headers.host || '')) return reply.code(403).send({ message: '请通过正确的网站地址访问。' });
    if (request.headers.origin && !origins.includes(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ message: '请求来源不受信任。' });
    const url = request.routeOptions.url || request.url.split('?')[0]; if (!/^\/(api|media)\//.test(url)) return;
    reply.header('Cache-Control', 'private, no-store');
    if (url === '/api/shutdown') {
      const supplied = request.headers['x-chenglan-control'];
      if (!secure && options.controlToken && typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(options.controlToken))) return;
      return reply.code(403).send({ message: '服务停止由服务器管理工具执行。' });
    }
    const token = request.cookies[cookieName];
    const session = token && /^[a-f0-9]{64}$/.test(token) ? sql.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?').get(hash(token), Date.now()) as Session | undefined : undefined;
    request.authSession = session || null;
    const user = session?.user_id ? userById(session.user_id) : undefined;
    request.user = user && !user.disabled ? publicUser(user) : null;
    if (request.user) { request.userStore = store.forUser(request.user.id); reply.header('X-Chenglan-User', request.user.id); }
    if (url === '/api/session') return;
    if (!['GET', 'HEAD'].includes(request.method) && (!session || request.headers['x-csrf-token'] !== session.csrf)) return reply.code(403).send({ message: '操作验证已过期，请刷新后重试。' });
    if (['/api/auth/login', '/api/auth/register', '/api/registration'].includes(url)) return;
    if (!request.user) return reply.code(401).send({ message: '请先登录。' });
    if (request.user.mustChangePassword && !['/api/auth/password', '/api/auth/logout'].includes(url)) return reply.code(428).send({ message: '请先更换临时密码。' });
    if (url.startsWith('/api/admin/') && request.user.role !== 'admin') return reply.code(403).send({ message: '此功能仅管理员可用。' });
  });
  app.get('/api/session', async (request, reply) => ({ app: 'chenglan-music', version: '0.7.3', user: request.user, csrfToken: request.authSession?.csrf || issue(reply, null), hosted: secure }));
  function registrationInfo() {
    const pending = (sql.prepare('SELECT count(*) n FROM registrations').get() as {n:number}).n;
    const limit = (sql.prepare("SELECT value FROM app_settings WHERE key='registration_limit'").get() as {value:number}).value;
    return { pending, limit, available: pending < limit, email: 'chenglancat@gmail.com' };
  }
  app.get('/api/registration', async () => registrationInfo());
  app.post('/api/auth/register', async (request, reply) => {
    if (request.user) return reply.code(409).send({ message: '请先退出当前账户再申请注册。' });
    const input = z.object({ username: usernameSchema, password: passwordSchema }).parse(request.body);
    if (limited([[`register:${request.ip}`, 10]]) || hashing >= 2) return reply.code(429).send({ message: '申请过于频繁，请稍后再试。' });
    const duplicate = () => sql.prepare('SELECT id FROM users WHERE username=? UNION ALL SELECT id FROM registrations WHERE username=?').get(input.username, input.username);
    if (!registrationInfo().available) return reply.code(409).send({ message: '待审批队列已满，请稍后再申请。可以先体验演示工作台。' });
    if (duplicate()) return reply.code(409).send({ message: '该用户名已被使用或正在审批，请勿重复申请。' });
    hashing++;
    try {
      const encoded = await passwordHash(input.password);
      const result = sql.transaction(() => {
        if (!registrationInfo().available) return '待审批队列已满，请稍后再申请。';
        if (duplicate()) return '该用户名已被使用或正在审批，请勿重复申请。';
        sql.prepare('INSERT INTO registrations VALUES (?,?,?,?)').run(randomUUID(), input.username, encoded, Date.now());
        return null;
      })();
      if (result) return reply.code(409).send({ message: result });
      return reply.code(202).send({ message: '注册申请已提交。管理员批准后才可登录，请联系 chenglancat@gmail.com。' });
    } finally { hashing--; }
  });
  app.get('/api/admin/registrations', async () => ({ ...registrationInfo(), requests: sql.prepare('SELECT id,username,created_at AS createdAt FROM registrations ORDER BY created_at').all() }));
  app.patch('/api/admin/registrations/settings', async request => {
    const { limit } = z.object({ limit: z.number().int().min(1).max(100) }).parse(request.body);
    sql.transaction(() => { sql.prepare("UPDATE app_settings SET value=? WHERE key='registration_limit'").run(limit); audit(request.user!.id, null, `registration_limit:${limit}`); })();
    return registrationInfo();
  });
  app.post('/api/admin/registrations/:id/:decision', async (request, reply) => {
    const { id, decision } = z.object({ id: z.string().uuid(), decision: z.enum(['approve', 'reject']) }).parse(request.params);
    const result = sql.transaction(() => {
      const pending = sql.prepare('SELECT * FROM registrations WHERE id=?').get(id) as {username:string;password_hash:string} | undefined;
      if (!pending) return false;
      if (decision === 'approve') {
        const now = Date.now();
        sql.prepare("INSERT INTO users (id,username,display_name,password_hash,role,must_change_password,created_at,password_changed_at) VALUES (?,?,?,?,'user',0,?,?)").run(id, pending.username, pending.username, pending.password_hash, now, now);
      }
      sql.prepare('DELETE FROM registrations WHERE id=?').run(id);
      audit(request.user!.id, id, `${decision}_registration`);
      return true;
    })();
    if (!result) return reply.code(409).send({ message: '这条申请已处理，请刷新列表。' });
    return { ok: true };
  });
  app.get('/api/credits', async request => ({ ...runner.credits.balance(request.user!.id), history: runner.credits.history(request.user!.id) }));
  app.get('/api/admin/credits', async () => ({ reviews: runner.credits.pending() }));
  app.post('/api/admin/users/:id/credits', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ requestId: z.string().uuid(), points: z.number().finite().min(-100000).max(100000).multipleOf(0.01), reason: z.string().trim().min(1).max(200) }).parse(request.body);
    const user = userById(id); if (!user) return reply.code(404).send({ message: '用户不存在。' });
    if (user.role === 'admin') return reply.code(400).send({ message: '管理员额度无限，无需调整。' });
    return runner.credits.adjust(id, body.points, body.reason, request.user!.id, body.requestId);
  });
  app.post('/api/admin/credits/:id/settle', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { cents, reason } = z.object({ cents: z.number().int().min(0).max(10000000), reason: z.string().trim().min(1).max(200) }).parse(request.body);
    const charge = runner.credits.charge(id);
    if (!charge || charge.state !== 'review') return reply.code(409).send({ message: '此任务已结算或不需要核账。' });
    sql.transaction(() => { runner.credits.settle(id, cents, `管理员核账：${reason}`, request.user!.id); audit(request.user!.id, charge.user_id, `settle_charge:${id}:${cents}`); })();
    return { ok: true };
  });
  app.post('/api/auth/login', async (request, reply) => {
    const input = z.object({ username: z.string().trim().min(1).max(32).transform(v => v.toLowerCase()), password: z.string().min(1).max(128) }).parse(request.body);
    if (limited([[`ip:${request.ip}`, 40], [`login:${input.username}`, 12]]) || hashing >= 2) return reply.header('Retry-After', '900').code(429).send({ message: '尝试过于频繁，请 15 分钟后再试。' });
    const user = sql.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(input.username) as UserRow | undefined;
    hashing++; let valid: boolean; try { valid = await verifyPassword(input.password, user?.password_hash || dummy); } finally { hashing--; }
    if (!valid || !user || user.disabled) return reply.code(401).send({ message: '用户名或密码不正确，或账户已停用。' });
    // Recheck after hashing because an administrator may have reset this user meanwhile.
    const fresh = userById(user.id)!; if (fresh.disabled || fresh.password_hash !== user.password_hash) return reply.code(401).send({ message: '账户已更新，请重新登录。' });
    revoke(request); sql.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    return { user: publicUser(fresh), csrfToken: issue(reply, user.id) };
  });
  app.post('/api/auth/logout', async (request, reply) => { revoke(request); reply.clearCookie(cookieName, cookieOptions); return { ok: true }; });
  app.post('/api/auth/password', async (request, reply) => {
    const input = z.object({ currentPassword: z.string().max(128), password: passwordSchema }).parse(request.body);
    if (limited([[`password:${request.user!.id}`, 12]]) || hashing >= 2) return reply.code(429).send({ message: '尝试过于频繁，请稍后再试。' });
    const user = userById(request.user!.id)!; hashing++;
    try {
      if (!await verifyPassword(input.currentPassword, user.password_hash)) return reply.code(400).send({ message: '当前密码不正确。' });
      if (input.currentPassword === input.password) return reply.code(400).send({ message: '请设置与临时密码不同的新密码。' });
      const encoded = await passwordHash(input.password);
      if (userById(user.id)?.password_hash !== user.password_hash) return reply.code(409).send({ message: '密码已发生变更，请重新登录。' });
      sql.transaction(() => { sql.prepare('UPDATE users SET password_hash=?,must_change_password=0,password_changed_at=? WHERE id=?').run(encoded, Date.now(), user.id); sql.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); audit(user.id, user.id, 'change_password'); })();
      return { user: publicUser(userById(user.id)!), csrfToken: issue(reply, user.id) };
    } finally { hashing--; }
  });
  app.get('/api/admin/users', async () => (sql.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as UserRow[]).map(user => ({ ...publicUser(user), credits: runner.credits.balance(user.id) })));
  app.post('/api/admin/users', async (request, reply) => {
    const input = z.object({ username: usernameSchema, displayName: z.string().trim().min(1).max(40), password: passwordSchema, role: z.enum(['user', 'admin']).default('user') }).parse(request.body);
    if (hashing >= 2) return reply.code(429).send({ message: '正在处理密码，请稍后再试。' });
    hashing++; try {
      const encoded = await passwordHash(input.password); const id = randomUUID(); const now = Date.now();
      if (sql.prepare('SELECT id FROM users WHERE username=? UNION ALL SELECT id FROM registrations WHERE username=?').get(input.username,input.username)) return reply.code(409).send({ message: '这个用户名已存在或正在审批。' });
      sql.transaction(() => { sql.prepare('INSERT INTO users (id,username,display_name,password_hash,role,created_at,password_changed_at) VALUES (?,?,?,?,?,?,?)').run(id,input.username,input.displayName,encoded,input.role,now,now); audit(request.user!.id,id,'create_user'); })();
      return reply.code(201).send(publicUser(userById(id)!));
    } finally { hashing--; }
  });
  app.patch('/api/admin/users/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const input = z.object({ displayName: z.string().trim().min(1).max(40).optional(), role: z.enum(['user','admin']).optional(), disabled: z.boolean().optional() }).parse(request.body);
    const user = userById(id); if (!user) return reply.code(404).send({ message: '用户不存在。' });
    if (id === request.user!.id && (input.disabled || input.role === 'user')) return reply.code(400).send({ message: '不能停用自己的管理员账户或移除自己的管理员角色。' });
    if (user.role === 'admin' && !user.disabled && (input.disabled || input.role === 'user') && (sql.prepare("SELECT count(*) n FROM users WHERE role='admin' AND disabled=0").get() as {n:number}).n <= 1) return reply.code(400).send({ message: '至少需要保留一名可用管理员。' });
    sql.transaction(() => {
      sql.prepare('UPDATE users SET display_name=?,role=?,disabled=? WHERE id=?').run(input.displayName ?? user.display_name,input.role ?? user.role,input.disabled === undefined ? user.disabled : Number(input.disabled),id);
      if (input.disabled !== undefined || input.role) sql.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      if (input.disabled) {
        for (const job of store.forUser(id).listJobs().filter(j => j.status === 'local_queued')) runner.credits.release(job.id);
        sql.prepare("UPDATE generation_jobs SET status='cancelled',error='账户已停用，尚未提交的任务已取消。' WHERE owner_id=? AND status='local_queued'").run(id);
      }
      audit(request.user!.id,id,'update_user');
    })(); return publicUser(userById(id)!);
  });
  app.post('/api/admin/users/:id/password', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const { password } = z.object({ password: passwordSchema }).parse(request.body);
    if (!userById(id)) return reply.code(404).send({ message: '用户不存在。' });
    if (id === request.user!.id) return reply.code(400).send({ message: '请通过“修改我的密码”更换自己的密码。' });
    if (hashing >= 2) return reply.code(429).send({ message: '正在处理密码，请稍后再试。' });
    hashing++; try { const encoded = await passwordHash(password);
      sql.transaction(() => { sql.prepare('UPDATE users SET password_hash=?,must_change_password=1,password_changed_at=? WHERE id=?').run(encoded,Date.now(),id); sql.prepare('DELETE FROM sessions WHERE user_id=?').run(id); audit(request.user!.id,id,'reset_password'); })();
      return { ok: true };
    } finally { hashing--; }
  });
  app.get('/api/admin/usage', async () => {
    const users = (sql.prepare('SELECT * FROM users').all() as UserRow[]).map(user => {
      const scoped = store.forUser(user.id); const jobs = scoped.listJobs().filter(job => !['import', 'crop'].includes(job.kind)); const tracks = scoped.listTracks();
      return { userId: user.id, username: user.username, displayName: user.display_name, jobs: jobs.length, succeeded: jobs.filter(j => j.status === 'succeeded').length, failed: jobs.filter(j => ['failed','timeouted','save_failed'].includes(j.status)).length, pending: jobs.filter(j => !['succeeded','failed','timeouted','save_failed','cancelled'].includes(j.status)).length, tracks: tracks.length, audioSeconds: Math.round(tracks.reduce((n,t) => n+t.duration,0)/1000), materials: scoped.listMaterials().length, requestedSongs: jobs.filter(j=>['song','instrumental','extend','region_edit','remix','track'].includes(j.kind)).reduce((n,j)=>n+j.input.count,0) };
    });
    const activity = sql.prepare('SELECT action,created_at AS createdAt FROM admin_audit ORDER BY created_at DESC LIMIT 20').all();
    return { users, account: runner.account, storageBytes: await runner.storageBytes(), activity, note: '用量按本平台记录统计；账户余额与累计消费来自 Mureka。个人点数另记账，可在额度明细中查看。' };
  });
  app.post('/api/admin/account/refresh', async () => runner.refreshAccount(true));
}
