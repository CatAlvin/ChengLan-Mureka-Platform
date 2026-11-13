import { createContext, useContext, useEffect, useState, Fragment, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LockKeyIcon, MusicNotesIcon, ArrowRightIcon, SignOutIcon, UserCircleIcon } from '@phosphor-icons/react';
import { api, clearPrivateCache, readSession, type SessionInfo } from '../lib/api';
import { Button } from './ui/button';
import { Modal } from './modal';
import './auth.css';

const AuthContext = createContext<{ session: SessionInfo; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null);
export const useAuth = () => useContext(AuthContext)!;
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null); const [error, setError] = useState(''); const client = useQueryClient();
  async function refresh() { const next = await readSession(true); setSession(next); }
  useEffect(() => { const update = () => { void readSession(true).then(value => { setSession(value); client.clear(); }).catch(failure => setError(failure.message)); }; update(); window.addEventListener('chenglan-auth-changed', update); return () => window.removeEventListener('chenglan-auth-changed', update); }, [client]);
  async function logout() { await api('/api/auth/logout', { method: 'POST' }); clearPrivateCache(); client.clear(); await refresh(); }
  if (error) return <div className="auth-page"><div className="auth-card"><h1>暂时无法连接工作台</h1><p role="alert">{error}</p><Button className="primary-button" onClick={() => { setError(''); void refresh().catch(e => setError(e.message)); }}>重新连接</Button></div></div>;
  if (!session) return <div className="auth-page"><p role="status">正在打开你的音乐空间…</p></div>;
  return <AuthContext.Provider value={{ session, refresh, logout }}>{!session.user ? <Login /> : session.user.mustChangePassword ? <div className="auth-page"><div className="auth-card"><Brand /><h1>给账户设置新密码</h1><p>这是临时密码。更换后，就可以开始创作了。</p><PasswordForm forced /><Button className="text-button" onClick={() => void logout()}>退出登录</Button></div></div> : <Fragment key={session.user.id}>{children}</Fragment>}</AuthContext.Provider>;
}
function Brand() { return <div className="auth-brand"><span><MusicNotesIcon weight="duotone" size={30} /></span><strong>橙蓝<span>AI 音乐工作台</span></strong></div>; }
function Login() {
  const { refresh } = useAuth(); const location = useLocation(); const navigate = useNavigate(); const admin = location.pathname.startsWith('/admin');
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (location.pathname === '/register') return <Registration />;
  return <main className="auth-page"><div className="auth-story"><div className="auth-disc"><MusicNotesIcon size={88} weight="duotone" /></div><span>让每一个灵感，都有回响</span><h2>你的音乐，<br />从这里开始。</h2><p>写一段故事，留一段旋律。<br />登录后，回到只属于你的创作空间。</p></div><section className="auth-card"><Brand /><h1>{admin ? '管理员登录' : '欢迎回来'}</h1><p>{admin ? '管理账户，了解工作台的使用情况。' : '登录后继续创作，找回你的作品与灵感。'}</p><form onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await api('/api/auth/login', { method: 'POST', body: { username, password } }); setPassword(''); await refresh(); if (!admin) navigate('/', { replace: true }); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}>
    <label>用户名<input autoComplete="username" name="username" required maxLength={32} value={username} onChange={e => setUsername(e.target.value)} autoCapitalize="none" spellCheck={false} /></label>
    <label>密码<input autoComplete="current-password" name="password" type="password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></label>
    {error && <p className="auth-error" role="alert">{error}</p>}<Button className="primary-button" type="submit" disabled={busy}><LockKeyIcon />{busy ? '正在登录…' : '登录'}<ArrowRightIcon /></Button>
  </form><div className="auth-entry-links"><Link to="/register" className="text-button">申请注册</Link><Link to={admin ? '/' : '/admin'} className="text-button">{admin ? '返回用户登录' : '管理员入口'}</Link></div><div className="demo-entry"><strong>先听见灵感，再开始创作</strong><p>无需账号，体验完整的模拟创作流程。</p><Link to="/demo" className="secondary-link">进入演示工作台 <ArrowRightIcon /></Link></div><p className="auth-help">真实创作需注册并等待审批。忘记密码或需要帮助，请联系 <a href="mailto:chenglancat@gmail.com">chenglancat@gmail.com</a>。</p></section></main>;
}
function Registration() {
  const status = useQuery({ queryKey: ['registration'], queryFn: () => api<{ available: boolean; pending: number; limit: number }>('/api/registration'), refetchInterval: 15000 });
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState(false);
  return <main className="auth-page"><section className="auth-card registration-card"><Brand /><h1>{done ? '申请已送达' : '申请你的音乐空间'}</h1>
    {done ? <div role="status" className="notice">管理员审批通过后，使用刚才的用户名与密码登录。请联系管理员说明使用需求。</div> : <><p>填写用户名与密码，审批通过即可创作。每周有价值 ¥10 的 1000 点额度，可选择 V9.5、V9 或 V8。</p>
      <p className="registration-capacity" role="status">{status.data ? `待审批 ${status.data.pending} / ${status.data.limit} 条${status.data.available ? '' : ' · 队列已满，请稍后再来'}` : status.error ? '暂时无法读取申请名额，请稍后重试。' : '正在检查申请名额…'}</p>
      <form onSubmit={async e => { e.preventDefault(); if (busy) return; if (password !== confirm) { setError('两次密码不一致。'); return; } setBusy(true); setError(''); try { await api('/api/auth/register', { method: 'POST', body: { username, password } }); setPassword(''); setConfirm(''); setDone(true); } catch (failure) { setError((failure as Error).message); void status.refetch(); } finally { setBusy(false); } }}>
        <label>用户名<input required autoComplete="username" autoCapitalize="none" spellCheck={false} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}" maxLength={32} placeholder="3–32 位字母、数字或 _ . -" value={username} onChange={e => setUsername(e.target.value)} /></label>
        <label>密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></label>
        <label>确认密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
        <p className="field-help">密码至少 8 个字符。管理员只能重置密码，无法查看你的密码。</p>
        {error && <p role="alert" className="auth-error">{error}</p>}<Button type="submit" className="primary-button" disabled={busy || !status.data?.available}>{busy ? '正在提交…' : status.data?.available ? '提交注册申请' : '暂时无法申请'}</Button>
      </form></>}
    <p className="auth-help">联系管理员：<a href="mailto:chenglancat@gmail.com">chenglancat@gmail.com</a></p><div className="auth-entry-links"><Link to="/" className="text-button">返回登录</Link><Link to="/demo" className="text-button">先体验演示</Link></div>
  </section></main>;
}
export function PasswordForm({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { refresh } = useAuth(); const [currentPassword,setCurrent] = useState(''); const [password,setPassword] = useState(''); const [confirm,setConfirm] = useState(''); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  return <form className="account-form" onSubmit={async e => { e.preventDefault(); if (busy) return; if (password !== confirm) { setError('两次输入的新密码不一致。'); return; } setBusy(true); setError(''); try { await api('/api/auth/password', { method: 'POST', body: { currentPassword,password } }); await refresh(); onDone?.(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}>
    <label>{forced ? '临时密码' : '当前密码'}<input type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={e=>setCurrent(e.target.value)} /></label>
    <label>新密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} /></label>
    <label>再次输入新密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirm} onChange={e=>setConfirm(e.target.value)} /></label><p className="field-help">至少 8 个字符，建议使用较长且不重复的密码。</p>
    {error && <p role="alert" className="auth-error">{error}</p>}<Button className="primary-button" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存新密码'}</Button>
  </form>;
}
export function AccountControls() {
  const {session,logout} = useAuth(); const [open,setOpen] = useState(false); const [error,setError]=useState('');
  return <section className="account-controls"><div><UserCircleIcon size={30} /><div><strong>{session.user!.displayName}</strong><span>@{session.user!.username} · {session.user!.role === 'admin' ? '管理员' : '用户'}</span></div></div><div className="account-actions">{session.user!.role === 'admin' && <Link className="secondary-link" to="/admin">管理后台</Link>}<Button className="secondary-button" onClick={()=>setOpen(true)}>修改我的密码</Button><Button className="secondary-button" onClick={()=>void logout().catch(e=>setError(e.message))}><SignOutIcon />退出登录</Button></div>{error && <p role="alert">{error}</p>}<Modal open={open} onOpenChange={setOpen} title="修改我的密码" description="修改后，其他设备需要重新登录。"><PasswordForm onDone={()=>setOpen(false)} /></Modal></section>;
}
